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
        status                     TEXT DEFAULT 'pending',
        created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

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
    `);

    console.log('✅ DB PostgreSQL multi-tenant configurada');
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { setupDatabase };
