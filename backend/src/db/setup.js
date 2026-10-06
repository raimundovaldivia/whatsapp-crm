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
        evolution_api_url          TEXT,
        evolution_api_key          TEXT,
        evolution_instance         TEXT,
        evolution_webhook_token    TEXT,
        display_phone_number       TEXT,
        status                     TEXT DEFAULT 'pending',
        created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      -- Migración: agregar columnas Kapso si no existen (idempotente)
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS kapso_api_key      TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS webhook_secret     TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS kapso_customer_id  TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS evolution_api_url       TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS evolution_api_key       TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS evolution_instance      TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS evolution_webhook_token TEXT;
      ALTER TABLE whatsapp_configs ADD COLUMN IF NOT EXISTS display_phone_number    TEXT;

      -- ─── CANALES DE WHATSAPP (varios números por organización) ───
      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id                      SERIAL PRIMARY KEY,
        organization_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider                TEXT NOT NULL DEFAULT 'evolution',
        name                    TEXT NOT NULL,
        phone_number            TEXT,
        evolution_api_url       TEXT NOT NULL,
        evolution_api_key       TEXT NOT NULL,
        evolution_instance      TEXT NOT NULL,
        webhook_token           TEXT NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'pending',
        is_default              BOOLEAN NOT NULL DEFAULT FALSE,
        created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, provider, evolution_instance)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_channels_one_default
        ON whatsapp_channels(organization_id) WHERE is_default;

      -- ─── CONVERSACIONES ─────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS conversations (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        whatsapp_channel_id INTEGER REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
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

      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS whatsapp_channel_id INTEGER REFERENCES whatsapp_channels(id) ON DELETE SET NULL;
      ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_organization_id_phone_number_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_org_channel_phone
        ON conversations(organization_id, COALESCE(whatsapp_channel_id, 0), phone_number);

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

      -- Migración: media_id para mensajes con imagen o audio
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error JSONB;
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
      ALTER TABLE messages ADD CONSTRAINT messages_status_check
        CHECK(status IN ('pending','sent','delivered','read','failed'));

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
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_mode_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_agent_mode_check;
      ALTER TABLE conversations ADD CONSTRAINT conversations_agent_mode_check
        CHECK(agent_mode IN ('ai','coordinating','human'));

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
        CHECK(status IN ('draft','sent','payment_received','nuevo','por_despachar','asignado_ruta','en_camino','no_entregado','entregado','paid','cancelled'))
        NOT VALID;

      -- Migración: estado CRM local para órdenes Shopify
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS crm_status TEXT DEFAULT 'nuevo';

      -- ─── COBRANZA: medio de pago y seguimiento del cobro ─────────────
      -- payment_method lo marca el repartidor al entregar (app móvil).
      -- 'transferencia' sin comprobante verificado = pedido por cobrar.
      -- charge_requested_at / charge_request_count registran los recordatorios
      -- enviados, para no cobrarle dos veces al mismo cliente por error.
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method       TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_marked_at    TIMESTAMP;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_marked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_record_source TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS charge_requested_at  TIMESTAMP;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS charge_message_id TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS charge_request_count INTEGER DEFAULT 0;
      -- Varias rutas (cambios de estado, entrega, cobranza) escriben updated_at.
      -- La tabla original solo tenía created_at, así que la agregamos aquí.
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      -- Marca: el repartidor vendió/modificó algo al entregar (bandejas extras).
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_modified BOOLEAN DEFAULT FALSE;
      -- Modificado por el propio cliente desde WhatsApp (modify_order del bot)
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_modified BOOLEAN DEFAULT FALSE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
      -- ─── CONCILIACIÓN BANCARIA: cartolas y abonos ────────────────────
      CREATE TABLE IF NOT EXISTS bank_statements (
        id               SERIAL PRIMARY KEY,
        organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account          TEXT,
        statement_number TEXT,
        kind             TEXT,
        period_from      DATE,
        period_to        DATE,
        filename         TEXT,
        total_abonos     BIGINT,
        total_cargos     BIGINT,
        movements_count  INTEGER DEFAULT 0,
        new_movements    INTEGER DEFAULT 0,
        uploaded_by      INTEGER,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bank_movements (
        id               SERIAL PRIMARY KEY,
        organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        statement_id     INTEGER REFERENCES bank_statements(id) ON DELETE SET NULL,
        movement_key     TEXT NOT NULL,
        date             DATE NOT NULL,
        kind             TEXT NOT NULL,
        amount           BIGINT NOT NULL,
        description      TEXT,
        payer            TEXT,
        doc_number       TEXT,
        branch           TEXT,
        balance          BIGINT,
        status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','ignored')),
        matched_orders   JSONB,
        matched_at       TIMESTAMPTZ,
        matched_by       INTEGER,
        note             TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (organization_id, movement_key)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_movements_org_status ON bank_movements(organization_id, status, date DESC);

      -- Identidades de transferencia aprendidas al confirmar manualmente una
      -- conciliación Santander. Se usa el teléfono normalizado del contacto
      -- para no depender de que el nombre del pedido esté escrito igual.
      CREATE TABLE IF NOT EXISTS bank_contact_identities (
        id                 SERIAL PRIMARY KEY,
        organization_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        bank_name           TEXT NOT NULL DEFAULT 'santander',
        payer_normalized    TEXT NOT NULL,
        payer_display       TEXT,
        contact_id          INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        contact_phone       TEXT NOT NULL,
        contact_name        TEXT,
        confirmations       INTEGER NOT NULL DEFAULT 1,
        active              BOOLEAN NOT NULL DEFAULT TRUE,
        created_by          INTEGER,
        last_confirmed_at   TIMESTAMPTZ DEFAULT NOW(),
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (organization_id, bank_name, payer_normalized, contact_phone)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_contact_identity_lookup
        ON bank_contact_identities(organization_id, bank_name, payer_normalized, active);
      ALTER TABLE bank_movements ADD COLUMN IF NOT EXISTS match_method TEXT;
      ALTER TABLE bank_movements ADD COLUMN IF NOT EXISTS bank_identity_id INTEGER REFERENCES bank_contact_identities(id) ON DELETE SET NULL;

      -- El cliente pidió que se le entregue otro día (desde la app del repartidor)
      ALTER TABLE orders         ADD COLUMN IF NOT EXISTS delivery_date DATE;
      ALTER TABLE orders         ADD COLUMN IF NOT EXISTS delivery_note TEXT;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS delivery_date DATE;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS delivery_note TEXT;
      -- Momento en que la parada se marcó ENTREGADA. Señal limpia de "ya se
      -- repartió", independiente del status (que en pedidos del bot mezcla
      -- 'paid' = pagado con la entrega). Con esto un pedido entregado no
      -- reaparece en la lista de Repartos aunque su status quede en 'paid'.
      ALTER TABLE orders         ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
      -- Backfill: los pedidos que hoy están entregados/pagados ya se repartieron.
      -- (Su fecha aproximada es cuando se marcó el pago o la última actualización.)
      UPDATE orders SET delivered_at = COALESCE(payment_marked_at, updated_at, created_at)
        WHERE delivered_at IS NULL AND status IN ('entregado', 'paid');
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS payment_marked_at TIMESTAMP;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      UPDATE shopify_orders SET delivered_at = COALESCE(payment_marked_at, updated_at, synced_at)
        WHERE delivered_at IS NULL AND crm_status = 'entregado';

      -- Intentos de despacho: cuántas veces salió el pedido a reparto, cuándo
      -- fue el último intento y cómo terminó (fallido / reprogramado). Sirve
      -- para que un pedido que "falló" NO quede cancelado sino de vuelta en
      -- 'por_despachar', y para marcar en la lista "ya salió antes".
      ALTER TABLE orders         ADD COLUMN IF NOT EXISTS dispatch_count      INT DEFAULT 0;
      ALTER TABLE orders         ADD COLUMN IF NOT EXISTS last_attempt_at     TIMESTAMP;
      ALTER TABLE orders         ADD COLUMN IF NOT EXISTS last_attempt_status TEXT;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS dispatch_count      INT DEFAULT 0;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS last_attempt_at     TIMESTAMP;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS last_attempt_status TEXT;

      -- Tokens push (Expo) de las apps de administrador (Central). Un admin
      -- puede tener varios dispositivos; el token es único.
      CREATE TABLE IF NOT EXISTS push_tokens (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        user_id         INTEGER,
        token           TEXT UNIQUE NOT NULL,
        platform        TEXT DEFAULT 'expo',
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_tokens_org ON push_tokens(organization_id);

      -- Recordatorio enviado al cliente cuando una escalación lleva mucho sin respuesta humana
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalation_reminder_at TIMESTAMP;
      -- Evita repetir al admin una alerta por cada mensaje seguido del mismo cliente.
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS human_pending_notified_at TIMESTAMP;

      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS payment_method       TEXT;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS payment_marked_at    TIMESTAMP;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS payment_marked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS payment_record_source TEXT;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS charge_requested_at  TIMESTAMP;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS charge_message_id TEXT;
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS charge_request_count INTEGER DEFAULT 0;
      -- Link historical collection receipts only when both sides match uniquely.
      WITH attempts AS (
        SELECT 'bot' AS source, id::text AS id, organization_id, customer_phone, charge_requested_at FROM orders WHERE charge_message_id IS NULL AND charge_requested_at IS NOT NULL
        UNION ALL
        SELECT 'shopify', shopify_order_id, organization_id, customer_phone, charge_requested_at FROM shopify_orders WHERE charge_message_id IS NULL AND charge_requested_at IS NOT NULL
      ), candidates AS (
        SELECT a.source, a.id, a.organization_id, m.whatsapp_message_id,
          COUNT(*) OVER (PARTITION BY a.source, a.id, a.organization_id) AS order_matches,
          COUNT(*) OVER (PARTITION BY m.id) AS message_matches
        FROM attempts a JOIN conversations c ON c.organization_id=a.organization_id
          AND regexp_replace(c.phone_number, '[^0-9]', '', 'g')=regexp_replace(a.customer_phone, '[^0-9]', '', 'g')
        JOIN messages m ON m.conversation_id=c.id AND m.agent_type='cobranza' AND m.direction='outbound'
          AND m.status IN ('failed','delivered','read') AND m.whatsapp_message_id IS NOT NULL
          AND m.created_at BETWEEN a.charge_requested_at - INTERVAL '30 seconds' AND a.charge_requested_at
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.charge_message_id=m.whatsapp_message_id)
          AND NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.charge_message_id=m.whatsapp_message_id)
      ), linked_bot AS (
        UPDATE orders o SET charge_message_id=c.whatsapp_message_id FROM candidates c
        WHERE c.source='bot' AND o.id::text=c.id AND o.organization_id=c.organization_id AND c.order_matches=1 AND c.message_matches=1
      )
      UPDATE shopify_orders o SET charge_message_id=c.whatsapp_message_id FROM candidates c
      WHERE c.source='shopify' AND o.shopify_order_id=c.id AND o.organization_id=c.organization_id AND c.order_matches=1 AND c.message_matches=1;

      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS delivery_modified BOOLEAN DEFAULT FALSE;

      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS payment_cash_amount NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS payment_transfer_amount NUMERIC(12,2);
      ALTER TABLE shopify_orders
        ADD COLUMN IF NOT EXISTS payment_cash_amount NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS payment_transfer_amount NUMERIC(12,2);
      ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
      ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
        CHECK(payment_method IS NULL OR payment_method IN ('efectivo','transferencia','mixto','otro')) NOT VALID;
      ALTER TABLE shopify_orders DROP CONSTRAINT IF EXISTS shopify_orders_payment_method_check;
      ALTER TABLE shopify_orders ADD CONSTRAINT shopify_orders_payment_method_check
        CHECK(payment_method IS NULL OR payment_method IN ('efectivo','transferencia','mixto','otro')) NOT VALID;

      CREATE INDEX IF NOT EXISTS idx_orders_por_cobrar
        ON orders(organization_id, payment_method, status);
      CREATE INDEX IF NOT EXISTS idx_shopify_orders_por_cobrar
        ON shopify_orders(organization_id, payment_method, crm_status);

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
      -- Evidencia bancaria que confirma que el comprobante realmente aparece
      -- en la cartola. Se mantiene separada del análisis visual para que toda
      -- verificación sea explicable y reversible.
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS bank_movement_id         INTEGER REFERENCES bank_movements(id) ON DELETE SET NULL;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS reconciliation_score     INTEGER;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS reconciliation_confidence TEXT;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS reconciliation_reasons   JSONB;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS bank_verified_at          TIMESTAMPTZ;
      ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS verification_method       TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_proofs_bank_movement
        ON payment_proofs(organization_id, bank_movement_id)
        WHERE bank_movement_id IS NOT NULL;

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
        started_at        TIMESTAMPTZ,
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

      -- Confirmed general product specification, scoped to Diez Ríos (not customer-specific SKUs).
      INSERT INTO settings (organization_id, key, value)
      SELECT id, 'goat_cheese_weight', '900 g–1 kg' FROM organizations WHERE slug = 'diez-rios-mrs96z69'
      ON CONFLICT (organization_id, key) DO NOTHING;
      UPDATE products p SET title = 'Queso de Cabra Fresco Pasteurizado – 900 g–1 kg',
        description = 'Queso fresco elaborado con leche de cabra pasteurizada. Peso por pieza: entre 900 g y 1 kg.',
        updated_at = NOW()
      FROM organizations o WHERE p.organization_id = o.id AND o.slug = 'diez-rios-mrs96z69'
        AND p.id = 11 AND p.is_business IS NOT TRUE AND p.title ILIKE '%queso de cabra%'
        AND p.title NOT LIKE '%900 g–1 kg%';


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
        name = CASE WHEN NULLIF(BTRIM(contacts.name), '') IS NOT NULL
          AND LOWER(BTRIM(contacts.name)) <> 'cliente' AND contacts.name !~ '^[+0-9 ()-]+$'
          THEN contacts.name ELSE EXCLUDED.name END,
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
        name = CASE WHEN NULLIF(BTRIM(contacts.name), '') IS NOT NULL
          AND LOWER(BTRIM(contacts.name)) <> 'cliente' AND contacts.name !~ '^[+0-9 ()-]+$'
          THEN contacts.name ELSE EXCLUDED.name END,
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

    // Auditoría durable de campañas masivas. Guarda tanto aceptaciones como
    // rechazos/omisiones para que un HTTP 200 no se confunda con mensajes enviados.
    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcast_campaigns (
        id              BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        template_name   TEXT NOT NULL,
        total_count     INTEGER NOT NULL DEFAULT 0,
        test_mode       BOOLEAN NOT NULL DEFAULT FALSE,
        test_phone      TEXT,
        status          TEXT NOT NULL DEFAULT 'processing'
                        CHECK(status IN ('processing','completed','interrupted')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_broadcast_campaigns_org_created
        ON broadcast_campaigns(organization_id, created_at DESC);
      ALTER TABLE broadcast_campaigns ADD COLUMN IF NOT EXISTS sending_provider TEXT NOT NULL DEFAULT 'kapso';
      ALTER TABLE broadcast_campaigns ADD COLUMN IF NOT EXISTS sending_channel_id INTEGER;
      ALTER TABLE broadcast_campaigns ADD COLUMN IF NOT EXISTS pacing_settings JSONB;
      ALTER TABLE broadcast_campaigns ADD COLUMN IF NOT EXISTS server_managed BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE TABLE IF NOT EXISTS broadcast_jobs (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        item JSONB NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','unknown')),
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        result JSONB,
        UNIQUE(campaign_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_pending ON broadcast_jobs(available_at, id) WHERE state = 'pending';
      CREATE TABLE IF NOT EXISTS broadcast_channel_pacing (
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        channel_id INTEGER NOT NULL,
        campaign_id BIGINT,
        batch_count INTEGER NOT NULL DEFAULT 1,
        next_send_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (organization_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS broadcast_direct_pacing (
        organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        next_send_at TIMESTAMPTZ NOT NULL
      );
    ALTER TABLE broadcast_direct_pacing ADD COLUMN IF NOT EXISTS batch_count INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS broadcast_campaign_recipients (
        id                  BIGSERIAL PRIMARY KEY,
        campaign_id         BIGINT NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
        organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        destination_phone   TEXT,
        original_phone      TEXT,
        contact_name        TEXT,
        template_name       TEXT,
        result_status       TEXT NOT NULL
                            CHECK(result_status IN ('accepted','skipped','failed')),
        error_code          TEXT,
        error_message       TEXT,
        error_detail        JSONB,
        whatsapp_message_id TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_campaign
        ON broadcast_campaign_recipients(campaign_id, id);
      CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_message
        ON broadcast_campaign_recipients(whatsapp_message_id)
        WHERE whatsapp_message_id IS NOT NULL;

      ALTER TABLE broadcast_campaign_recipients
        ADD COLUMN IF NOT EXISTS language_code TEXT DEFAULT 'es';
      ALTER TABLE broadcast_campaign_recipients
        ADD COLUMN IF NOT EXISTS template_components JSONB;
      ALTER TABLE broadcast_campaign_recipients
        ADD COLUMN IF NOT EXISTS provider_checked_at TIMESTAMPTZ;
      ALTER TABLE broadcast_campaign_recipients
        ADD COLUMN IF NOT EXISTS provider_status TEXT;

      ALTER TABLE broadcast_campaign_recipients
        DROP CONSTRAINT IF EXISTS broadcast_campaign_recipients_result_status_check;
      ALTER TABLE broadcast_campaign_recipients
        ADD CONSTRAINT broadcast_campaign_recipients_result_status_check
        CHECK(result_status IN ('accepted','skipped','failed','unknown'));

      ALTER TABLE broadcast_campaigns
        ADD COLUMN IF NOT EXISTS provider_broadcast_id TEXT;
      ALTER TABLE broadcast_campaigns
        ADD COLUMN IF NOT EXISTS pause_code TEXT;
      ALTER TABLE broadcast_campaigns
        ADD COLUMN IF NOT EXISTS pause_reason TEXT;
      ALTER TABLE broadcast_campaigns
        ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
      ALTER TABLE broadcast_campaigns
        DROP CONSTRAINT IF EXISTS broadcast_campaigns_status_check;
      ALTER TABLE broadcast_campaigns
        ADD CONSTRAINT broadcast_campaigns_status_check
        CHECK(status IN ('processing','completed','interrupted','paused_payment'));

      CREATE TABLE IF NOT EXISTS broadcast_followup_jobs (
        id                 BIGSERIAL PRIMARY KEY,
        organization_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_campaign_id BIGINT NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
        target_campaign_id BIGINT REFERENCES broadcast_campaigns(id) ON DELETE SET NULL,
        template_name      TEXT NOT NULL,
        language_code      TEXT NOT NULL DEFAULT 'es',
        scheduled_for      TIMESTAMPTZ NOT NULL,
        status             TEXT NOT NULL DEFAULT 'scheduled'
                           CHECK(status IN ('scheduled','processing','completed','cancelled','failed')),
        conditions         JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_error         TEXT,
        created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at       TIMESTAMPTZ,
        UNIQUE(source_campaign_id, scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS idx_broadcast_followup_due
        ON broadcast_followup_jobs(status, scheduled_for);
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

    // Migración: respuestas pendientes del admin via WhatsApp personal
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_pending_replies (
        id              SERIAL PRIMARY KEY,
        org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        customer_phone  TEXT NOT NULL,
        context         TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_apr_org_status ON admin_pending_replies(org_id, status, created_at DESC);
    `);

    // Migración: columnas WA para agentes
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS whatsapp_phone   TEXT,
        ADD COLUMN IF NOT EXISTS wa_notifications JSONB DEFAULT '{"new_messages":false,"escalations":true,"payments":false}'::jsonb;
    `);

    // Migración: agregar rol 'supervisor' al CHECK constraint de users
    // DROP CONSTRAINT no es idempotente, así que verificamos primero
    await client.query(`
      DO $$
      BEGIN
        -- Eliminar constraint viejo si todavía excluye 'supervisor'
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'users' AND constraint_name = 'users_role_check'
        ) THEN
          ALTER TABLE users DROP CONSTRAINT users_role_check;
        END IF;
        -- Agregar constraint actualizado con supervisor y repartidor
        ALTER TABLE users
          ADD CONSTRAINT users_role_check
          CHECK (role IN ('owner','admin','supervisor','agent','repartidor','coordinador'));
      EXCEPTION WHEN OTHERS THEN
        NULL; -- ignorar si ya existe con nombre distinto
      END
      $$;

      -- Ventana de 24h POR usuario: último mensaje entrante de cada miembro del
      -- equipo al número, para avisarle antes de que su canal de WhatsApp se
      -- cierre (igual que el aviso del admin, pero individual).
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_last_inbound  TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_window_warned TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_window_closed_notified TIMESTAMP;
    `);

    // ─── DESPACHOS: módulo de repartos ───────────────────────────────
    // - driver_user_id: la ruta se asigna a un usuario con rol 'repartidor'.
    //   Así cada chofer ve solo sus rutas en la app. driver_name/driver_phone
    //   se mantienen como texto libre para repartidores sin cuenta.
    // - stop_payments: medio de pago por parada ({ "bot_12": "efectivo" }),
    //   para que la web y la app lo muestren sin cruzar con orders.
    // - stop_notes: nota del repartidor por parada ({ "bot_12": "dejé con conserje" }).
    // - stop_extras: venta extra del repartidor por parada
    //   ({ "bot_12": [{ name, quantity, price }] }). No toca el pedido original.
    await client.query(`
      ALTER TABLE delivery_routes
        ADD COLUMN IF NOT EXISTS driver_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS stop_payments  JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS stop_payment_amounts JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS stop_notes     JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS stop_extras    JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS stop_times     JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS load_checklist JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS started_at     TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_delivery_routes_driver
        ON delivery_routes(organization_id, driver_user_id, status);
    `);

    // Antes del checklist, enviar una ruta la dejaba inmediatamente en
    // `in_progress`. Esas rutas no tienen started_at y la app nueva las
    // interpretaría como ya iniciadas, saltándose la consolidación. Devuelve
    // únicamente esas rutas heredadas a `sent` y libera sus pedidos para que
    // el repartidor pueda revisar la carga y comenzarlas de forma explícita.
    await client.query(`
      WITH legacy_routes AS (
        SELECT id, organization_id, orders
          FROM delivery_routes
         WHERE status = 'in_progress'
           AND started_at IS NULL
           AND completed_at IS NULL
      ), legacy_shopify AS (
        SELECT DISTINCT lr.organization_id, item->>'id' AS order_id
          FROM legacy_routes lr
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(lr.orders::jsonb, '[]'::jsonb)) item
         WHERE item->>'source' = 'shopify'
      )
      UPDATE shopify_orders so
         SET crm_status = 'por_despachar'
        FROM legacy_shopify ls
       WHERE so.organization_id = ls.organization_id
         AND so.shopify_order_id::text = ls.order_id
         AND so.crm_status = 'en_camino'
         AND so.delivered_at IS NULL;

      WITH legacy_routes AS (
        SELECT id, organization_id, orders
          FROM delivery_routes
         WHERE status = 'in_progress'
           AND started_at IS NULL
           AND completed_at IS NULL
      ), legacy_bot AS (
        SELECT DISTINCT lr.organization_id, (item->>'id')::integer AS order_id
          FROM legacy_routes lr
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(lr.orders::jsonb, '[]'::jsonb)) item
         WHERE item->>'source' = 'bot'
           AND item->>'id' ~ '^\\d+$'
      )
      UPDATE orders o
         SET status = 'por_despachar', updated_at = NOW()
        FROM legacy_bot lb
       WHERE o.organization_id = lb.organization_id
         AND o.id = lb.order_id
         AND o.status = 'en_camino'
         AND o.delivered_at IS NULL;

      UPDATE delivery_routes
         SET status = 'sent', load_checklist = '{}'::jsonb
       WHERE status = 'in_progress'
         AND started_at IS NULL
         AND completed_at IS NULL;

      -- Una ruta enviada reserva sus pedidos durante la consolidación. Así no
      -- vuelven a aparecer en "Nuevo reparto" antes de que el chofer la inicie.
      WITH sent_shopify AS (
        SELECT DISTINCT r.organization_id, item->>'id' AS order_id
          FROM delivery_routes r
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.orders::jsonb, '[]'::jsonb)) item
         WHERE r.status = 'sent' AND item->>'source' = 'shopify'
      )
      UPDATE shopify_orders so
         SET crm_status = 'asignado_ruta'
        FROM sent_shopify sr
       WHERE so.organization_id = sr.organization_id
         AND so.shopify_order_id::text = sr.order_id
         AND so.delivered_at IS NULL
         AND COALESCE(so.crm_status, '') NOT IN ('en_camino','entregado','cancelled');

      WITH sent_bot AS (
        SELECT DISTINCT r.organization_id, (item->>'id')::integer AS order_id
          FROM delivery_routes r
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.orders::jsonb, '[]'::jsonb)) item
         WHERE r.status = 'sent'
           AND item->>'source' = 'bot'
           AND item->>'id' ~ '^\d+$'
      )
      UPDATE orders o
         SET status = 'asignado_ruta', updated_at = NOW()
        FROM sent_bot sr
       WHERE o.organization_id = sr.organization_id
         AND o.id = sr.order_id
         AND o.delivered_at IS NULL
         AND o.status NOT IN ('en_camino','entregado','paid','cancelled');
    `);

    // ─── DESPACHOS: gastos rendidos por el repartidor (petróleo, peaje, etc.) ──
    // El repartidor rinde gastos del efectivo que recibe, con foto opcional
    // (boleta/surtidor). El admin los ve en Repartos. La foto se guarda como
    // BYTEA y se sirve por /api/delivery/expenses/:id/photo.
    await client.query(`
      CREATE TABLE IF NOT EXISTS delivery_expenses (
        id               SERIAL PRIMARY KEY,
        organization_id  INTEGER NOT NULL,
        route_id         INTEGER,
        driver_user_id   INTEGER,
        driver_name      TEXT,
        amount           INTEGER NOT NULL,
        category         TEXT,
        note             TEXT,
        photo            BYTEA,
        photo_mime       TEXT,
        created_at       TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_expenses_org
        ON delivery_expenses(organization_id, created_at DESC);
    `);

    // ─── COLA DE ALERTAS AL ADMIN ────────────────────────────────────
    // WhatsApp no permite texto libre a un número que no escribió en 24h.
    // Cuando una alerta al admin no se puede entregar por ventana cerrada,
    // se guarda acá y se reenvía apenas el admin vuelve a escribir al número.
    // 'kind' distingue el tipo (help = "cómo respondo", handoff, payment).
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_outbox (
        id              SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        admin_phone     TEXT NOT NULL,
        body            TEXT NOT NULL,
        kind            TEXT DEFAULT 'help',
        conversation_id INTEGER,
        status          TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','expired')),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        sent_at         TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_admin_outbox_pending
        ON admin_outbox(organization_id, status, created_at);
    `);
    // ─── CACHÉ DE GEOCODIFICACIÓN ────────────────────────────────────
    // Convertir una dirección a lat/lng cuesta una llamada a Google. Se cachea
    // por (org, dirección) para no re-geocodificar la misma dirección cada vez
    // que se abre el panel de repartos.
    await client.query(`
      CREATE TABLE IF NOT EXISTS geocode_cache (
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        address_key     TEXT NOT NULL,
        lat             DOUBLE PRECISION,
        lng             DOUBLE PRECISION,
        found           BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (organization_id, address_key)
      );
    `);

    // Estado de la ventana de 24h del admin (para el aviso preventivo):
    //   admin_window_last_inbound  → ISO del último mensaje del admin al número
    //   admin_window_warning_sent  → ISO de la ventana en que ya se avisó (para no repetir)
    // Se guardan como settings por org; no requieren columnas nuevas.

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_inbox (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        headers JSONB NOT NULL,
        params JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','needs_review')),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(provider, organization_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_pending ON webhook_inbox(status, id);
      DROP INDEX IF EXISTS idx_webhook_org_processing;
      CREATE TABLE IF NOT EXISTS webhook_streams (
        id BIGSERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        stream_key TEXT NOT NULL,
        processing BOOLEAN NOT NULL DEFAULT FALSE,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(provider, organization_id, stream_key)
      );
      ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS stream_id BIGINT REFERENCES webhook_streams(id);
      INSERT INTO webhook_streams(provider, organization_id, stream_key)
        SELECT DISTINCT provider,organization_id,'organization' FROM webhook_inbox WHERE stream_id IS NULL
        ON CONFLICT DO NOTHING;
      UPDATE webhook_inbox w SET stream_id=s.id FROM webhook_streams s
        WHERE w.stream_id IS NULL AND s.provider=w.provider AND s.organization_id=w.organization_id AND s.stream_key='organization';
      CREATE INDEX IF NOT EXISTS idx_webhook_stream_status ON webhook_inbox(stream_id,status,id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE delivery_expenses ADD COLUMN IF NOT EXISTS client_request_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_request
        ON delivery_expenses(organization_id, driver_user_id, client_request_id);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS meta_connections (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
        facebook_user_id TEXT,
        facebook_user_name TEXT,
        user_access_token TEXT,
        page_id TEXT,
        page_name TEXT,
        page_access_token TEXT,
        instagram_account_id TEXT,
        instagram_username TEXT,
        ad_account_id TEXT,
        ad_account_name TEXT,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        available_assets JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','error')),
        token_expires_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_meta_connections_page ON meta_connections(page_id);
      CREATE INDEX IF NOT EXISTS idx_meta_connections_ig ON meta_connections(instagram_account_id);

      CREATE TABLE IF NOT EXISTS meta_threads (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('facebook','instagram')),
        external_user_id TEXT NOT NULL,
        contact_name TEXT,
        profile_picture_url TEXT,
        last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(organization_id,channel,external_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_threads_org ON meta_threads(organization_id,last_message_at DESC);

      CREATE TABLE IF NOT EXISTS meta_messages (
        id BIGSERIAL PRIMARY KEY,
        thread_id BIGINT NOT NULL REFERENCES meta_threads(id) ON DELETE CASCADE,
        external_message_id TEXT UNIQUE,
        direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text',
        status TEXT NOT NULL DEFAULT 'sent',
        sent_by TEXT NOT NULL DEFAULT 'human',
        raw_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_meta_messages_thread ON meta_messages(thread_id,created_at);
    `);
    await client.query(require('node:fs').readFileSync(require('node:path').join(__dirname, 'commercial.sql'), 'utf8'));
    console.log('✅ DB PostgreSQL multi-tenant configurada');
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { setupDatabase };
