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

      -- Migración: ventana 24h y follow-up automático
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_up_sent_at TIMESTAMP;

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

      -- ─── CONTACTOS (perfil unificado por teléfono) ──────────────
      -- Se actualiza automáticamente al confirmar cada pedido.
      -- El bot consulta aquí antes de preguntar datos al cliente.
      CREATE TABLE IF NOT EXISTS contacts (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        phone           VARCHAR(30) NOT NULL,
        name            TEXT,
        email           TEXT,
        address         TEXT,
        city            TEXT,
        region          TEXT,
        notes           TEXT,           -- info extra que el bot haya captado
        shopify_id      TEXT,           -- customer ID en Shopify (si existe)
        total_orders    INTEGER DEFAULT 0,
        last_order_at   TIMESTAMP,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(organization_id, phone),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_org_phone ON contacts(organization_id, phone);

      -- Migración: tipo de contacto y última actividad
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT DEFAULT 'lead'
        CHECK(contact_type IN ('lead','customer'));
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMP;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source        TEXT DEFAULT 'whatsapp';
      CREATE INDEX IF NOT EXISTS idx_contacts_org_type ON contacts(organization_id, contact_type);

      -- Migración: opt-out (no quiere recibir mensajes)
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opt_out BOOLEAN DEFAULT FALSE;

      -- Migración: dirección editable en shopify_orders
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS shipping_address1 TEXT;

      -- ─── PEDIDOS AGENDADOS ─────────────────────────────────────────
      -- Clientes que quieren pedir para una fecha futura.
      -- El cron job de follow-up les envía un template de WhatsApp cuando llega el día.
      CREATE TABLE IF NOT EXISTS scheduled_orders (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        phone           TEXT NOT NULL,
        customer_name   TEXT,
        product_notes   TEXT,           -- qué quiere pedir (extraído por LLM)
        desired_date    DATE NOT NULL,  -- cuándo lo quiere
        template_name   TEXT,           -- template a usar para el follow-up
        status          TEXT DEFAULT 'pending'
          CHECK(status IN ('pending','sent','cancelled')),
        created_at      TIMESTAMP DEFAULT NOW(),
        sent_at         TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sched_orders_org_date
        ON scheduled_orders(organization_id, desired_date, status);

      -- ─── PRODUCTOS PROPIOS (independiente de Shopify) ─────────────
      -- Catálogo gestionado desde el CRM, usado por la tienda pública.
      CREATE TABLE IF NOT EXISTS products (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        price           DECIMAL(10,2) NOT NULL,
        compare_price   DECIMAL(10,2),
        sku             TEXT,
        stock           INTEGER DEFAULT -1,   -- -1 = sin límite
        image_url       TEXT,
        active          BOOLEAN DEFAULT TRUE,
        position        INTEGER DEFAULT 0,    -- orden en la tienda
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_products_org_active ON products(organization_id, active, position);

      -- Migración: agregar campo category a products
      ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;
      CREATE INDEX IF NOT EXISTS idx_products_org_category ON products(organization_id, category);

      -- Migración: descuento por volumen
      ALTER TABLE products ADD COLUMN IF NOT EXISTS bulk_price    DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN IF NOT EXISTS bulk_min_qty  INTEGER;

      -- Migración: ampliar estados de pedidos (incluye estados logísticos COD)
      DO $$
      BEGIN
        ALTER TABLE orders DROP CONSTRAINT orders_status_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
      ALTER TABLE orders ADD CONSTRAINT orders_status_check
        CHECK(status IN ('draft','sent','payment_received','nuevo','por_despachar','en_camino','entregado','paid','cancelled'))
        NOT VALID;

      -- Migración: estado CRM local para órdenes Shopify
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS crm_status TEXT DEFAULT 'nuevo';

      -- ─── COMPROBANTES DE PAGO ────────────────────────────────────────
      -- Se crea automáticamente cuando el cliente envía una foto de transferencia.
      -- El admin verifica desde el panel y marca como verificado/rechazado.
      CREATE TABLE IF NOT EXISTS payment_proofs (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        conversation_id INTEGER NOT NULL,
        order_id        INTEGER,
        media_id        TEXT NOT NULL,
        customer_phone  VARCHAR(30),
        customer_name   TEXT,
        order_summary   TEXT,
        status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected')),
        notes           TEXT,
        created_at      TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payment_proofs_org    ON payment_proofs(organization_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_payment_proofs_status ON payment_proofs(organization_id, status);

      -- Migración: columnas de análisis IA en comprobantes
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS extracted_amount    DECIMAL(12,2);
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS extracted_date      TEXT;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS extracted_bank      TEXT;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS extracted_reference TEXT;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS ai_confidence       TEXT;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS amount_matches      BOOLEAN;

      -- Migración: status pre_verified para comprobantes auto-validados
      DO $$
      BEGIN
        ALTER TABLE payment_proofs DROP CONSTRAINT payment_proofs_status_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
      ALTER TABLE payment_proofs ADD CONSTRAINT payment_proofs_status_check
        CHECK(status IN ('pending','pre_verified','verified','rejected'))
        NOT VALID;

      -- ─── CACHÉ DE ÓRDENES DE SHOPIFY ────────────────────────────────
      CREATE TABLE IF NOT EXISTS shopify_orders (
        id                  SERIAL PRIMARY KEY,
        organization_id     INTEGER NOT NULL,
        shopify_order_id    TEXT NOT NULL,
        shopify_name        TEXT,
        financial_status    TEXT,
        fulfillment_status  TEXT,
        total_price         DECIMAL(12,2),
        customer_name       TEXT,
        customer_email      TEXT,
        customer_phone      TEXT,
        shipping_city       TEXT,
        items               JSONB DEFAULT '[]',
        raw_json            JSONB,
        shopify_created_at  TIMESTAMP,
        synced_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, shopify_order_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_shopify_orders_org_date
        ON shopify_orders(organization_id, shopify_created_at DESC);

      -- ─── REPARTOS (rutas de entrega asignadas al repartidor) ─────

      CREATE TABLE IF NOT EXISTS delivery_routes (
        id                SERIAL PRIMARY KEY,
        organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft','sent','in_progress','completed','cancelled')),
        driver_name       TEXT,
        driver_phone      TEXT,
        orders            JSONB DEFAULT '[]',
        optimized_route   JSONB,
        stop_statuses     JSONB DEFAULT '{}',
        total_distance    TEXT,
        total_duration    TEXT,
        maps_url          TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        sent_at           TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_routes_org_status
        ON delivery_routes(organization_id, status, created_at DESC);

      -- Migración: bandera para excluir manualmente de Hot Leads
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS hot_lead_excluded BOOLEAN DEFAULT FALSE;

      -- Migración: tipo de cliente en contactos (personal / empresa)
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS client_type TEXT DEFAULT 'personal';

      -- Migración: productos solo para empresas
      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_business BOOLEAN DEFAULT FALSE;
      ALTER TABLE products_cache ADD COLUMN IF NOT EXISTS is_business BOOLEAN DEFAULT FALSE;

      -- Migración: normalizar contacts.phone (quitar '+', agregar '56' a móviles chilenos)
      -- Eliminar primero los que quedarían duplicados tras normalizar

      -- Caso A: existe '9XXXXXXXX' Y ya existe '569XXXXXXXX' → borrar el corto
      DELETE FROM contacts WHERE phone ~ '^9[0-9]{8}$'
        AND EXISTS (
          SELECT 1 FROM contacts c2
          WHERE c2.organization_id = contacts.organization_id
            AND c2.phone = '56' || contacts.phone
        );

      -- Caso B: existe '9XXXXXXXX' Y ya existe '+569XXXXXXXX' → borrar el corto
      DELETE FROM contacts WHERE phone ~ '^9[0-9]{8}$'
        AND EXISTS (
          SELECT 1 FROM contacts c2
          WHERE c2.organization_id = contacts.organization_id
            AND c2.phone = '+56' || contacts.phone
        );

      -- Ahora es seguro agregar '56' a los que quedan con 9 dígitos
      UPDATE contacts SET phone = '56' || phone WHERE phone ~ '^9[0-9]{8}$';

      -- Caso C: existe '+56XXXXXXXX' Y ya existe '56XXXXXXXX' → borrar el que tiene '+'
      DELETE FROM contacts WHERE phone LIKE '+%'
        AND EXISTS (
          SELECT 1 FROM contacts c2
          WHERE c2.organization_id = contacts.organization_id
            AND c2.phone = SUBSTRING(contacts.phone FROM 2)
        );

      -- Quitar '+' de los que quedan con ese prefijo
      UPDATE contacts SET phone = SUBSTRING(phone FROM 2) WHERE phone LIKE '+%';

      -- Backfill: crear contacts faltantes desde shopify_orders (phone ya normalizado)
      -- Para cada cliente en shopify_orders que tenga phone, asegurar que exista en contacts.
      INSERT INTO contacts (organization_id, phone, name, email, city, contact_type, created_at, updated_at)
      SELECT DISTINCT ON (so.organization_id, normalized_phone)
        so.organization_id,
        CASE
          WHEN so.customer_phone LIKE '+%' THEN SUBSTRING(so.customer_phone FROM 2)
          WHEN so.customer_phone ~ '^9[0-9]{8}$' THEN '56' || so.customer_phone
          ELSE so.customer_phone
        END AS normalized_phone,
        so.customer_name,
        so.customer_email,
        so.shipping_city,
        'customer',
        NOW(), NOW()
      FROM shopify_orders so
      WHERE so.customer_phone IS NOT NULL AND so.customer_phone <> ''
      ORDER BY so.organization_id, normalized_phone, so.shopify_created_at DESC
      ON CONFLICT (organization_id, phone) DO UPDATE SET
        name         = COALESCE(EXCLUDED.name,  contacts.name),
        email        = COALESCE(EXCLUDED.email, contacts.email),
        city         = COALESCE(EXCLUDED.city,  contacts.city),
        contact_type = 'customer',
        updated_at   = NOW();

      -- Migración: campos ricos de Shopify en contacts (para servir clientes desde DB local)
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address1          TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address2          TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS province          TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zip               TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country           TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_spent       NUMERIC DEFAULT 0;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS orders_count      INTEGER DEFAULT 0;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags              JSONB DEFAULT '[]';
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS shopify_created_at TIMESTAMP;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_order_data   JSONB;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS currency          TEXT DEFAULT 'CLP';
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS shopify_note      TEXT;
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMP;

      -- Backfill: crear contacts para todas las conversaciones que no tienen contact aún.
      -- Normaliza el phone (9XXXXXXXX → 56XXXXXXXXX, quita +).
      -- DO NOTHING si ya existe: no queremos bajar un 'customer' a 'lead'.
      INSERT INTO contacts (organization_id, phone, name, contact_type, source, created_at, updated_at)
      SELECT DISTINCT ON (c.organization_id, normalized_phone)
        c.organization_id,
        CASE
          WHEN c.phone_number LIKE '+%'          THEN SUBSTRING(c.phone_number FROM 2)
          WHEN c.phone_number ~ '^9[0-9]{8}$'   THEN '56' || c.phone_number
          ELSE c.phone_number
        END AS normalized_phone,
        CASE
          WHEN c.contact_name IS NULL OR c.contact_name ~ '^[0-9]+$' OR c.contact_name = 'Cliente'
          THEN NULL
          ELSE c.contact_name
        END,
        'lead',
        'whatsapp',
        NOW(), NOW()
      FROM conversations c
      WHERE c.phone_number IS NOT NULL AND c.phone_number <> ''
      ORDER BY c.organization_id, normalized_phone, c.last_message_at DESC
      ON CONFLICT (organization_id, phone) DO UPDATE SET
        name       = COALESCE(EXCLUDED.name, contacts.name),
        source     = COALESCE(contacts.source, 'whatsapp'),
        updated_at = NOW();
    `);

    // Migración: permitir pedidos manuales sin conversación asociada
    await client.query(`
      ALTER TABLE orders ALTER COLUMN conversation_id DROP NOT NULL;
    `);

    // Migración: ampliar pipeline_state para incluir todos los estados usados en el código.
    // El constraint original solo tenía 5 valores; se agregaron más con el tiempo.
    await client.query(`
      ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pipeline_state_check;
      ALTER TABLE conversations ADD CONSTRAINT conversations_pipeline_state_check
        CHECK(pipeline_state IN (
          'exploring','interested','collecting_order','confirmed',
          'awaiting_payment','done','scheduled','future_interest',
          'opted_out','template_sent'
        ));
    `);


    // Migración: rastrear cuándo se envió el último template a cada contacto
    await client.query(`
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_template_sent_at TIMESTAMPTZ;
    `);

    // Migración: precios especiales por empresa
    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_price_overrides (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        phone           TEXT    NOT NULL,
        product_id      TEXT    NOT NULL,
        product_title   TEXT,
        custom_price    NUMERIC NOT NULL,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(organization_id, phone, product_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cpo_org_phone ON contact_price_overrides(organization_id, phone);
    `);

    console.log('✅ DB PostgreSQL multi-tenant configurada');
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { setupDatabase };
