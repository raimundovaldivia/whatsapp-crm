const { Pool } = require('pg');

async function setupDatabase() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const client = await pool.connect();
  try {
    await client.query(`
      -- ─── MULTI-TENANT ───────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS organizations (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT UNIQUE NOT NULL,
        plan        TEXT DEFAULT 'free' CHECK(plan IN ('free','pro','enterprise')),
        setup_done  INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        email           TEXT UNIQUE NOT NULL,
        password_hash   TEXT NOT NULL,
        name            TEXT,
        role            TEXT DEFAULT 'agent' CHECK(role IN ('owner','admin','agent')),
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- ─── DATA SOURCES (Shopify, etc.) ───────────────────────────

      CREATE TABLE IF NOT EXISTS data_sources (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('shopify','woocommerce','custom_api','csv')),
        name            TEXT NOT NULL,
        config          TEXT NOT NULL,
        status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','connected','error')),
        last_sync_at    TIMESTAMP,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- ─── AGENTES CONFIGURABLES ──────────────────────────────────

      CREATE TABLE IF NOT EXISTS agents (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        data_source_id  INTEGER,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('orchestrator','sales','orders','support','custom')),
        system_prompt   TEXT,
        config          TEXT,
        active          INTEGER DEFAULT 1,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (data_source_id)  REFERENCES data_sources(id)
      );

      -- ─── WHATSAPP CONFIG POR ORG ─────────────────────────────────

      CREATE TABLE IF NOT EXISTS whatsapp_configs (
        id                         SERIAL PRIMARY KEY,
        organization_id            INTEGER UNIQUE NOT NULL,
        provider                   TEXT DEFAULT 'meta',
        phone_number_id            TEXT,
        business_account_id        TEXT,
        access_token               TEXT,
        webhook_verify_token       TEXT,
        twilio_account_sid         TEXT,
        twilio_auth_token          TEXT,
        twilio_phone_number        TEXT,
        kapso_api_key              TEXT,
        webhook_secret             TEXT,
        status                     TEXT DEFAULT 'pending',
        created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- Migración: agregar columnas Kapso si no existen (idempotente)
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS kapso_api_key      TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS webhook_secret     TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS kapso_customer_id  TEXT;

      -- ─── CONVERSACIONES ─────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS conversations (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        phone_number    TEXT NOT NULL,
        contact_name    TEXT DEFAULT 'Cliente',
        last_message    TEXT,
        last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        unread_count    INTEGER DEFAULT 0,
        agent_mode      TEXT DEFAULT 'ai' CHECK(agent_mode IN ('ai','human')),
        pipeline_state  TEXT DEFAULT 'exploring' CHECK(pipeline_state IN
                        ('exploring','interested','collecting_order','awaiting_payment','done')),
        order_draft     TEXT DEFAULT '{}',
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, phone_number),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- ─── MENSAJES ────────────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS messages (
        id                  SERIAL PRIMARY KEY,
        conversation_id     INTEGER NOT NULL,
        whatsapp_message_id TEXT UNIQUE,
        direction           TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
        content             TEXT NOT NULL,
        type                TEXT DEFAULT 'text',
        status              TEXT DEFAULT 'sent' CHECK(status IN ('sent','delivered','read','failed')),
        sent_by             TEXT DEFAULT 'ai' CHECK(sent_by IN ('ai','human','client','system')),
        agent_type          TEXT,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      -- ─── ÓRDENES CREADAS ─────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS orders (
        id                  SERIAL PRIMARY KEY,
        conversation_id     INTEGER NOT NULL,
        organization_id     INTEGER NOT NULL,
        shopify_draft_id    TEXT,
        shopify_order_id    TEXT,
        status              TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','cancelled')),
        items               TEXT NOT NULL,
        customer_name       TEXT,
        customer_phone      TEXT,
        shipping_address    TEXT,
        total_price         TEXT,
        invoice_url         TEXT,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- ─── CACHE PRODUCTOS POR ORG ─────────────────────────────────

      CREATE TABLE IF NOT EXISTS products_cache (
        id                  SERIAL PRIMARY KEY,
        organization_id     INTEGER NOT NULL,
        data_source_id      INTEGER NOT NULL,
        external_id         TEXT NOT NULL,
        title               TEXT NOT NULL,
        description         TEXT,
        price               TEXT,
        compare_at_price    TEXT,
        sku                 TEXT,
        inventory_quantity  INTEGER,
        image_url           TEXT,
        tags                TEXT,
        product_type        TEXT,
        handle              TEXT,
        raw_json            TEXT,
        cached_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, data_source_id, external_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (data_source_id)  REFERENCES data_sources(id) ON DELETE CASCADE
      );

      -- ─── SETTINGS ────────────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS settings (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT,
        UNIQUE(organization_id, key),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- ─── ÍNDICES ─────────────────────────────────────────────────

      CREATE INDEX IF NOT EXISTS idx_conversations_org    ON conversations(organization_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conv        ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created     ON messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_upd    ON conversations(last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_products_org         ON products_cache(organization_id);
      CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);

      -- ─── FEEDBACK DE ESCALACIÓN (reentrenamiento continuo) ──────
      CREATE TABLE IF NOT EXISTS escalation_feedback (
        id               SERIAL PRIMARY KEY,
        organization_id  INTEGER NOT NULL,
        conversation_id  INTEGER NOT NULL,
        message_content  TEXT NOT NULL,
        escalation_reason TEXT,
        feedback         TEXT NOT NULL CHECK(feedback IN ('correct','unnecessary')),
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      -- Migración: agregar campos de escalación a conversations
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_escalation_trigger TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_escalation_reason TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_escalation_at TIMESTAMP;

      -- ─── RE-ENGANCHE: calibración, caché y predicciones ──────────

      -- Calibración por organización (backtesting histórico)
      CREATE TABLE IF NOT EXISTS org_reengagement_calibration (
        id                     SERIAL PRIMARY KEY,
        organization_id        INTEGER UNIQUE NOT NULL,
        calibration_factor     DECIMAL(5,3) DEFAULT 1.0,
        bucket_factors         JSONB,
        accuracy_rate          DECIMAL(5,3),
        mean_error_days        DECIMAL(8,2),
        total_predictions      INTEGER DEFAULT 0,
        customers_analyzed     INTEGER DEFAULT 0,
        bucket_stats           JSONB,
        top_customers          JSONB,
        insight                TEXT,
        calibrated_at          TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- Caché diario del análisis completo de re-enganche
      CREATE TABLE IF NOT EXISTS reengagement_daily_cache (
        id               SERIAL PRIMARY KEY,
        organization_id  INTEGER NOT NULL,
        cache_date       DATE NOT NULL,
        candidates       JSONB NOT NULL,
        total_candidates INTEGER DEFAULT 0,
        created_at       TIMESTAMP DEFAULT NOW(),
        UNIQUE(organization_id, cache_date),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- Predicciones individuales para tracking de outcomes
      CREATE TABLE IF NOT EXISTS reengagement_predictions (
        id                   SERIAL PRIMARY KEY,
        organization_id      INTEGER NOT NULL,
        customer_phone       VARCHAR(30) NOT NULL,
        customer_name        VARCHAR(200),
        prediction_date      DATE NOT NULL,
        confidence_raw       DECIMAL(5,2),
        confidence_calibrated DECIMAL(5,2),
        predicted_days       INTEGER,
        predicted_buy_date   DATE,
        message_sent         BOOLEAN DEFAULT FALSE,
        message_sent_at      TIMESTAMP,
        template_name        VARCHAR(100),
        -- Outcome (se llena al día siguiente)
        outcome_checked      BOOLEAN DEFAULT FALSE,
        outcome_date         DATE,
        actually_bought      BOOLEAN,
        days_to_actual_buy   INTEGER,
        miss_flag            BOOLEAN DEFAULT FALSE,
        created_at           TIMESTAMP DEFAULT NOW(),
        UNIQUE(organization_id, customer_phone, prediction_date),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_reeng_cache_org_date ON reengagement_daily_cache(organization_id, cache_date);
      CREATE INDEX IF NOT EXISTS idx_reeng_pred_org_date  ON reengagement_predictions(organization_id, prediction_date);
      CREATE INDEX IF NOT EXISTS idx_reeng_pred_outcome   ON reengagement_predictions(outcome_checked, prediction_date);
    `);

    console.log('✅ DB PostgreSQL multi-tenant configurada');
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { setupDatabase };
