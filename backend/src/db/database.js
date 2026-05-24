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
    'SELECT id, organization_id, email, name, role FROM users WHERE id = $1',
    [id]
  );
}

// ─── WHATSAPP CONFIG ──────────────────────────────────────────────

async function upsertWhatsappConfig(orgId, config) {
  await pool.query(
    `INSERT INTO whatsapp_configs (
      organization_id, provider,
      phone_number_id, business_account_id, access_token, webhook_verify_token,
      twilio_account_sid, twilio_auth_token, twilio_phone_number,
      kapso_api_key, webhook_secret, kapso_customer_id,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'connected')
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

// ─── CONVERSATIONS ────────────────────────────────────────────────

async function upsertConversation(orgId, phoneNumber, contactName = null) {
  const existing = await queryOne(
    'SELECT * FROM conversations WHERE organization_id = $1 AND phone_number = $2',
    [orgId, phoneNumber]
  );
  if (existing) {
    if (contactName && contactName !== existing.contact_name) {
      await pool.query(
        'UPDATE conversations SET contact_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [contactName, existing.id]
      );
    }
    return queryOne('SELECT * FROM conversations WHERE id = $1', [existing.id]);
  }
  return queryOne(
    `INSERT INTO conversations (organization_id, phone_number, contact_name) VALUES ($1, $2, $3) RETURNING *`,
    [orgId, phoneNumber, contactName || 'Cliente']
  );
}

async function getAllConversations(orgId) {
  return query(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
     FROM conversations c
     WHERE c.organization_id = $1
     ORDER BY c.last_message_at DESC`,
    [orgId]
  );
}

async function getConversationById(id, orgId = null) {
  if (orgId) {
    return queryOne('SELECT * FROM conversations WHERE id = $1 AND organization_id = $2', [id, orgId]);
  }
  return queryOne('SELECT * FROM conversations WHERE id = $1', [id]);
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

async function markConversationAsRead(id) {
  await pool.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);
}

async function setAgentMode(id, mode) {
  await pool.query(
    'UPDATE conversations SET agent_mode = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [mode, id]
  );
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

// ─── MESSAGES ─────────────────────────────────────────────────────

async function saveMessage({ conversationId, whatsappMessageId, direction, content, type = 'text', status = 'sent', sentBy = 'ai', agentType = null }) {
  try {
    return await queryOne(
      `INSERT INTO messages (conversation_id, whatsapp_message_id, direction, content, type, status, sent_by, agent_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (whatsapp_message_id) DO NOTHING
       RETURNING *`,
      [conversationId, whatsappMessageId || null, direction, content, type, status, sentBy, agentType]
    );
  } catch (err) {
    if (err.code === '23505') return null; // fallback por si acaso
    throw err;
  }
}

async function getMessagesByConversation(conversationId, limit = 50) {
  return query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2',
    [conversationId, limit]
  );
}

async function getLastMessages(conversationId, limit = 10) {
  const rows = await query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [conversationId, limit]
  );
  return rows.reverse();
}

async function updateMessageStatus(whatsappMessageId, status) {
  await pool.query(
    'UPDATE messages SET status = $1 WHERE whatsapp_message_id = $2',
    [status, whatsappMessageId]
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
  return query('SELECT * FROM products_cache WHERE organization_id = $1 ORDER BY title ASC', [orgId]);
}

async function getProductsCacheAge(orgId) {
  const row = await queryOne('SELECT MIN(cached_at) as oldest FROM products_cache WHERE organization_id = $1', [orgId]);
  if (!row?.oldest) return Infinity;
  return (Date.now() - new Date(row.oldest).getTime()) / 1000 / 60;
}

// ─── ORDERS ───────────────────────────────────────────────────────

async function createOrder({ conversationId, organizationId, items, customerName, customerPhone, shippingAddress, totalPrice }) {
  return queryOne(
    `INSERT INTO orders (conversation_id, organization_id, items, customer_name, customer_phone, shipping_address, total_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [conversationId, organizationId, JSON.stringify(items), customerName, customerPhone, JSON.stringify(shippingAddress), totalPrice]
  );
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
     SET last_escalation_trigger = $1, last_escalation_reason = $2, last_escalation_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [triggerMessage, reason, conversationId]
  );
}

async function clearLastEscalation(conversationId) {
  await pool.query(
    `UPDATE conversations
     SET last_escalation_trigger = NULL, last_escalation_reason = NULL, last_escalation_at = NULL
     WHERE id = $1`,
    [conversationId]
  );
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

module.exports = {
  getPool,
  // Orgs
  createOrganization, getOrgById, markSetupDone,
  // Users
  createUser, getUserByEmail, getUserById,
  // WhatsApp
  upsertWhatsappConfig, getWhatsappConfig, getOrgByWebhookToken, getOrgByPhoneNumberId, getOrgByTwilioNumber,
  // Data sources
  createDataSource, getDataSources, getDataSource, updateDataSourceStatus, getPrimaryDataSource,
  // Agents
  createAgent, getAgents, createDefaultAgents,
  // Conversations
  upsertConversation, getAllConversations, getConversationById,
  updateConversationLastMessage, markConversationAsRead, setAgentMode,
  updatePipelineState, getOrderDraft,
  // Messages
  saveMessage, getMessagesByConversation, getLastMessages, updateMessageStatus, minutesSinceLastHumanReply,
  // Products
  cacheProducts, getCachedProducts, getProductsCacheAge,
  // Orders
  createOrder, updateOrder, getOrdersByOrg,
  // Settings
  getSetting, setSetting,
  // Escalation feedback
  saveEscalationFeedback, getEscalationNegativeExamples, setLastEscalation, clearLastEscalation,
};
