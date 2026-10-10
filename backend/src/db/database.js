const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

function getPool() {
  return pool;
}

// ─── ORGANIZATIONS ────────────────────────────────────────────────

async function createOrganization({ name, slug }) {
  return queryOne(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *`,
    [name, slug]
  );
}

async function getOrgById(id) {
  return queryOne('SELECT * FROM organizations WHERE id = $1', [id]);
}

async function markSetupDone(orgId) {
  await pool.query('UPDATE organizations SET setup_done = 1 WHERE id = $1', [orgId]);
}

// ─── USERS / AUTH ─────────────────────────────────────────────────

async function createUser({ organizationId, email, passwordHash, name, role = 'owner' }) {
  return queryOne(
    `INSERT INTO users (organization_id, email, password_hash, name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, organization_id, email, name, role, created_at`,
    [organizationId, email, passwordHash, name, role]
  );
}

async function getUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = $1', [email]);
}

async function getUserById(id) {
  return queryOne(
    'SELECT id, organization_id, email, name, role, auth_version FROM users WHERE id = $1 AND merged_into_user_id IS NULL',
    [id]
  );
}

async function listOrgUsers(orgId) {
  return query(
    `SELECT id, email, name, role, whatsapp_phone, wa_notifications, created_at
     FROM users
     WHERE organization_id = $1 AND merged_into_user_id IS NULL
     ORDER BY created_at ASC`,
    [orgId]
  );
}

async function getUserByWhatsappPhone(orgId, phone) {
  const normalized = normalizePhone(phone);
  const result = await query(
    `SELECT id, organization_id, email, name, role, whatsapp_phone, wa_notifications
     FROM users
     WHERE organization_id = $1 AND merged_into_user_id IS NULL
       AND (whatsapp_phone = $2 OR whatsapp_phone = $3)`,
    [orgId, phone, normalized]
  );
  return result[0] || null;
}

async function updateUserWaPhone(userId, orgId, waPhone) {
  return queryOne(
    `UPDATE users SET whatsapp_phone = $1 WHERE id = $2 AND organization_id = $3 AND role <> 'owner'
     RETURNING id, email, name, role, whatsapp_phone, wa_notifications`,
    [waPhone || null, userId, orgId]
  );
}

async function updateUserNotifications(userId, orgId, notifications) {
  return queryOne(
    `UPDATE users SET wa_notifications = $1 WHERE id = $2 AND organization_id = $3
     RETURNING id, email, name, role, whatsapp_phone, wa_notifications`,
    [JSON.stringify(notifications), userId, orgId]
  );
}

async function getAgentsWithNotification(orgId, notifKey) {
  return query(
    `SELECT id, name, email, whatsapp_phone, wa_notifications
     FROM users
     WHERE organization_id = $1
       AND whatsapp_phone IS NOT NULL
       AND whatsapp_phone <> ''
       AND merged_into_user_id IS NULL
       AND (wa_notifications->>'${notifKey}')::boolean = true`,
    [orgId]
  );
}

/**
 * Registra que un miembro del equipo escribió al número (reabre su ventana de
 * 24h). Se llama en el webhook con el teléfono del remitente: si coincide con el
 * whatsapp_phone de algún usuario, actualiza su wa_last_inbound y limpia el aviso
 * de cierre. Para clientes no coincide con nadie y no hace nada.
 */
async function touchUserWaWindow(orgId, phone) {
  if (!phone) return;
  return query(
    `UPDATE users
        SET wa_last_inbound = NOW(), wa_window_warned = NULL,
            wa_window_closed_notified = NULL
      WHERE organization_id = $1
        AND whatsapp_phone IS NOT NULL AND whatsapp_phone <> ''
        AND regexp_replace(whatsapp_phone, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')`,
    [orgId, phone]
  );
}

async function updateUserRole(userId, orgId, role) {
  return queryOne(
    `UPDATE users SET role = $1, auth_version = auth_version + 1
     WHERE id = $2 AND organization_id = $3
     RETURNING id, email, name, role`,
    [role, userId, orgId]
  );
}

async function deleteOrgUser(userId, orgId) {
  const result = await pool.query(
    "DELETE FROM users WHERE id = $1 AND organization_id = $2 AND role <> 'owner'",
    [userId, orgId]
  );
  return result.rowCount > 0;
}

// ─── WHATSAPP CONFIG ──────────────────────────────────────────────

async function upsertWhatsappConfig(orgId, config) {
  await pool.query(
    `INSERT INTO whatsapp_configs (
      organization_id, provider,
      phone_number_id, business_account_id, access_token, webhook_verify_token,
      twilio_account_sid, twilio_auth_token, twilio_phone_number,
      kapso_api_key, webhook_secret, kapso_customer_id,
      evolution_api_url, evolution_api_key, evolution_instance, evolution_webhook_token,
      display_phone_number,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'connected')
    ON CONFLICT(organization_id) DO UPDATE SET
      provider              = EXCLUDED.provider,
      phone_number_id       = EXCLUDED.phone_number_id,
      business_account_id   = EXCLUDED.business_account_id,
      access_token          = EXCLUDED.access_token,
      webhook_verify_token  = EXCLUDED.webhook_verify_token,
      twilio_account_sid    = EXCLUDED.twilio_account_sid,
      twilio_auth_token     = EXCLUDED.twilio_auth_token,
      twilio_phone_number   = EXCLUDED.twilio_phone_number,
      kapso_api_key         = EXCLUDED.kapso_api_key,
      webhook_secret        = EXCLUDED.webhook_secret,
      kapso_customer_id     = EXCLUDED.kapso_customer_id,
      evolution_api_url       = EXCLUDED.evolution_api_url,
      evolution_api_key       = EXCLUDED.evolution_api_key,
      evolution_instance      = EXCLUDED.evolution_instance,
      evolution_webhook_token = EXCLUDED.evolution_webhook_token,
      display_phone_number     = COALESCE(EXCLUDED.display_phone_number, whatsapp_configs.display_phone_number),
      status                = 'connected'`,
    [
      orgId,
      config.provider            || 'meta',
      config.phoneNumberId       || null,
      config.businessAccountId   || null,
      config.accessToken         || null,
      config.webhookVerifyToken  || null,
      config.twilioAccountSid    || null,
      config.twilioAuthToken     || null,
      config.twilioPhoneNumber   || null,
      config.kapsoApiKey         || null,
      config.webhookSecret       || null,
      config.kapsoCustomerId     || null,
      config.evolutionApiUrl       || null,
      config.evolutionApiKey       || null,
      config.evolutionInstance     || null,
      config.evolutionWebhookToken || null,
      config.displayPhoneNumber     || null,
    ]
  );
}

async function getWhatsappConfig(orgId) {
  return queryOne('SELECT * FROM whatsapp_configs WHERE organization_id = $1', [orgId]);
}

async function getOrgByWebhookToken(token) {
  const wc = await queryOne('SELECT * FROM whatsapp_configs WHERE webhook_verify_token = $1', [token]);
  if (!wc) return null;
  const org = await getOrgById(wc.organization_id);
  return { org, whatsappConfig: wc };
}

async function getOrgByPhoneNumberId(phoneNumberId) {
  const wc = await queryOne('SELECT * FROM whatsapp_configs WHERE phone_number_id = $1', [phoneNumberId]);
  if (!wc) return null;
  const org = await getOrgById(wc.organization_id);
  return { org, whatsappConfig: wc };
}

async function getOrgByTwilioNumber(twilioPhoneNumber) {
  const wc = await queryOne('SELECT * FROM whatsapp_configs WHERE twilio_phone_number = $1', [twilioPhoneNumber]);
  if (!wc) return null;
  const org = await getOrgById(wc.organization_id);
  return { org, whatsappConfig: wc };
}

async function createWhatsappChannel(orgId, channel) {
  return getPool().connect().then(async client => {
    try {
      await client.query('BEGIN');
      const reserved = await client.query('SELECT assigned_user_id FROM whatsapp_channels WHERE organization_id=$1 AND provider=$2 AND evolution_instance=$3', [orgId, 'evolution', channel.evolutionInstance]);
      if (reserved.rows[0]?.assigned_user_id) throw Object.assign(new Error('Esta instancia pertenece a un despachador. Gestiona su conexión desde Equipo.'), { status: 409 });

      const existingDefault = await client.query(
        'SELECT 1 FROM whatsapp_channels WHERE organization_id = $1 AND is_default = TRUE LIMIT 1',
        [orgId]
      );
      const makeDefault = channel.isDefault === true || existingDefault.rowCount === 0;
      if (makeDefault) {
        await client.query('UPDATE whatsapp_channels SET is_default = FALSE, updated_at = NOW() WHERE organization_id = $1', [orgId]);
      }
      const { rows: [saved] } = await client.query(
        `INSERT INTO whatsapp_channels (
           organization_id, provider, name, phone_number, evolution_api_url,
           evolution_api_key, evolution_instance, webhook_token, status, is_default
         ) VALUES ($1, 'evolution', $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (organization_id, provider, evolution_instance) DO UPDATE SET
           name = EXCLUDED.name,
           phone_number = COALESCE(EXCLUDED.phone_number, whatsapp_channels.phone_number),
           evolution_api_url = EXCLUDED.evolution_api_url,
           evolution_api_key = EXCLUDED.evolution_api_key,
           webhook_token = EXCLUDED.webhook_token,
           status = EXCLUDED.status,
           is_default = CASE WHEN EXCLUDED.is_default THEN TRUE ELSE whatsapp_channels.is_default END,
           updated_at = NOW()
         WHERE whatsapp_channels.assigned_user_id IS NULL
         RETURNING *`,
        [orgId, channel.name, channel.phoneNumber || null, channel.evolutionApiUrl,
          channel.evolutionApiKey, channel.evolutionInstance, channel.webhookToken,
          channel.status || 'pending', makeDefault]
      );
      await client.query('COMMIT');
      return saved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  });
}

async function listWhatsappChannels(orgId) {
  return query(
    `SELECT id, organization_id, provider, name, phone_number, evolution_api_url,
            evolution_instance, status, is_default, created_at, updated_at
       FROM whatsapp_channels WHERE organization_id = $1 AND assigned_user_id IS NULL
      ORDER BY is_default DESC, id ASC`,
    [orgId]
  );
}

async function getWhatsappChannel(orgId, channelId) {
  return queryOne('SELECT * FROM whatsapp_channels WHERE id = $1 AND organization_id = $2', [channelId, orgId]);
}

async function getDefaultWhatsappChannel(orgId) {
  return queryOne(
    'SELECT * FROM whatsapp_channels WHERE organization_id = $1 AND assigned_user_id IS NULL ORDER BY is_default DESC, id ASC LIMIT 1',
    [orgId]
  );
}

async function getEvolutionWhatsappChannel(orgId) {
  return queryOne(
    `SELECT * FROM whatsapp_channels
      WHERE organization_id = $1 AND provider = 'evolution' AND assigned_user_id IS NULL
        AND evolution_api_url IS NOT NULL
        AND evolution_api_key IS NOT NULL
        AND evolution_instance IS NOT NULL
      ORDER BY (status = 'connected') DESC, is_default DESC, id ASC
      LIMIT 1`,
    [orgId]
  );
}

async function setDefaultWhatsappChannel(orgId, channelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id FROM whatsapp_channels WHERE id = $1 AND organization_id = $2 AND assigned_user_id IS NULL FOR UPDATE', [channelId, orgId]);
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('UPDATE whatsapp_channels SET is_default = FALSE, updated_at = NOW() WHERE organization_id = $1', [orgId]);
    const { rows: [updated] } = await client.query('UPDATE whatsapp_channels SET is_default = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *', [channelId]);
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function updateWhatsappChannelStatus(orgId, channelId, status, phoneNumber = null) {
  return queryOne(
    `UPDATE whatsapp_channels SET status = $1,
       phone_number = COALESCE($2, phone_number), updated_at = NOW()
     WHERE id = $3 AND organization_id = $4 RETURNING *`,
    [status, phoneNumber, channelId, orgId]
  );
}

// ─── DATA SOURCES ─────────────────────────────────────────────────

async function createDataSource({ organizationId, type, name, config }) {
  return queryOne(
    `INSERT INTO data_sources (organization_id, type, name, config)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [organizationId, type, name, JSON.stringify(config)]
  );
}

async function getDataSources(orgId) {
  return query('SELECT * FROM data_sources WHERE organization_id = $1', [orgId]);
}

async function getDataSource(id, orgId) {
  const ds = await queryOne(
    'SELECT * FROM data_sources WHERE id = $1 AND organization_id = $2',
    [id, orgId]
  );
  if (ds) ds.config = JSON.parse(ds.config || '{}');
  return ds;
}

async function updateDataSourceStatus(id, status) {
  await pool.query(
    'UPDATE data_sources SET status = $1, last_sync_at = CURRENT_TIMESTAMP WHERE id = $2',
    [status, id]
  );
}

async function getPrimaryDataSource(orgId) {
  const ds = await queryOne(
    "SELECT * FROM data_sources WHERE organization_id = $1 AND status = 'connected' LIMIT 1",
    [orgId]
  );
  if (ds) ds.config = JSON.parse(ds.config || '{}');
  return ds;
}

// ─── AGENTS ───────────────────────────────────────────────────────

async function createAgent({ organizationId, dataSourceId, name, type, systemPrompt = null, config = {} }) {
  return queryOne(
    `INSERT INTO agents (organization_id, data_source_id, name, type, system_prompt, config)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [organizationId, dataSourceId, name, type, systemPrompt, JSON.stringify(config)]
  );
}

async function getAgents(orgId) {
  return query('SELECT * FROM agents WHERE organization_id = $1 ORDER BY type', [orgId]);
}

async function createDefaultAgents(orgId, dataSourceId) {
  const rows = await query('SELECT COUNT(*) as n FROM agents WHERE organization_id = $1', [orgId]);
  if (parseInt(rows[0].n) > 0) return;

  const agents = [
    { type: 'orchestrator', name: 'Orquestador' },
    { type: 'sales',        name: 'Agente de Ventas' },
    { type: 'orders',       name: 'Agente de Órdenes' },
  ];
  for (const a of agents) {
    await createAgent({ organizationId: orgId, dataSourceId, name: a.name, type: a.type });
  }
}

// ─── PHONE NORMALIZATION ──────────────────────────────────────────
// Regla: siempre almacenar con código de país.
// - Saca "+" → "56961899016"
// - Si son 9 dígitos empezando en 9 (móvil chileno) → agrega "56"
// - Ej: "+56961899016" → "56961899016"
//       "961899016"    → "56961899016"
//       "56961899016"  → "56961899016" (sin cambio)
function normalizePhone(phoneNumber) {
  if (!phoneNumber) return '';
  let phone = String(phoneNumber).trim().split('@')[0].split(':')[0].replace(/\D/g, '');
  // Móvil chileno sin código de país: 9 dígitos empezando en 9
  if (/^9\d{8}$/.test(phone)) phone = '56' + phone;
  return phone;
}

// Partículas que van en minúscula en nombres hispanohablantes
const NAME_LOWERCASE_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'van', 'von', 'di', 'da', 'do']);

/**
 * Normaliza un nombre a Title Case inteligente.
 * - "JUAN PÉREZ" → "Juan Pérez"
 * - "juan de la vega" → "Juan de la Vega"
 * - "  maría   josé  " → "María José"
 * - null/'' → null
 */
function normalizeName(name) {
  if (!name) return null;
  const clean = String(name).trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  // Si tiene mezcla de mayúsculas y minúsculas ya, no tocar (ej: "iPhone")
  // Solo normalizar si está todo en mayúsculas o todo en minúsculas
  const upper = clean === clean.toUpperCase();
  const lower = clean === clean.toLowerCase();
  if (!upper && !lower) return clean; // ya está formateado
  return clean
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      if (i > 0 && NAME_LOWERCASE_PARTICLES.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// ─── CONVERSATIONS ────────────────────────────────────────────────

// One customer identity per organization and normalized phone, across channels.
// CRM names take precedence over provider profile aliases.
function identityPhoneSql(column) {
  const digits = `REGEXP_REPLACE(${column}, '[^0-9]', '', 'g')`;
  return `(CASE WHEN ${digits} ~ '^9[0-9]{8}$' THEN '56' || ${digits} ELSE ${digits} END)`;
}
function usableNameSql(column) {
  return `NULLIF(BTRIM(${column}), '') IS NOT NULL AND LOWER(BTRIM(${column})) <> 'cliente' AND ${column} !~ '^[+0-9 ()-]+$'`;
}
function customerIdentityJoin() {
  return `LEFT JOIN LATERAL (
    SELECT contact.name, contact.client_type,
      (SELECT note_contact.notes FROM contacts note_contact
        WHERE note_contact.organization_id = c.organization_id
          AND ${identityPhoneSql('note_contact.phone')} = ${identityPhoneSql('c.phone_number')}
          AND NULLIF(BTRIM(note_contact.notes), '') IS NOT NULL
        ORDER BY (note_contact.phone = ${identityPhoneSql('c.phone_number')}) DESC, note_contact.id DESC
        LIMIT 1) AS notes
    FROM contacts contact
    WHERE contact.organization_id = c.organization_id
      AND ${identityPhoneSql('contact.phone')} = ${identityPhoneSql('c.phone_number')}
    ORDER BY (${usableNameSql('contact.name')}) DESC NULLS LAST,
      (contact.phone = ${identityPhoneSql('c.phone_number')}) DESC, contact.id DESC
    LIMIT 1
  ) co ON TRUE`;
}
const customerNameSql = `CASE WHEN ${usableNameSql('co.name')} THEN co.name ELSE c.contact_name END`;

async function savedCustomerName(orgId, phone) {
  const customer = await queryOne(
    `SELECT name FROM contacts WHERE organization_id = $1
      AND ${identityPhoneSql('phone')} = $2 AND ${usableNameSql('name')}
      ORDER BY (phone = $2) DESC, id DESC LIMIT 1`, [orgId, phone]
  );
  return customer?.name || null;
}

async function upsertConversation(orgId, phoneNumber, contactName = null, whatsappChannelId = null) {
  // Normalizar: siempre con código de país, sin "+"
  const phone = normalizePhone(phoneNumber);

  const existing = await queryOne(
    'SELECT * FROM conversations WHERE organization_id = $1 AND phone_number = $2 AND whatsapp_channel_id IS NOT DISTINCT FROM $3',
    [orgId, phone, whatsappChannelId]
  );

  const isGenericName = n => !n || !n.trim() || n.trim().toLowerCase() === 'cliente' || /^[+0-9 ()-]+$/.test(n);
  const customerName = await savedCustomerName(orgId, phone);
  const resolvedName = customerName || (isGenericName(contactName) ? null : normalizeName(contactName));

  if (existing) {
    const existingIsGeneric = isGenericName(existing.contact_name);
    if (resolvedName && (existingIsGeneric || resolvedName !== existing.contact_name)) {
      await pool.query(
        'UPDATE conversations SET contact_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND organization_id = $3',
        [resolvedName, existing.id, orgId]
      );
    }
  } else {
    await queryOne(
      `INSERT INTO conversations (organization_id, phone_number, contact_name, whatsapp_channel_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, phone, resolvedName || phone, whatsappChannelId]
    );
  }

  // Siempre sincronizar el contacto (contacts es la fuente de verdad del phone)
  try {
    await pool.query(
      `INSERT INTO contacts (organization_id, phone, name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (organization_id, phone) DO UPDATE SET
         name       = CASE WHEN ${usableNameSql('contacts.name')} THEN contacts.name ELSE $3 END,
         updated_at = NOW()`,
      [orgId, phone, resolvedName]
    );
  } catch (_) {}

  return queryOne(
    'SELECT * FROM conversations WHERE organization_id = $1 AND phone_number = $2 AND whatsapp_channel_id IS NOT DISTINCT FROM $3',
    [orgId, phone, whatsappChannelId]
  );
}

async function getAllConversations(orgId, { unreadOnly = false } = {}) {
  const where = unreadOnly
    ? 'c.organization_id = $1 AND c.unread_count > 0'
    : 'c.organization_id = $1';
  // Resolve the saved customer name consistently without merging channel conversations.
  return query(
    `SELECT * FROM (
       SELECT DISTINCT ON (c.id)
         c.*,
         ${customerNameSql} AS contact_name,
         co.notes AS contact_notes,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM contacts co_type
              WHERE co_type.organization_id = c.organization_id
                AND co_type.client_type = 'empresa'
                AND co_type.phone = ANY(ARRAY[
                  c.phone_number,
                  CASE WHEN c.phone_number ~ '^9[0-9]{8}$' THEN '56' || c.phone_number END,
                  CASE WHEN c.phone_number ~ '^569[0-9]{8}$' THEN SUBSTRING(c.phone_number FROM 3) END,
                  CASE WHEN c.phone_number LIKE '+%' THEN SUBSTRING(c.phone_number FROM 2) END,
                  '+' || c.phone_number
                ])
           ) THEN 'empresa'
           ELSE COALESCE(co.client_type, 'personal')
         END AS client_type,
         COALESCE(wc.name,
           CASE WHEN cfg.provider = 'kapso' THEN 'WhatsApp Oficial (Kapso)' ELSE 'WhatsApp Oficial' END
         ) AS whatsapp_channel_name,
         COALESCE(wc.phone_number, cfg.display_phone_number, cfg.twilio_phone_number) AS whatsapp_channel_phone,
         COALESCE(wc.provider, cfg.provider, 'meta') AS whatsapp_provider
       FROM conversations c
       LEFT JOIN whatsapp_channels wc ON wc.id = c.whatsapp_channel_id
       LEFT JOIN whatsapp_configs cfg ON cfg.organization_id = c.organization_id
       ${customerIdentityJoin()}
       WHERE ${where}
         AND NOT (
           COALESCE(wc.provider, cfg.provider, '') = 'evolution'
           AND NOT EXISTS (SELECT 1 FROM messages ghost_message WHERE ghost_message.conversation_id = c.id)
           AND (
             c.contact_name ~* '@(s\\.whatsapp\\.net|lid)$'
             OR ${identityPhoneSql('c.phone_number')} = ${identityPhoneSql('wc.phone_number')}
           )
         )
       ORDER BY c.id, c.last_message_at DESC
     ) sub
     ORDER BY is_pinned DESC, pinned_at DESC NULLS LAST, last_message_at DESC`,
    [orgId]
  );
}

async function getConversationById(id, orgId = null) {
  const select = `SELECT c.*, ${customerNameSql} AS contact_name, co.notes AS contact_notes,
      COALESCE(wc.name, CASE WHEN cfg.provider = 'kapso' THEN 'WhatsApp Oficial (Kapso)' ELSE 'WhatsApp Oficial' END) AS whatsapp_channel_name,
      COALESCE(wc.phone_number, cfg.display_phone_number, cfg.twilio_phone_number) AS whatsapp_channel_phone,
      COALESCE(wc.provider, cfg.provider, 'meta') AS whatsapp_provider
    FROM conversations c
    LEFT JOIN whatsapp_channels wc ON wc.id = c.whatsapp_channel_id
    LEFT JOIN whatsapp_configs cfg ON cfg.organization_id = c.organization_id
    ${customerIdentityJoin()}`;
  if (orgId) {
    return queryOne(`${select} WHERE c.id = $1 AND c.organization_id = $2`, [id, orgId]);
  }
  return queryOne(`${select} WHERE c.id = $1`, [id]);
}

async function setConversationPinned(id, orgId, pinned) {
  const updated = await queryOne(
    `UPDATE conversations
        SET is_pinned = $3,
            pinned_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1 AND organization_id = $2
      RETURNING id`,
    [id, orgId, !!pinned]
  );
  return updated ? getConversationById(id, orgId) : null;
}

async function setCustomerNote(orgId, phone, note) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : null;

  await pool.query(
    `INSERT INTO contacts (organization_id, phone, notes, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (organization_id, phone) DO UPDATE SET
       notes = EXCLUDED.notes,
       updated_at = NOW()`,
    [orgId, normalizedPhone, cleanNote]
  );
  await pool.query(
    `UPDATE contacts SET notes = $3, updated_at = NOW()
      WHERE organization_id = $1
        AND ${identityPhoneSql('phone')} = $2`,
    [orgId, normalizedPhone, cleanNote]
  );
  return cleanNote;
}

async function updateConversationLastMessage(id, message, incrementUnread = false) {
  if (incrementUnread) {
    await pool.query(
      `UPDATE conversations SET last_message = $1, last_message_at = CURRENT_TIMESTAMP, unread_count = unread_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [message, id]
    );
  } else {
    await pool.query(
      `UPDATE conversations SET last_message = $1, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [message, id]
    );
  }
}

async function updateLastInbound(id) {
  // Resetear follow_up_sent_at cuando el cliente escribe — el timer empieza desde cero.
  // Esto evita que el bot siga siguiendo indefinidamente después de que el cliente responde.
  await pool.query(
    'UPDATE conversations SET last_inbound_at = CURRENT_TIMESTAMP, follow_up_sent_at = NULL WHERE id = $1',
    [id]
  );
}

async function updateFollowUpSent(id) {
  await pool.query(
    'UPDATE conversations SET follow_up_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id]
  );
}

/**
 * Busca conversaciones abandonadas dentro de la ventana de 24h.
 * Criterios: cliente escribió hace 2-22h, bot estaba activo, sin follow-up reciente.
 */
async function getStalledConversations() {
  const { rows } = await pool.query(`
    SELECT
      c.id, c.organization_id, c.phone_number, c.contact_name,
      c.pipeline_state, c.order_draft, c.last_inbound_at,
      c.follow_up_sent_at, c.agent_mode,
      o.name AS org_name
    FROM conversations c
    JOIN organizations o ON o.id = c.organization_id
    WHERE
      c.agent_mode    = 'ai'
      AND c.pipeline_state IN ('interested', 'collecting_order')
      AND c.last_inbound_at IS NOT NULL
      AND c.last_inbound_at < NOW() - INTERVAL '4 hours'
      AND c.last_inbound_at > NOW() - INTERVAL '20 hours'
      AND (c.follow_up_sent_at IS NULL OR c.follow_up_sent_at < NOW() - INTERVAL '16 hours')
      -- No mandar follow-up si ya existe un pedido activo (no cancelado) en las últimas 48h
      AND NOT EXISTS (
        SELECT 1 FROM orders o2
        WHERE o2.conversation_id = c.id
          AND o2.status NOT IN ('cancelled')
          AND o2.created_at > NOW() - INTERVAL '48 hours'
      )
      -- No mandar follow-up si ya hay un comprobante de pago reciente
      AND NOT EXISTS (
        SELECT 1 FROM payment_proofs pp
        WHERE pp.conversation_id = c.id
          AND pp.created_at > NOW() - INTERVAL '48 hours'
      )
  `);
  return rows;
}

async function markConversationAsRead(id) {
  await pool.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);
}

async function setAgentMode(id, mode) {
  await pool.query(
    `UPDATE conversations
        SET agent_mode = $1,
            agent_mode_changed_at = CURRENT_TIMESTAMP,
            human_pending_notified_at = CASE WHEN $1 IN ('ai','human') THEN NULL ELSE human_pending_notified_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
    [mode, id]
  );
}

async function claimHumanPendingNotification(conversationId, cooldownMinutes = 5) {
  const row = await queryOne(
    `UPDATE conversations
        SET human_pending_notified_at = NOW()
      WHERE id = $1
        AND agent_mode = 'human'
        AND (
          human_pending_notified_at IS NULL
          OR human_pending_notified_at < NOW() - ($2::int || ' minutes')::interval
        )
      RETURNING id`,
    [conversationId, cooldownMinutes]
  );
  return !!row;
}

async function updatePipelineState(id, state, orderDraft = null) {
  if (orderDraft !== null) {
    await pool.query(
      'UPDATE conversations SET pipeline_state = $1, order_draft = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [state, JSON.stringify(orderDraft), id]
    );
  } else {
    await pool.query(
      'UPDATE conversations SET pipeline_state = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [state, id]
    );
  }
}

async function getOrderDraft(id) {
  const conv = await queryOne('SELECT order_draft FROM conversations WHERE id = $1', [id]);
  try { return JSON.parse(conv?.order_draft || '{}'); } catch { return {}; }
}

/**
 * Intenta cambiar pipeline_state de 'collecting_order' → 'done' de forma atómica.
 * Retorna true si lo logró (este proceso crea el pedido), false si ya lo hizo otro.
 * Previene pedidos duplicados cuando dos mensajes llegan casi simultáneamente.
 */
async function claimOrderCreation(conversationId) {
  // Verificar si ya existe un pedido para esta conversación en los últimos 10 minutos
  // Esto evita duplicados cuando el pipeline se ejecuta dos veces seguidas
  const { rows: recentOrders } = await pool.query(
    `SELECT id FROM orders
     WHERE conversation_id = $1
       AND created_at > NOW() - INTERVAL '10 minutes'
     LIMIT 1`,
    [conversationId]
  );
  if (recentOrders.length > 0) return false; // ya existe un pedido reciente

  const { rowCount } = await pool.query(
    `UPDATE conversations
     SET pipeline_state = 'done', updated_at = NOW()
     WHERE id = $1 AND pipeline_state = 'collecting_order'`,
    [conversationId]
  );
  return rowCount > 0; // true = ganamos el lock, false = ya lo creó otro proceso
}

// ─── SCHEDULED ORDERS ─────────────────────────────────────────────

async function createScheduledOrder({ orgId, conversationId, phone, customerName, productNotes, desiredDate, templateName }) {
  // Cancelar cualquier pedido agendado pendiente anterior de esta conversación
  // antes de crear uno nuevo (evita que el cron dispare el viejo y el nuevo)
  await pool.query(
    `UPDATE scheduled_orders SET status = 'cancelled'
     WHERE conversation_id = $1 AND status = 'pending'`,
    [conversationId]
  );
  const { rows: [row] } = await pool.query(
    `INSERT INTO scheduled_orders
       (organization_id, conversation_id, phone, customer_name, product_notes, desired_date, template_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [orgId, conversationId, phone, customerName || null, productNotes || null, desiredDate, templateName || null]
  );
  return row;
}

/**
 * Trae los pedidos agendados pendientes cuya fecha ya llegó (desired_date <= HOY).
 * @param {number|null} orgId - si null, trae de todas las orgs
 */
async function getPendingScheduledOrders(orgId = null) {
  // Excluir pedidos creados en los últimos 60 minutos: la conversación puede
  // seguir activa y el bot ya respondió en ella — no enviar template encima.
  const { rows } = await pool.query(
    `SELECT so.*, o.name AS org_name
     FROM scheduled_orders so
     JOIN organizations o ON o.id = so.organization_id
     WHERE so.status = 'pending'
       AND so.desired_date <= CURRENT_DATE
       AND so.created_at < NOW() - INTERVAL '60 minutes'
       ${orgId ? 'AND so.organization_id = $1' : ''}
     ORDER BY so.desired_date ASC`,
    orgId ? [orgId] : []
  );
  return rows;
}

async function markScheduledOrderSent(id) {
  await pool.query(
    `UPDATE scheduled_orders SET status = 'sent', sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

async function cancelScheduledOrder(id) {
  await pool.query(
    `UPDATE scheduled_orders SET status = 'cancelled' WHERE id = $1`,
    [id]
  );
}

// ─── MESSAGES ─────────────────────────────────────────────────────

async function saveMessage({ conversationId, whatsappMessageId, direction, content, type = 'text', status = null, sentBy = 'ai', agentType = null, mediaId = null }) {
  status = status || (direction === 'outbound' && (type === 'template' || content?.startsWith('[Template:')) ? 'pending' : 'sent');
  try {
    return await queryOne(
      `INSERT INTO messages (conversation_id, whatsapp_message_id, direction, content, type, status, sent_by, agent_type, media_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (whatsapp_message_id) DO UPDATE SET
         sent_by = EXCLUDED.sent_by, agent_type = EXCLUDED.agent_type
       WHERE messages.conversation_id = EXCLUDED.conversation_id
         AND messages.direction = 'outbound' AND EXCLUDED.direction = 'outbound'
         AND messages.sent_by = 'human' AND EXCLUDED.sent_by = 'ai'
       RETURNING *`,
      [conversationId, whatsappMessageId || null, direction, content, type, status, sentBy, agentType, mediaId || null]
    );
  } catch (err) {
    if (err.code === '23505') return null; // fallback por si acaso
    throw err;
  }
}

async function getMessageByWhatsappId(orgId, whatsappMessageId) {
  if (!orgId || !whatsappMessageId) return null;
  return queryOne(
    `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.organization_id = $1 AND m.whatsapp_message_id = $2
      LIMIT 1`,
    [orgId, whatsappMessageId]
  );
}

async function saveWhatsappAttribution({ organizationId, conversationId, messageId = null, whatsappMessageId, provider, attribution, receivedAt = null }) {
  if (!organizationId || !conversationId || !whatsappMessageId || !provider || !attribution) return null;
  const saved = await queryOne(
    `INSERT INTO whatsapp_attributions (
       organization_id, conversation_id, message_id, whatsapp_message_id, provider,
       source_type, source_id, source_url, ctwa_clid, headline, body, media_type, media_url,
       campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, raw_json,
       first_seen_at, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$21)
     ON CONFLICT (organization_id, provider, whatsapp_message_id) DO UPDATE SET
       conversation_id = EXCLUDED.conversation_id,
       message_id = COALESCE(EXCLUDED.message_id, whatsapp_attributions.message_id),
       source_type = COALESCE(EXCLUDED.source_type, whatsapp_attributions.source_type),
       source_id = COALESCE(EXCLUDED.source_id, whatsapp_attributions.source_id),
       source_url = COALESCE(EXCLUDED.source_url, whatsapp_attributions.source_url),
       ctwa_clid = COALESCE(EXCLUDED.ctwa_clid, whatsapp_attributions.ctwa_clid),
       headline = COALESCE(EXCLUDED.headline, whatsapp_attributions.headline),
       body = COALESCE(EXCLUDED.body, whatsapp_attributions.body),
       media_type = COALESCE(EXCLUDED.media_type, whatsapp_attributions.media_type),
       media_url = COALESCE(EXCLUDED.media_url, whatsapp_attributions.media_url),
       campaign_id = COALESCE(EXCLUDED.campaign_id, whatsapp_attributions.campaign_id),
       campaign_name = COALESCE(EXCLUDED.campaign_name, whatsapp_attributions.campaign_name),
       adset_id = COALESCE(EXCLUDED.adset_id, whatsapp_attributions.adset_id),
       adset_name = COALESCE(EXCLUDED.adset_name, whatsapp_attributions.adset_name),
       ad_id = COALESCE(EXCLUDED.ad_id, whatsapp_attributions.ad_id),
       ad_name = COALESCE(EXCLUDED.ad_name, whatsapp_attributions.ad_name),
       raw_json = EXCLUDED.raw_json,
       first_seen_at = LEAST(whatsapp_attributions.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(whatsapp_attributions.last_seen_at, EXCLUDED.last_seen_at)
     RETURNING *`,
    [organizationId, conversationId, messageId, whatsappMessageId, provider,
      attribution.sourceType, attribution.sourceId, attribution.sourceUrl, attribution.ctwaClid,
      attribution.headline, attribution.body, attribution.mediaType, attribution.mediaUrl,
      attribution.campaignId, attribution.campaignName, attribution.adsetId, attribution.adsetName,
      attribution.adId, attribution.adName, JSON.stringify(attribution.raw || attribution), receivedAt || new Date()]
  );
  await pool.query(
    `UPDATE conversations SET
       attribution_source_type = $3, attribution_source_id = $4,
       attribution_source_url = $5, attribution_headline = $6,
       attribution_campaign_id = $7, attribution_campaign_name = $8,
       attribution_ad_id = $9, attribution_ad_name = $10,
       attribution_first_seen_at = COALESCE(attribution_first_seen_at, $11),
       updated_at = NOW()
     WHERE id = $1 AND organization_id = $2`,
    [conversationId, organizationId, attribution.sourceType, attribution.sourceId,
      attribution.sourceUrl, attribution.headline, attribution.campaignId,
      attribution.campaignName, attribution.adId, attribution.adName, receivedAt || new Date()]
  );
  return saved;
}

async function getLatestWhatsappAttribution(orgId, conversationId) {
  return queryOne(
    `SELECT * FROM whatsapp_attributions
      WHERE organization_id = $1 AND conversation_id = $2
      ORDER BY last_seen_at DESC, id DESC LIMIT 1`,
    [orgId, conversationId]
  );
}

async function getWhatsappAttributionReport(orgId, { from = null, to = null, provider = null } = {}) {
  const params = [orgId];
  const where = ['wa.organization_id = $1'];
  if (from) { params.push(from); where.push(`wa.first_seen_at >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`wa.first_seen_at < ($${params.length}::date + INTERVAL '1 day')`); }
  if (provider) { params.push(provider); where.push(`wa.provider = $${params.length}`); }
  const filtered = `
    SELECT wa.*, c.contact_name, c.phone_number,
           COALESCE(wa.campaign_id, wa.source_id, wa.source_url, wa.headline, 'whatsapp') AS campaign_key,
           CASE WHEN wa.campaign_id IS NOT NULL OR wa.ad_id IS NOT NULL OR wa.ctwa_clid IS NOT NULL
                THEN 'exacta' ELSE 'parcial' END AS precision
      FROM whatsapp_attributions wa
      JOIN conversations c ON c.id = wa.conversation_id
     WHERE ${where.join(' AND ')}`;
  const orderAmount = `CASE
    WHEN TRIM(o.total_price) ~ '^[^0-9]*[0-9]{1,3}([.][0-9]{3})+[^0-9]*$'
      THEN COALESCE(NULLIF(regexp_replace(o.total_price, '[^0-9-]', '', 'g'), '')::numeric, 0)
    ELSE COALESCE(NULLIF(regexp_replace(o.total_price, '[^0-9.-]', '', 'g'), '')::numeric, 0)
  END`;
  const summary = await query(
    `WITH filtered AS (${filtered}),
     campaigns AS (
       SELECT provider, campaign_key,
              MAX(COALESCE(campaign_name, ad_name, headline, 'Campaña de WhatsApp')) AS campaign_name,
              MAX(adset_name) AS adset_name, MAX(ad_name) AS ad_name,
              MAX(source_url) AS source_url,
              CASE WHEN BOOL_OR(precision = 'exacta') THEN 'exacta' ELSE 'parcial' END AS precision,
              COUNT(DISTINCT conversation_id)::int AS contacts,
              MIN(first_seen_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at
         FROM filtered GROUP BY provider, campaign_key
     ), order_matches AS (
       SELECT DISTINCT ON (o.id) f.provider, f.campaign_key, o.id,
              ${orderAmount} AS amount
         FROM filtered f JOIN orders o ON o.conversation_id = f.conversation_id
          AND o.created_at >= f.first_seen_at AND COALESCE(o.status, '') <> 'cancelled'
        ORDER BY o.id, f.first_seen_at DESC
     )
     SELECT c.*, COUNT(om.id)::int AS orders,
            COALESCE(SUM(om.amount), 0)::numeric AS revenue,
            ROUND(CASE WHEN c.contacts > 0 THEN COUNT(om.id)::numeric * 100 / c.contacts ELSE 0 END, 1) AS conversion_rate
       FROM campaigns c LEFT JOIN order_matches om
         ON om.provider = c.provider AND om.campaign_key = c.campaign_key
      GROUP BY c.provider, c.campaign_key, c.campaign_name, c.adset_name, c.ad_name,
               c.source_url, c.precision, c.contacts, c.first_seen_at, c.last_seen_at
      ORDER BY c.last_seen_at DESC`, params);
  const records = await query(
    `WITH filtered AS (${filtered}), latest AS (
       SELECT DISTINCT ON (conversation_id, campaign_key)
              * FROM filtered ORDER BY conversation_id, campaign_key, first_seen_at DESC
     ), order_matches AS (
       SELECT DISTINCT ON (o.id) f.conversation_id, f.campaign_key, o.id,
              ${orderAmount} AS amount
         FROM filtered f JOIN orders o ON o.conversation_id = f.conversation_id
          AND o.created_at >= f.first_seen_at AND COALESCE(o.status, '') <> 'cancelled'
        ORDER BY o.id, f.first_seen_at DESC
     )
     SELECT l.id, l.conversation_id, l.contact_name, l.phone_number, l.provider,
            l.source_type, l.source_id, l.source_url, l.headline, l.body,
            l.campaign_id, l.campaign_name, l.adset_name, l.ad_id, l.ad_name,
            l.precision, l.first_seen_at, l.last_seen_at,
            COUNT(DISTINCT o.id)::int AS orders,
            COALESCE(SUM(o.amount), 0)::numeric AS revenue
       FROM latest l LEFT JOIN order_matches o ON o.conversation_id = l.conversation_id
        AND o.campaign_key = l.campaign_key
      GROUP BY l.id, l.conversation_id, l.contact_name, l.phone_number, l.provider,
               l.source_type, l.source_id, l.source_url, l.headline, l.body,
               l.campaign_id, l.campaign_name, l.adset_name, l.ad_id, l.ad_name,
               l.precision, l.first_seen_at, l.last_seen_at
      ORDER BY l.first_seen_at DESC`, params);
  const totals = await queryOne(
    `WITH filtered AS (${filtered}), order_matches AS (
       SELECT DISTINCT ON (o.id) o.id,
              ${orderAmount} AS amount
         FROM filtered f JOIN orders o ON o.conversation_id = f.conversation_id
          AND o.created_at >= f.first_seen_at AND COALESCE(o.status, '') <> 'cancelled'
        ORDER BY o.id, f.first_seen_at DESC
     )
     SELECT (SELECT COUNT(DISTINCT conversation_id) FROM filtered)::int AS contacts,
            COUNT(order_matches.id)::int AS orders,
            COALESCE(SUM(order_matches.amount), 0)::numeric AS revenue
       FROM order_matches`, params);
  totals.conversionRate = totals.contacts ? Math.round(Number(totals.orders) * 1000 / Number(totals.contacts)) / 10 : 0;
  return { summary, records, totals };
}

async function getWhatsappBuyerReport(orgId, { from = null, to = null, provider = null } = {}) {
  const params = [orgId];
  const attributionWhere = ['wa.organization_id = $1'];
  if (provider) {
    params.push(provider);
    attributionWhere.push(`wa.provider = $${params.length}`);
  }
  const orderWhere = ["COALESCE(o.status, '') <> 'cancelled'"];
  const localOrderDate = `(o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date`;
  if (from) {
    params.push(from);
    orderWhere.push(`${localOrderDate} >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    orderWhere.push(`${localOrderDate} <= $${params.length}::date`);
  }
  const orderAmount = `CASE
    WHEN TRIM(o.total_price) ~ '^[^0-9]*[0-9]{1,3}([.][0-9]{3})+[^0-9]*$'
      THEN COALESCE(NULLIF(regexp_replace(o.total_price, '[^0-9-]', '', 'g'), '')::numeric, 0)
    ELSE COALESCE(NULLIF(regexp_replace(o.total_price, '[^0-9.-]', '', 'g'), '')::numeric, 0)
  END`;
  const matched = `
    SELECT DISTINCT ON (o.id)
           wa.id AS attribution_id, wa.conversation_id, wa.provider, wa.source_type,
           wa.source_id, wa.source_url, wa.ctwa_clid, wa.headline, wa.body,
           wa.campaign_id, wa.campaign_name, wa.adset_name, wa.ad_id, wa.ad_name,
           wa.first_seen_at, wa.last_seen_at,
           c.contact_name, c.phone_number,
           COALESCE(wa.campaign_id, wa.source_id, wa.source_url, wa.headline, 'whatsapp') AS campaign_key,
           CASE WHEN wa.campaign_id IS NOT NULL OR wa.ad_id IS NOT NULL OR wa.ctwa_clid IS NOT NULL
                THEN 'exacta' ELSE 'parcial' END AS precision,
           o.id AS order_id, o.created_at AS order_created_at, o.status AS order_status,
           o.items AS order_items, ${orderAmount} AS amount
      FROM whatsapp_attributions wa
      JOIN conversations c ON c.id = wa.conversation_id AND c.organization_id = wa.organization_id
      JOIN orders o ON o.organization_id = wa.organization_id
                   AND o.conversation_id = wa.conversation_id
                   AND (o.created_at AT TIME ZONE 'UTC') >= wa.first_seen_at
     WHERE ${attributionWhere.join(' AND ')} AND ${orderWhere.join(' AND ')}
     ORDER BY o.id, wa.first_seen_at DESC, wa.id DESC`;

  const summary = await query(
    `WITH matched AS (${matched})
     SELECT provider, campaign_key,
            MAX(COALESCE(campaign_name, ad_name, headline, 'Campaña de WhatsApp')) AS campaign_name,
            MAX(adset_name) AS adset_name, MAX(ad_name) AS ad_name, MAX(source_url) AS source_url,
            CASE WHEN BOOL_OR(precision = 'exacta') THEN 'exacta' ELSE 'parcial' END AS precision,
            COUNT(DISTINCT conversation_id)::int AS contacts,
            COUNT(DISTINCT order_id)::int AS orders,
            COALESCE(SUM(amount), 0)::numeric AS revenue,
            MIN(first_seen_at) AS first_seen_at, MAX(order_created_at) AS last_order_at,
            ROUND(CASE WHEN COUNT(DISTINCT conversation_id) > 0
              THEN COUNT(DISTINCT order_id)::numeric / COUNT(DISTINCT conversation_id) ELSE 0 END, 1) AS orders_per_buyer
       FROM matched
      GROUP BY provider, campaign_key
      ORDER BY last_order_at DESC`, params);

  const records = await query(
    `WITH matched AS (${matched})
     SELECT MIN(attribution_id) AS id, conversation_id, provider, campaign_key,
            MAX(contact_name) AS contact_name, MAX(phone_number) AS phone_number,
            MAX(source_type) AS source_type, MAX(source_id) AS source_id,
            MAX(source_url) AS source_url, MAX(headline) AS headline, MAX(body) AS body,
            MAX(campaign_id) AS campaign_id,
            MAX(COALESCE(campaign_name, ad_name, headline, 'Campaña de WhatsApp')) AS campaign_name,
            MAX(adset_name) AS adset_name, MAX(ad_id) AS ad_id, MAX(ad_name) AS ad_name,
            CASE WHEN BOOL_OR(precision = 'exacta') THEN 'exacta' ELSE 'parcial' END AS precision,
            MIN(first_seen_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at,
            COUNT(DISTINCT order_id)::int AS orders,
            COALESCE(SUM(amount), 0)::numeric AS revenue,
            MAX(order_created_at) AS last_order_at,
            (ARRAY_AGG(order_status ORDER BY order_created_at DESC, order_id DESC))[1] AS last_order_status,
            (ARRAY_AGG(order_items ORDER BY order_created_at DESC, order_id DESC))[1] AS latest_order_items
       FROM matched
      GROUP BY conversation_id, provider, campaign_key
      ORDER BY last_order_at DESC`, params);

  const totals = await queryOne(
    `WITH matched AS (${matched})
     SELECT COUNT(DISTINCT conversation_id)::int AS contacts,
            COUNT(DISTINCT order_id)::int AS orders,
            COALESCE(SUM(amount), 0)::numeric AS revenue
       FROM matched`, params);
  totals.buyers = totals.contacts;
  totals.ordersPerBuyer = totals.contacts
    ? Math.round(Number(totals.orders) * 10 / Number(totals.contacts)) / 10
    : 0;
  return { summary, records, totals, basis: 'purchase' };
}

async function saveAdAttribution({ organizationId, conversationId, messageId, referral }) {
  if (!organizationId || !conversationId || !messageId || !referral) return null;
  return queryOne(
    `INSERT INTO ad_conversation_attributions
       (organization_id, conversation_id, message_id, provider, source_type, source_id,
        ctwa_clid, source_url, headline, body, raw_payload, attributed_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,m.created_at AT TIME ZONE 'UTC'
       FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=$3 AND c.id=$2 AND c.organization_id=$1
     ON CONFLICT (message_id) DO NOTHING
     RETURNING *`,
    [organizationId, conversationId, messageId, referral.provider || 'meta', referral.sourceType || null,
      referral.sourceId || null, referral.ctwaClid || null, referral.sourceUrl || null,
      referral.headline || null, referral.body || null, JSON.stringify(referral.raw || {})]
  );
}

async function saveMessageMediaBlob(orgId, messageId, data, contentType) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (!orgId || !messageId || !buffer.length || buffer.length > 16 * 1024 * 1024) return null;
  return queryOne(
    `INSERT INTO message_media_blobs (message_id, organization_id, content_type, data)
     SELECT m.id, c.organization_id, $3, $4
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $2 AND c.organization_id = $1
     ON CONFLICT (message_id) DO UPDATE SET
       content_type = EXCLUDED.content_type,
       data = EXCLUDED.data
     RETURNING message_id, organization_id, content_type`,
    [orgId, messageId, String(contentType || 'application/octet-stream'), buffer]
  );
}

async function getMessageMediaBlob(orgId, messageId) {
  return queryOne(
    `SELECT content_type, data
       FROM message_media_blobs
      WHERE organization_id = $1 AND message_id = $2`,
    [orgId, messageId]
  );
}

async function getMessagesByConversation(conversationId, limit = 80) {
  // Traer los N más recientes (DESC) y luego invertir para mostrar en orden cronológico (ASC)
  const rows = await query(
    `SELECT m.*,
            c.whatsapp_channel_id,
            COALESCE(wc.name, CASE WHEN cfg.provider = 'kapso' THEN 'WhatsApp Oficial (Kapso)' ELSE 'WhatsApp Oficial' END) AS whatsapp_channel_name,
            COALESCE(wc.phone_number, cfg.display_phone_number, cfg.twilio_phone_number) AS business_phone_number,
            COALESCE(wc.provider, cfg.provider, 'meta') AS whatsapp_provider
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN whatsapp_channels wc ON wc.id = c.whatsapp_channel_id
       LEFT JOIN whatsapp_configs cfg ON cfg.organization_id = c.organization_id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse();
}

async function getMessagesByCustomerPhone(orgId, phoneNumber, limit = 80, excludePersonal = false) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return [];
  const rows = await query(
    `SELECT recent.* FROM (
       SELECT m.*,
              c.whatsapp_channel_id,
              wc.name AS whatsapp_channel_name,
              wc.phone_number AS whatsapp_channel_phone,
              CASE WHEN c.whatsapp_channel_id IS NULL THEN COALESCE(cfg.provider, 'meta') ELSE wc.provider END AS whatsapp_provider,
              CASE WHEN c.whatsapp_channel_id IS NULL THEN cfg.display_phone_number ELSE wc.phone_number END AS business_phone_number
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN whatsapp_channels wc ON wc.id = c.whatsapp_channel_id
         LEFT JOIN whatsapp_configs cfg ON cfg.organization_id = c.organization_id
        WHERE c.organization_id = $1
          AND (NOT $4::boolean OR wc.assigned_user_id IS NULL)
          AND regexp_replace(COALESCE(c.phone_number, ''), '[^0-9]', '', 'g') = $2
        ORDER BY m.created_at DESC
        LIMIT $3
     ) recent
     ORDER BY recent.created_at ASC`,
    [orgId, normalized, limit, excludePersonal]
  );
  return rows;
}


async function getLastMessages(conversationId, limit = 10) {
  const rows = await query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [conversationId, limit]
  );
  return rows.reverse();
}

async function updateMessageStatus(whatsappMessageId, status, error = null, orgId) {
  if (!orgId || !['sent', 'delivered', 'read', 'failed'].includes(status)) return null;
  const raw = Array.isArray(error) ? error[0] : error;
  const detail = raw ? {
    code: raw.code ?? null,
    message: String(raw.error_data?.details || raw.message || raw.title || (typeof raw === 'string' ? raw : 'Error del proveedor')).slice(0, 1000),
  } : null;
  return queryOne(
    `UPDATE messages m SET status = $1, delivery_error = $3::jsonb
       FROM conversations c
      WHERE m.whatsapp_message_id = $2 AND c.id = m.conversation_id AND c.organization_id = $4
        AND (m.status = $1 OR m.status = 'pending'
          OR (m.status = 'sent' AND $1 IN ('delivered','read','failed'))
          OR (m.status = 'delivered' AND $1 = 'read'))
      RETURNING m.*`,
    [status, whatsappMessageId, status === 'failed' ? JSON.stringify(detail) : null, orgId]
  );
}

/**
 * Devuelve cuántos minutos hace que un humano envió el último mensaje en esta conversación.
 * Si nunca hubo respuesta humana, devuelve Infinity.
 */
async function minutesSinceLastHumanReply(conversationId) {
  const row = await queryOne(
    `SELECT created_at FROM messages
     WHERE conversation_id = $1 AND direction = 'outbound' AND sent_by = 'human'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  if (!row?.created_at) return Infinity;
  return (Date.now() - new Date(row.created_at).getTime()) / 1000 / 60;
}

// ─── PRODUCTS CACHE ───────────────────────────────────────────────

async function cacheProducts(orgId, dataSourceId, products) {
  for (const p of products) {
    await pool.query(
      `INSERT INTO products_cache (organization_id, data_source_id, external_id, title, description, price, compare_at_price, sku, inventory_quantity, image_url, tags, product_type, handle, raw_json, cached_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id, data_source_id, external_id) DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description, price = EXCLUDED.price,
         compare_at_price = EXCLUDED.compare_at_price, sku = EXCLUDED.sku,
         inventory_quantity = EXCLUDED.inventory_quantity, image_url = EXCLUDED.image_url,
         tags = EXCLUDED.tags, product_type = EXCLUDED.product_type,
         handle = EXCLUDED.handle, raw_json = EXCLUDED.raw_json, cached_at = CURRENT_TIMESTAMP`,
      [
        orgId, dataSourceId,
        p.externalId, p.title, p.description, p.price, p.compareAtPrice,
        p.sku, p.inventoryQuantity, p.imageUrl, p.tags, p.productType, p.handle, p.rawJson,
      ]
    );
  }
}

async function getCachedProducts(orgId) {
  const rows = await query('SELECT * FROM products_cache WHERE organization_id = $1 ORDER BY title ASC', [orgId]);
  const weight = await getSetting(orgId, 'goat_cheese_weight');
  return weight ? rows.map(row => require('../services/catalog-facts').applyCheeseWeight(row, weight)) : rows;
}

async function getProductsCacheAge(orgId) {
  const row = await queryOne('SELECT MIN(cached_at) as oldest FROM products_cache WHERE organization_id = $1', [orgId]);
  if (!row?.oldest) return Infinity;
  return (Date.now() - new Date(row.oldest).getTime()) / 1000 / 60;
}

// ─── ORDERS ───────────────────────────────────────────────────────

async function createOrder({ conversationId, organizationId, items, customerName, customerPhone, shippingAddress, totalPrice, status = 'draft', note = null }) {
  const order = await queryOne(
    `INSERT INTO orders (conversation_id, organization_id, items, customer_name, customer_phone, shipping_address, total_price, status, notes, delivery_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
    [conversationId, organizationId, JSON.stringify(items), customerName, customerPhone, JSON.stringify(shippingAddress), totalPrice, status, note || null]
  );
  // Un pedido ya persistido es la fuente de verdad. Cerrar cualquier toma de
  // pedido anterior evita que el bot retome un carrito obsoleto después de
  // que el equipo creó o corrigió la orden manualmente desde el chat.
  if (conversationId) {
    await pool.query(
      `UPDATE conversations
          SET pipeline_state = 'done', order_draft = '{}', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2`,
      [conversationId, organizationId]
    );
  }
  // Actualizar last_order_at en contacts para que el broadcast lo excluya correctamente
  if (customerPhone) {
    const normPhone = normalizePhone(customerPhone);
    pool.query(
      `UPDATE contacts SET last_order_at = NOW(), updated_at = NOW()
       WHERE organization_id = $1 AND phone = $2`,
      [organizationId, normPhone]
    ).catch(() => {});
  }
  // Invalidar caché de reenganche — el cliente ya tiene un pedido activo
  const today = new Date().toISOString().slice(0, 10);
  pool.query(
    `UPDATE reengagement_daily_cache SET candidates = NULL WHERE organization_id = $1 AND cache_date = $2`,
    [organizationId, today]
  ).catch(() => {});
  return order;
}

async function createStoreOrder({ conversationId, organizationId, items, customerName, customerPhone, shippingAddress, expectedTotal }) {
  const requested = new Map();
  for (const item of items || []) {
    const productId = Number(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw Object.assign(new Error('Producto o cantidad inválida'), { status: 400 });
    }
    const accumulated = (requested.get(productId) || 0) + quantity;
    if (accumulated > 1000) throw Object.assign(new Error('Cantidad inválida'), { status: 400 });
    requested.set(productId, accumulated);
  }
  if (!requested.size) throw Object.assign(new Error('Agrega al menos un producto'), { status: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`store:${organizationId}:${String(customerPhone).replace(/\D/g, '').slice(-9)}`]);
    const xlPricing = require('../services/xl-welcome-pricing');
    const xlContext = await xlPricing.context(client, organizationId, customerPhone);
    const ids = [...requested.keys()];
    const { rows: products } = await client.query(
      `SELECT id, title, price, stock, active, is_business
         FROM products
        WHERE organization_id = $1 AND id = ANY($2::int[])
        FOR UPDATE`,
      [organizationId, ids]
    );
    const productMap = new Map(products.map(product => [Number(product.id), product]));
    const resolvedItems = [];
    let total = 0;

    for (const [productId, quantity] of requested) {
      const product = productMap.get(productId);
      if (!product || product.active === false || product.is_business === true) {
        throw Object.assign(new Error(`Producto ${productId} no disponible`), { status: 400 });
      }
      const price = Number(product.price);
      const stock = Number(product.stock);
      if (!Number.isFinite(price) || price < 0) throw Object.assign(new Error('Precio inválido'), { status: 400 });
      if (Number.isFinite(stock) && stock >= 0 && stock < quantity) {
        throw Object.assign(new Error(`Stock insuficiente para ${product.title}. Disponible: ${stock}`), {
          status: 409,
          code: 'INSUFFICIENT_STOCK',
        });
      }
      resolvedItems.push({ id: product.id, title: product.title, quantity, price });
      total += price * quantity;
    }

    const adjusted = xlPricing.apply(resolvedItems, xlPricing.forStore(xlContext));
    resolvedItems.splice(0, resolvedItems.length, ...adjusted);
    total = Math.round(resolvedItems.reduce((sum, item) => sum + item.price * item.quantity, 0));
    if (expectedTotal != null && Number(expectedTotal) !== total) {
      throw Object.assign(new Error('El precio cambió. Revisa el total actualizado antes de confirmar.'), { status: 409, code: 'PRICE_CHANGED' });
    }
    for (const [productId, quantity] of requested) {
      await client.query(
        `UPDATE products
            SET stock = CASE WHEN stock >= 0 THEN stock - $1 ELSE stock END,
                updated_at = NOW()
          WHERE id = $2 AND organization_id = $3`,
        [quantity, productId, organizationId]
      );
    }

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (conversation_id, organization_id, items, customer_name, customer_phone, shipping_address, total_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft') RETURNING *`,
      [conversationId, organizationId, JSON.stringify(resolvedItems), customerName, customerPhone,
        JSON.stringify(shippingAddress), total.toFixed(0)]
    );
    await client.query('COMMIT');

    if (customerPhone) {
      const normPhone = normalizePhone(customerPhone);
      pool.query(
        `UPDATE contacts SET last_order_at = NOW(), updated_at = NOW()
          WHERE organization_id = $1 AND phone = $2`,
        [organizationId, normPhone]
      ).catch(() => {});
    }
    const today = new Date().toISOString().slice(0, 10);
    pool.query(
      `UPDATE reengagement_daily_cache SET candidates = NULL WHERE organization_id = $1 AND cache_date = $2`,
      [organizationId, today]
    ).catch(() => {});

    return { order, resolvedItems, total };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function updateOrder(id, updates) {
  const keys = Object.keys(updates);
  const values = Object.values(updates);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  values.push(id);
  return queryOne(`UPDATE orders SET ${setClause} WHERE id = $${values.length} RETURNING *`, values);
}

async function getOrdersByOrg(orgId) {
  return query('SELECT * FROM orders WHERE organization_id = $1 ORDER BY created_at DESC', [orgId]);
}

async function getLatestPendingOrderByConversation(conversationId) {
  return queryOne(
    `SELECT * FROM orders WHERE conversation_id = $1 AND status IN ('sent','draft','payment_received')
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
}

/**
 * Pedidos de la conversación a los que puede corresponder un comprobante de
 * pago, en orden de prioridad:
 *   1. Entregados por transferencia SIN comprobante válido (se les mandó el
 *      cobro; es lo más probable cuando llega una captura).
 *   2. Pedidos en curso todavía no pagados (flujo pre-entrega).
 * Devuelve hasta 5 para que quien llama elija por monto.
 */
async function getOrdersAwaitingPayment(conversationId) {
  return query(
    `SELECT o.*,
            CASE WHEN o.payment_method = 'mixto' THEN o.payment_transfer_amount ELSE o.total_price::numeric END AS payment_due_amount,
            (o.status IN ('entregado', 'paid') OR o.delivered_at IS NOT NULL) AS is_delivered,
            (SELECT COUNT(*) FROM payment_proofs pp WHERE pp.order_id = o.id AND pp.status = 'pending')::int AS proofs_pending
       FROM orders o
      WHERE o.conversation_id = $1
        AND (
          ((o.status IN ('entregado', 'paid') OR o.delivered_at IS NOT NULL) AND o.payment_method IN ('transferencia', 'mixto')
             AND NOT EXISTS (SELECT 1 FROM payment_proofs pp
                              WHERE pp.order_id = o.id AND pp.status IN ('verified','pre_verified'))
             AND COALESCE(o.payment_marked_at, o.updated_at, o.created_at) > NOW() - INTERVAL '60 days')
          OR o.status IN ('sent','draft','payment_received','nuevo','por_despachar','en_camino')
        )
      ORDER BY (o.status IN ('entregado', 'paid') OR o.delivered_at IS NOT NULL) DESC, o.created_at DESC
      LIMIT 5`,
    [conversationId]
  );
}

/**
 * Busca el pedido activo más reciente de una conversación para inyectar
 * contexto al bot. Incluye todos los estados no terminales.
 */
/**
 * Último pedido ENTREGADO (o pagado) de la conversación en los últimos N días.
 * Lo usa el bot para resolver reclamos de entrega incompleta ("pedí 3, llegó 1").
 */
async function getRecentDeliveredOrder(conversationId, days = 7) {
  return queryOne(
    `SELECT * FROM orders
      WHERE conversation_id = $1
        AND status IN ('entregado', 'paid')
        AND COALESCE(updated_at, created_at) > NOW() - ($2 || ' days')::interval
      ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
    [conversationId, String(days)]
  );
}

async function getActiveOrderForBot(conversationId) {
  // Un pedido que lleva más de 7 días sin moverse ya no es "activo" para el
  // bot: casi siempre se entregó y nadie lo cerró en el CRM. Contarlo como
  // activo hace que el bot diga "en preparación" de algo que el cliente
  // recibió hace dos semanas. Excepción: pedidos con fecha de entrega
  // programada que aún no llega (reprogramados).
  return queryOne(
    `SELECT * FROM orders
     WHERE conversation_id = $1
       AND status IN ('draft','nuevo','sent','payment_received','por_despachar','en_camino')
       AND (COALESCE(updated_at, created_at) > NOW() - INTERVAL '7 days'
            OR (delivery_date IS NOT NULL AND delivery_date >= CURRENT_DATE))
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
}
// Nota: 'draft' incluido — los pedidos COD que crea el bot nacen como 'draft'
// y nadie los mueve a 'nuevo' hasta que el CRM lo hace. Sin 'draft' el bot
// "olvidaba" el pedido en el siguiente mensaje del cliente.

// ─── PRODUCTS PROPIOS ─────────────────────────────────────────────

async function getProducts(orgId, onlyActive = false) {
  const cond = onlyActive ? 'AND active = TRUE' : '';
  return query(
    `SELECT * FROM products WHERE organization_id = $1 ${cond} ORDER BY position ASC, id ASC`,
    [orgId]
  );
}

async function getProductById(orgId, id) {
  return queryOne('SELECT * FROM products WHERE organization_id = $1 AND id = $2', [orgId, id]);
}

async function createProduct(orgId, { title, description, price, comparePrice, sku, stock, imageUrl, active, position, category, isBusiness, bulkPrice, bulkMinQty }) {
  return queryOne(
    `INSERT INTO products (organization_id, title, description, price, compare_price, sku, stock, image_url, active, position, category, is_business, bulk_price, bulk_min_qty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [orgId, title, description || null, price, comparePrice || null, sku || null,
     stock ?? -1, imageUrl || null, active !== false, position || 0, category || null, isBusiness === true,
     bulkPrice || null, bulkMinQty || null]
  );
}

async function updateProduct(orgId, id, updates) {
  const allowed = { title:1, description:1, price:1, compare_price:1, sku:1, stock:1, image_url:1, active:1, position:1, category:1, is_business:1, bulk_price:1, bulk_min_qty:1, updated_at:1 };
  const keys   = Object.keys(updates).filter(k => allowed[k]);
  if (!keys.length) return getProductById(orgId, id);
  const values = keys.map(k => updates[k]);
  const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  values.push(id, orgId);
  return queryOne(
    `UPDATE products SET ${set}, updated_at = NOW() WHERE id = $${values.length - 1} AND organization_id = $${values.length} RETURNING *`,
    values
  );
}

async function deleteProduct(orgId, id) {
  return queryOne('DELETE FROM products WHERE id = $1 AND organization_id = $2 RETURNING id', [id, orgId]);
}

// ─── PAYMENT PROOFS ────────────────────────────────────────────────

async function savePaymentProof({ orgId, conversationId, orderId, mediaId, customerPhone, customerName, orderSummary,
                                   extractedAmount, extractedDate, extractedBank, extractedReference, aiConfidence, amountMatches, status }) {
  return queryOne(
    `INSERT INTO payment_proofs
       (organization_id, conversation_id, order_id, media_id, customer_phone, customer_name, order_summary,
        extracted_amount, extracted_date, extracted_bank, extracted_reference, ai_confidence, amount_matches, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, 'pending')) RETURNING *`,
    [orgId, conversationId, orderId || null, mediaId, customerPhone || null, customerName || null, orderSummary || null,
     extractedAmount || null, extractedDate || null, extractedBank || null, extractedReference || null,
     aiConfidence || null, amountMatches ?? null, status || null]
  );
}

async function getPaymentProofs(orgId, statusFilter = null) {
  const cond = statusFilter ? 'AND pp.status = $2' : '';
  const args = statusFilter ? [orgId, statusFilter] : [orgId];
  return query(
    `SELECT pp.*, c.phone_number, c.contact_name,
            o.id AS linked_order_id,
            o.items AS linked_order_items,
            o.total_price AS linked_order_total,
            o.status AS linked_order_status,
            o.delivery_date AS linked_order_delivery_date,
            o.created_at AS linked_order_created_at,
            bm.date AS bank_movement_date,
            bm.amount AS bank_movement_amount,
            bm.payer AS bank_movement_payer,
            bm.doc_number AS bank_movement_reference,
            bm.match_method AS bank_match_method
     FROM payment_proofs pp
     LEFT JOIN conversations c ON pp.conversation_id = c.id
     LEFT JOIN orders o
       ON o.id = pp.order_id
      AND o.organization_id = pp.organization_id
     LEFT JOIN bank_movements bm
       ON bm.id = pp.bank_movement_id
      AND bm.organization_id = pp.organization_id
     WHERE pp.organization_id = $1 ${cond}
     ORDER BY pp.created_at DESC`,
    args
  );
}

async function updatePaymentProof(id, { status, notes }, orgId) {
  if (!orgId) throw new Error('Organización requerida');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [proof] } = await client.query(
      `UPDATE payment_proofs
          SET status = $1, notes = $2,
              verification_method = CASE WHEN $1 = 'verified' AND bank_movement_id IS NULL THEN 'manual' ELSE verification_method END
        WHERE id = $3 AND organization_id = $4 RETURNING *`,
      [status, notes || null, id, orgId]);
    if (proof && status === 'verified' && proof.order_id) {
      const result = await client.query("UPDATE orders SET status = 'paid', payment_method = COALESCE(payment_method, 'transferencia'), payment_marked_at = COALESCE(payment_marked_at, NOW()), updated_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING id", [proof.order_id, orgId]);
      if (!result.rowCount) throw new Error('Pedido del comprobante no encontrado');
    }
    await client.query('COMMIT');
    return proof || null;
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

// ─── ESCALATION FEEDBACK ──────────────────────────────────────

async function saveEscalationFeedback(orgId, conversationId, messageContent, escalationReason, feedback) {
  return queryOne(
    `INSERT INTO escalation_feedback (organization_id, conversation_id, message_content, escalation_reason, feedback)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [orgId, conversationId, messageContent, escalationReason || '', feedback]
  );
}

async function getEscalationNegativeExamples(orgId, limit = 8) {
  return query(
    `SELECT message_content, escalation_reason, created_at
     FROM escalation_feedback
     WHERE organization_id = $1 AND feedback = 'unnecessary'
     ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit]
  );
}

async function setLastEscalation(conversationId, triggerMessage, reason) {
  await pool.query(
    `UPDATE conversations
     SET last_escalation_trigger = $1, last_escalation_reason = $2, last_escalation_at = CURRENT_TIMESTAMP,
         escalation_reminder_at = NULL
     WHERE id = $3`,
    [triggerMessage, reason, conversationId]
  );
}

async function clearLastEscalation(conversationId) {
  await pool.query(
    `UPDATE conversations
     SET last_escalation_trigger = NULL, last_escalation_reason = NULL, last_escalation_at = NULL,
         escalation_reminder_at = NULL
     WHERE id = $1`,
    [conversationId]
  );
}

// ─── CONTACTS ─────────────────────────────────────────────────────

/**
 * Obtiene el perfil de un contacto por teléfono.
 * Devuelve null si no existe.
 */
async function getContact(orgId, phone) {
  return queryOne(
    'SELECT * FROM contacts WHERE organization_id = $1 AND phone = $2',
    [orgId, phone]
  );
}

/**
 * Crea o actualiza el perfil de un contacto.
 * Solo actualiza los campos que vienen con valor (no pisa datos existentes con null).
 *
 * @param {number} orgId
 * @param {object} data - { phone, name?, email?, address?, city?, region?, notes?, shopifyId? }
 */
async function upsertContact(orgId, { phone, name, email, address, city, region, notes, shopifyId } = {}) {
  if (!phone) return null;
  phone = normalizePhone(phone); // siempre normalizar antes de guardar
  if (!phone) return null;
  await pool.query(
    `INSERT INTO contacts (organization_id, phone, name, email, address, city, region, notes, shopify_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (organization_id, phone) DO UPDATE SET
       name       = COALESCE(EXCLUDED.name,       contacts.name),
       email      = COALESCE(EXCLUDED.email,      contacts.email),
       address    = COALESCE(EXCLUDED.address,    contacts.address),
       city       = COALESCE(EXCLUDED.city,       contacts.city),
       region     = COALESCE(EXCLUDED.region,     contacts.region),
       notes      = COALESCE(EXCLUDED.notes,      contacts.notes),
       shopify_id = COALESCE(EXCLUDED.shopify_id, contacts.shopify_id),
       total_orders = contacts.total_orders + CASE WHEN EXCLUDED.address IS NOT NULL THEN 1 ELSE 0 END,
       last_order_at = CASE WHEN EXCLUDED.address IS NOT NULL THEN NOW() ELSE contacts.last_order_at END,
       updated_at = NOW()`,
    [orgId, phone, normalizeName(name), email || null, address || null, city || null, region || null, notes || null, shopifyId || null]
  );
  return getContact(orgId, phone);
}

/**
 * Upsert completo de un cliente de Shopify en la tabla contacts.
 * Guarda todos los campos ricos para servir la lista de clientes desde DB local.
 *
 * @param {number} orgId
 * @param {object} c - objeto de cliente de shopifyApi.getAllCustomers
 */
async function upsertShopifyCustomerProfile(orgId, c) {
  const rawPhone = c.phone || null;
  const phone    = rawPhone ? normalizePhone(rawPhone) : null;
  const shopifyId = c.id ? String(c.id) : null;

  // Necesitamos al menos teléfono (es el ID canónico) para hacer upsert seguro
  if (!phone) return;

  const addr = c.address || {};
  const lastOrderData = c.lastOrder ? {
    name:       c.lastOrder.name,
    items:      (c.lastOrder.items || []).map(i => i.title || i.name || i),
    totalPrice: parseFloat(c.lastOrder.totalPrice || 0),
    createdAt:  c.lastOrder.createdAt,
  } : null;

  await pool.query(
    `INSERT INTO contacts
       (organization_id, phone, name, email,
        address1, address2, city, province, zip, country,
        total_spent, orders_count, tags, shopify_id,
        shopify_created_at, last_order_data, currency, shopify_note,
        contact_type, shopify_synced_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,$17,$18,'customer',NOW(),NOW(),NOW())
     ON CONFLICT (organization_id, phone) DO UPDATE SET
       name               = COALESCE(EXCLUDED.name,          contacts.name),
       email              = COALESCE(EXCLUDED.email,         contacts.email),
       address1           = COALESCE(EXCLUDED.address1,      contacts.address1),
       address2           = EXCLUDED.address2,
       city               = COALESCE(EXCLUDED.city,          contacts.city),
       province           = EXCLUDED.province,
       zip                = EXCLUDED.zip,
       country            = EXCLUDED.country,
       total_spent        = EXCLUDED.total_spent,
       orders_count       = EXCLUDED.orders_count,
       tags               = EXCLUDED.tags,
       shopify_id         = COALESCE(EXCLUDED.shopify_id,    contacts.shopify_id),
       shopify_created_at = COALESCE(EXCLUDED.shopify_created_at, contacts.shopify_created_at),
       last_order_data    = EXCLUDED.last_order_data,
       currency           = EXCLUDED.currency,
       shopify_note       = EXCLUDED.shopify_note,
       contact_type       = 'customer',
       shopify_synced_at  = NOW(),
       updated_at         = NOW()`,
    [
      orgId, phone,
      normalizeName(c.name),
      c.email || null,
      addr.address1 || null,
      addr.address2 || null,
      addr.city || null,
      addr.province || null,
      addr.zip || null,
      addr.country || null,
      parseFloat(c.totalSpent || 0),
      parseInt(c.ordersCount || 0),
      JSON.stringify(c.tags || []),
      shopifyId,
      c.createdAt || null,
      lastOrderData ? JSON.stringify(lastOrderData) : null,
      c.currency || 'CLP',
      c.note || null,
    ]
  );
}

/**
 * Actualiza el tipo de cliente (personal / empresa).
 */
async function updateContactClientType(orgId, phone, clientType) {
  if (!['personal', 'empresa'].includes(clientType)) throw new Error('clientType inválido');
  phone = normalizePhone(phone);
  if (!phone) throw new Error('Teléfono inválido');
  const localPhone = /^569\d{8}$/.test(phone) ? phone.slice(2) : null;
  const variants = [...new Set([phone, `+${phone}`, localPhone].filter(Boolean))];

  // Los contactos históricos pueden existir como 9XXXXXXXX, 569XXXXXXXX o
  // +569XXXXXXXX. Mantenerlos sincronizados evita que la bandeja lea una fila
  // antigua con un tipo diferente.
  await pool.query(
    `UPDATE contacts
        SET client_type = $3, updated_at = NOW()
      WHERE organization_id = $1
        AND phone = ANY($2::text[])`,
    [orgId, variants, clientType]
  );
  await pool.query(
    `INSERT INTO contacts (organization_id, phone, client_type, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (organization_id, phone) DO UPDATE
       SET client_type = EXCLUDED.client_type, updated_at = NOW()`,
    [orgId, phone, clientType]
  );
  return getContact(orgId, phone);
}

/**
 * Marca o desmarca opt-out de un contacto.
 * @param {number} orgId
 * @param {string} phone - teléfono normalizado
 * @param {boolean} value - true = no quiere mensajes, false = sí quiere
 */
async function setContactOptOut(orgId, phone, value) {
  phone = normalizePhone(phone);
  if (!phone) return null;
  await pool.query(
    `UPDATE contacts SET opt_out = $3, updated_at = NOW()
     WHERE organization_id = $1 AND phone = $2`,
    [orgId, phone, !!value]
  );
  return getContact(orgId, phone);
}

/**
 * Registra o actualiza un contacto como lead al recibir un mensaje.
 * No sobreescribe datos existentes ni baja de 'customer' a 'lead'.
 */
async function touchLead(orgId, phone, name = null) {
  if (!phone) return;
  phone = normalizePhone(phone);
  const savedName = await savedCustomerName(orgId, phone);
  await pool.query(
    `INSERT INTO contacts (organization_id, phone, name, contact_type, source, last_seen_at, updated_at)
     VALUES ($1, $2, $3, 'lead', 'whatsapp', NOW(), NOW())
     ON CONFLICT (organization_id, phone) DO UPDATE SET
       name         = CASE WHEN ${usableNameSql('contacts.name')} THEN contacts.name ELSE EXCLUDED.name END,
       contact_type = COALESCE(contacts.contact_type, 'lead'),
       source       = COALESCE(contacts.source, 'whatsapp'),
       last_seen_at = NOW(),
       updated_at   = NOW()`,
    [orgId, phone, savedName || normalizeName(name)]
  );
}

/**
 * Promueve un contacto de lead a customer al confirmar un pedido.
 */
async function promoteToCustomer(orgId, phone) {
  if (!phone) return;
  await pool.query(
    `UPDATE contacts SET contact_type = 'customer', updated_at = NOW()
     WHERE organization_id = $1 AND phone = $2`,
    [orgId, phone]
  );
}

/**
 * Lista contactos con filtros opcionales.
 */
async function getContacts(orgId, { type = null, search = null, limit = 100, offset = 0 } = {}) {
  const conditions = ['organization_id = $1'];
  const params = [orgId];
  let i = 2;
  if (type) { conditions.push(`contact_type = $${i++}`); params.push(type); }
  if (search) {
    conditions.push(`(name ILIKE $${i} OR phone ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }
  params.push(limit, offset);
  return query(
    `SELECT * FROM contacts WHERE ${conditions.join(' AND ')}
     ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    params
  );
}

async function countContacts(orgId, type = null) {
  const cond = type ? 'AND contact_type = $2' : '';
  const args = type ? [orgId, type] : [orgId];
  const row  = await queryOne(`SELECT COUNT(*) as n FROM contacts WHERE organization_id = $1 ${cond}`, args);
  return parseInt(row?.n || 0);
}

// ─── SETTINGS ─────────────────────────────────────────────────────

async function getSetting(orgId, key) {
  const row = await queryOne(
    'SELECT value FROM settings WHERE organization_id = $1 AND key = $2',
    [orgId, key]
  );
  return row?.value || null;
}

async function setSetting(orgId, key, value) {
  await pool.query(
    `INSERT INTO settings (organization_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT(organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [orgId, key, value]
  );
}

// ─── RE-ENGANCHE: calibración, caché y predicciones ──────────────────

async function saveCalibration(orgId, result) {
  await pool.query(
    `INSERT INTO org_reengagement_calibration
       (organization_id, calibration_factor, bucket_factors, accuracy_rate, mean_error_days,
        total_predictions, customers_analyzed, bucket_stats, top_customers, insight, calibrated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(organization_id) DO UPDATE SET
       calibration_factor  = EXCLUDED.calibration_factor,
       bucket_factors      = EXCLUDED.bucket_factors,
       accuracy_rate       = EXCLUDED.accuracy_rate,
       mean_error_days     = EXCLUDED.mean_error_days,
       total_predictions   = EXCLUDED.total_predictions,
       customers_analyzed  = EXCLUDED.customers_analyzed,
       bucket_stats        = EXCLUDED.bucket_stats,
       top_customers       = EXCLUDED.top_customers,
       insight             = EXCLUDED.insight,
       calibrated_at       = EXCLUDED.calibrated_at`,
    [
      orgId,
      result.calibrationFactor,
      JSON.stringify(result.bucketFactors),
      result.accuracyRate,
      result.meanErrorDays,
      result.totalPredictions,
      result.customersAnalyzed,
      JSON.stringify(result.bucketStats),
      JSON.stringify(result.topCustomers),
      result.insight,
      result.calibratedAt,
    ]
  );
}

async function getCalibration(orgId) {
  const row = await queryOne(
    `SELECT * FROM org_reengagement_calibration WHERE organization_id = $1`,
    [orgId]
  );
  if (!row) return null;
  return {
    calibrationFactor:  parseFloat(row.calibration_factor),
    bucketFactors:      row.bucket_factors,
    accuracyRate:       parseFloat(row.accuracy_rate),
    meanErrorDays:      parseFloat(row.mean_error_days),
    totalPredictions:   row.total_predictions,
    customersAnalyzed:  row.customers_analyzed,
    bucketStats:        row.bucket_stats,
    topCustomers:       row.top_customers,
    insight:            row.insight,
    calibratedAt:       row.calibrated_at,
  };
}

async function getDailyCache(orgId, date) {
  const row = await queryOne(
    `SELECT * FROM reengagement_daily_cache WHERE organization_id=$1 AND cache_date=$2`,
    [orgId, date]
  );
  return row ? row.candidates : null;
}

async function saveDailyCache(orgId, date, candidates) {
  await pool.query(
    `INSERT INTO reengagement_daily_cache (organization_id, cache_date, candidates, total_candidates)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(organization_id, cache_date) DO UPDATE SET
       candidates=$3, total_candidates=$4`,
    [orgId, date, JSON.stringify(candidates), candidates.length]
  );
}

async function savePredictions(orgId, candidates, today) {
  for (const c of candidates) {
    const predictedBuyDate = c.predictedDays != null
      ? new Date(Date.now() + c.predictedDays * 86400000).toISOString().slice(0, 10)
      : null;
    await pool.query(
      `INSERT INTO reengagement_predictions
         (organization_id, customer_phone, customer_name, prediction_date,
          confidence_raw, confidence_calibrated, predicted_days, predicted_buy_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(organization_id, customer_phone, prediction_date) DO NOTHING`,
      [orgId, c.phone, c.name, today,
       c.confidenceRaw ?? c.confidence,
       c.confidence,
       c.predictedDays,
       predictedBuyDate]
    );
  }
}

async function markMessageSent(orgId, phone, today, templateName) {
  await pool.query(
    `UPDATE reengagement_predictions
     SET message_sent=TRUE, message_sent_at=NOW(), template_name=$4
     WHERE organization_id=$1 AND customer_phone=$2 AND prediction_date=$3`,
    [orgId, phone, today, templateName || null]
  );
}

async function getPendingOutcomeCheck(orgId, beforeDate) {
  return query(
    `SELECT * FROM reengagement_predictions
     WHERE organization_id=$1 AND outcome_checked=FALSE AND prediction_date < $2
     ORDER BY prediction_date ASC LIMIT 200`,
    [orgId, beforeDate]
  );
}

async function saveOutcome(orgId, phone, predictionDate, bought, daysToActualBuy) {
  const isMiss = !bought; // si no compró = miss (independiente de si se mandó msg)
  await pool.query(
    `UPDATE reengagement_predictions
     SET outcome_checked=TRUE, outcome_date=CURRENT_DATE,
         actually_bought=$4, days_to_actual_buy=$5, miss_flag=$6
     WHERE organization_id=$1 AND customer_phone=$2 AND prediction_date=$3`,
    [orgId, phone, predictionDate, bought, daysToActualBuy, isMiss]
  );
}

async function getAccuracyStats(orgId) {
  return queryOne(
    `SELECT
       COUNT(*) FILTER (WHERE outcome_checked)                          AS total_checked,
       COUNT(*) FILTER (WHERE outcome_checked AND actually_bought)      AS total_bought,
       COUNT(*) FILTER (WHERE miss_flag AND confidence_calibrated >= 80) AS high_conf_misses,
       COUNT(*) FILTER (WHERE miss_flag AND NOT message_sent AND confidence_calibrated >= 80) AS missed_no_msg,
       AVG(days_to_actual_buy) FILTER (WHERE actually_bought)          AS avg_days_to_buy
     FROM reengagement_predictions
     WHERE organization_id=$1 AND prediction_date >= CURRENT_DATE - INTERVAL '60 days'`,
    [orgId]
  );
}

async function bulkDeleteBotOrders(orgId, ids) {
  if (!ids?.length) return 0;
  const { rowCount } = await pool.query(
    'DELETE FROM orders WHERE organization_id = $1 AND id = ANY($2::int[])',
    [orgId, ids]
  );
  return rowCount;
}

async function bulkDeleteShopifyOrders(orgId, shopifyOrderIds) {
  if (!shopifyOrderIds?.length) return 0;
  const { rowCount } = await pool.query(
    'DELETE FROM shopify_orders WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])',
    [orgId, shopifyOrderIds]
  );
  return rowCount;
}

async function bulkUpdateBotOrderStatus(orgId, ids, status) {
  if (!ids?.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE orders SET status = $1
     WHERE organization_id = $2 AND id = ANY($3::int[])`,
    [status, orgId, ids]
  );
  return rowCount;
}

async function bulkUpdateShopifyOrderStatus(orgId, shopifyOrderIds, crmStatus) {
  if (!shopifyOrderIds?.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE shopify_orders SET crm_status = $1
     WHERE organization_id = $2 AND shopify_order_id = ANY($3::text[])`,
    [crmStatus, orgId, shopifyOrderIds]
  );
  return rowCount;
}

// ─── SHOPIFY ORDERS CACHE ─────────────────────────────────────────────

/**
 * Upsert bulk de órdenes Shopify en nuestra DB.
 * orders: array de objetos ya normalizados con campos del schema.
 */
async function upsertShopifyOrders(orgId, orders) {
  if (!orders?.length) return;
  for (const o of orders) {
    // Saltar órdenes canceladas — no deben afectar historial ni métricas
    if (o.cancelledAt || o.financialStatus === 'VOIDED' ||
        (typeof o.financialStatus === 'string' && o.financialStatus.toLowerCase() === 'voided')) {
      continue;
    }
    // getAllOrders devuelve formato GraphQL camelCase:
    // o.createdAt, o.totalPrice (number), o.financialStatus, o.fulfillmentStatus
    // o.customer.name (ya formateado), o.customer.phone/email
    // o.items (ya mapeados): [{ title, quantity, price }]
    const customerName  = normalizeName(o.customer?.name || null);
    const customerEmail = o.customer?.email || null;
    const customerPhone = normalizePhone(
      o.customer?.phone
      || o.shippingAddress?.phone
      || o.billingAddress?.phone
      || null
    ) || null;
    const shippingCity  = o.shippingAddress?.city || o.billingAddress?.city || null;
    const items         = (o.items || []).map(li => ({
      name:     li.title || li.name,
      quantity: li.quantity,
      price:    li.price,
      sku:      li.sku || null,
      variantId: li.variantId || null,
      variantTitle: li.variantTitle || null,
      productId: li.productId || null,
      productTitle: li.productTitle || null,
    }));
    const createdAt     = o.createdAt || null;

    await pool.query(
      `INSERT INTO shopify_orders
         (organization_id, shopify_order_id, shopify_name, financial_status, fulfillment_status,
          total_price, customer_name, customer_email, customer_phone, shipping_city,
          items, raw_json, shopify_created_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (organization_id, shopify_order_id) DO UPDATE SET
         shopify_name        = EXCLUDED.shopify_name,
         -- La importación refresca el espejo de Shopify, pero nunca debe
         -- deshacer estados de pago o entrega ya confirmados dentro del CRM.
         financial_status    = CASE
           WHEN shopify_orders.payment_marked_at IS NOT NULL
             OR shopify_orders.payment_record_source IS NOT NULL
           THEN shopify_orders.financial_status
           ELSE EXCLUDED.financial_status
         END,
         fulfillment_status  = CASE
           WHEN shopify_orders.delivered_at IS NOT NULL
           THEN shopify_orders.fulfillment_status
           ELSE EXCLUDED.fulfillment_status
         END,
         total_price         = EXCLUDED.total_price,
         customer_name       = EXCLUDED.customer_name,
         customer_email      = EXCLUDED.customer_email,
         customer_phone      = EXCLUDED.customer_phone,
         shipping_city       = EXCLUDED.shipping_city,
         items               = EXCLUDED.items,
         raw_json            = EXCLUDED.raw_json,
         shopify_created_at  = EXCLUDED.shopify_created_at,
         synced_at           = NOW()`,
      [
        orgId,
        String(o.id),
        o.name || null,
        o.financialStatus || null,
        o.fulfillmentStatus || null,
        o.totalPrice || null,
        customerName,
        customerEmail,
        customerPhone,
        shippingCity,
        JSON.stringify(items),
        JSON.stringify(o),
        createdAt,
      ]
    );

    // Sincronizar cliente en la tabla contacts (usando phone normalizado)
    const contactPhone = normalizePhone(customerPhone);
    const shippingAddress1 = o.shippingAddress?.address1 || o.billingAddress?.address1 || null;
    if (contactPhone) {
      await pool.query(
        `INSERT INTO contacts
           (organization_id, phone, name, email, city, address1, contact_type, shopify_id,
            total_orders, last_order_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'customer',$7,1,$8,NOW(),NOW())
         ON CONFLICT (organization_id, phone) DO UPDATE SET
           name          = COALESCE(EXCLUDED.name,     contacts.name),
           email         = COALESCE(EXCLUDED.email,    contacts.email),
           city          = COALESCE(EXCLUDED.city,     contacts.city),
           address1      = COALESCE(EXCLUDED.address1, contacts.address1),
           contact_type  = 'customer',
           shopify_id    = COALESCE(EXCLUDED.shopify_id, contacts.shopify_id),
           total_orders  = (
             SELECT COUNT(*) FROM shopify_orders
             WHERE organization_id = $1
               AND customer_phone = ANY(ARRAY[
                     $2,
                     CASE WHEN $2 ~ '^569' THEN SUBSTRING($2 FROM 3) END,
                     CASE WHEN $2 ~ '^9'   THEN '56' || $2 END,
                     '+' || $2
                   ])
           ),
           last_order_at = GREATEST(contacts.last_order_at, EXCLUDED.last_order_at),
           updated_at    = NOW()`,
        [
          orgId,
          contactPhone,
          customerName,
          customerEmail,
          shippingCity,
          shippingAddress1,
          o.customer?.id ? String(o.customer.id) : null,
          createdAt,
        ]
      );
    }
  }
}

async function getShopifyOrders(orgId) {
  return query(
    'SELECT * FROM shopify_orders WHERE organization_id = $1 ORDER BY shopify_created_at DESC NULLS LAST',
    [orgId]
  );
}

async function getShopifyOrdersSyncedAt(orgId) {
  const row = await queryOne(
    'SELECT MAX(synced_at) as last_sync FROM shopify_orders WHERE organization_id = $1',
    [orgId]
  );
  return row?.last_sync || null;
}

// ─── ADMIN RELAY (respuestas del admin vía WhatsApp personal) ────────────────

async function createAdminPendingReply(orgId, conversationId, customerPhone, context) {
  const updated = await pool.query(
    `UPDATE admin_pending_replies
        SET customer_phone = $3, context = $4, created_at = NOW()
      WHERE org_id = $1 AND conversation_id = $2 AND status = 'pending'`,
    [orgId, conversationId, customerPhone, context || null]
  );
  if (updated.rowCount > 0) return;
  await pool.query(
    `INSERT INTO admin_pending_replies (org_id, conversation_id, customer_phone, context)
     VALUES ($1, $2, $3, $4)`,
    [orgId, conversationId, customerPhone, context || null]
  );
}

async function getLatestPendingAdminReply(orgId) {
  return queryOne(
    `SELECT * FROM admin_pending_replies
     WHERE org_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [orgId]
  );
}

async function markAdminReplyHandled(id) {
  await pool.query(
    `UPDATE admin_pending_replies SET status = 'replied' WHERE id = $1`,
    [id]
  );
}

module.exports = {
  getPool,
  normalizePhone, normalizeName,
  // Orgs
  createOrganization, getOrgById, markSetupDone,
  // Users
  createUser, getUserByEmail, getUserById,
  // WhatsApp
  upsertWhatsappConfig, getWhatsappConfig, getOrgByWebhookToken, getOrgByPhoneNumberId, getOrgByTwilioNumber,
  createWhatsappChannel, listWhatsappChannels, getWhatsappChannel, getDefaultWhatsappChannel, getEvolutionWhatsappChannel,
  setDefaultWhatsappChannel, updateWhatsappChannelStatus,
  // Data sources
  createDataSource, getDataSources, getDataSource, updateDataSourceStatus, getPrimaryDataSource,
  // Agents
  createAgent, getAgents, createDefaultAgents,
  // Conversations
  upsertConversation, getAllConversations, getConversationById, setConversationPinned, setCustomerNote,
  updateConversationLastMessage, markConversationAsRead, setAgentMode, claimHumanPendingNotification,
  updatePipelineState, getOrderDraft, claimOrderCreation,
  // Scheduled orders
  createScheduledOrder, getPendingScheduledOrders, markScheduledOrderSent, cancelScheduledOrder,
  updateLastInbound, updateFollowUpSent, getStalledConversations,
  // Messages
  saveMessage, getMessageByWhatsappId, saveAdAttribution, saveMessageMediaBlob, getMessageMediaBlob,
  getMessagesByConversation, getMessagesByCustomerPhone, getLastMessages, updateMessageStatus, minutesSinceLastHumanReply,
  saveWhatsappAttribution, getLatestWhatsappAttribution, getWhatsappAttributionReport, getWhatsappBuyerReport,
  // Products
  cacheProducts, getCachedProducts, getProductsCacheAge,
  // Products propios
  getProducts, getProductById, createProduct, updateProduct, deleteProduct,
  // Orders
  createOrder, createStoreOrder, updateOrder, getOrdersByOrg, getLatestPendingOrderByConversation, getOrdersAwaitingPayment, getActiveOrderForBot, getRecentDeliveredOrder,
  // Payment proofs
  savePaymentProof, getPaymentProofs, updatePaymentProof,
  // Contacts
  getContact, upsertContact, upsertShopifyCustomerProfile, updateContactClientType, setContactOptOut, touchLead, promoteToCustomer, getContacts, countContacts,
  // Settings
  getSetting, setSetting,
  // Escalation feedback
  saveEscalationFeedback, getEscalationNegativeExamples, setLastEscalation, clearLastEscalation,
  // Re-enganche: calibración, caché y predicciones
  saveCalibration, getCalibration,
  getDailyCache, saveDailyCache,
  savePredictions, markMessageSent,
  getPendingOutcomeCheck, saveOutcome, getAccuracyStats,
  // Bulk updates
  bulkUpdateBotOrderStatus, bulkUpdateShopifyOrderStatus,
  bulkDeleteBotOrders, bulkDeleteShopifyOrders,
  // Shopify orders cache
  upsertShopifyOrders, getShopifyOrders, getShopifyOrdersSyncedAt,
  // Admin relay
  createAdminPendingReply, getLatestPendingAdminReply, markAdminReplyHandled,
  // User management (RBAC)
  listOrgUsers, updateUserRole, deleteOrgUser,
  // Agentes WA
  getUserByWhatsappPhone, updateUserWaPhone, updateUserNotifications, getAgentsWithNotification, touchUserWaWindow,
};
