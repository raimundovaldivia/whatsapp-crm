const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// En producción (Render) usar el disco persistente montado en /data
// En dev usar backend/data/crm.db (local)
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/crm.db'
  : path.join(__dirname, '../../data/crm.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// ─── ORGANIZATIONS ────────────────────────────────────────────────

function createOrganization({ name, slug }) {
  const d = getDb();
  const r = d.prepare(`INSERT INTO organizations (name, slug) VALUES (?, ?)`).run(name, slug);
  return d.prepare('SELECT * FROM organizations WHERE id = ?').get(r.lastInsertRowid);
}

function getOrgById(id) {
  return getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(id);
}

function markSetupDone(orgId) {
  getDb().prepare('UPDATE organizations SET setup_done = 1 WHERE id = ?').run(orgId);
}

// ─── USERS / AUTH ─────────────────────────────────────────────────

function createUser({ organizationId, email, passwordHash, name, role = 'owner' }) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO users (organization_id, email, password_hash, name, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(organizationId, email, passwordHash, name, role);
  return d.prepare('SELECT id, organization_id, email, name, role, created_at FROM users WHERE id = ?').get(r.lastInsertRowid);
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserById(id) {
  return getDb().prepare('SELECT id, organization_id, email, name, role FROM users WHERE id = ?').get(id);
}

// ─── WHATSAPP CONFIG ──────────────────────────────────────────────

function upsertWhatsappConfig(orgId, config) {
  const d = getDb();
  d.prepare(`
    INSERT INTO whatsapp_configs (
      organization_id, provider,
      phone_number_id, business_account_id, access_token, webhook_verify_token,
      twilio_account_sid, twilio_auth_token, twilio_phone_number,
      status
    )
    VALUES (
      @orgId, @provider,
      @phoneNumberId, @businessAccountId, @accessToken, @webhookVerifyToken,
      @twilioAccountSid, @twilioAuthToken, @twilioPhoneNumber,
      'connected'
    )
    ON CONFLICT(organization_id) DO UPDATE SET
      provider              = excluded.provider,
      phone_number_id       = excluded.phone_number_id,
      business_account_id   = excluded.business_account_id,
      access_token          = excluded.access_token,
      webhook_verify_token  = excluded.webhook_verify_token,
      twilio_account_sid    = excluded.twilio_account_sid,
      twilio_auth_token     = excluded.twilio_auth_token,
      twilio_phone_number   = excluded.twilio_phone_number,
      status                = 'connected'
  `).run({
    orgId,
    provider:           config.provider           || 'meta',
    phoneNumberId:      config.phoneNumberId      || null,
    businessAccountId:  config.businessAccountId  || null,
    accessToken:        config.accessToken        || null,
    webhookVerifyToken: config.webhookVerifyToken || null,
    twilioAccountSid:   config.twilioAccountSid   || null,
    twilioAuthToken:    config.twilioAuthToken     || null,
    twilioPhoneNumber:  config.twilioPhoneNumber  || null,
  });
}

// Buscar org por número Twilio (para el webhook de Twilio)
function getOrgByTwilioNumber(twilioPhoneNumber) {
  const wc = getDb().prepare('SELECT * FROM whatsapp_configs WHERE twilio_phone_number = ?').get(twilioPhoneNumber);
  if (!wc) return null;
  return { org: getOrgById(wc.organization_id), whatsappConfig: wc };
}

function getWhatsappConfig(orgId) {
  return getDb().prepare('SELECT * FROM whatsapp_configs WHERE organization_id = ?').get(orgId);
}

// Buscar org por webhook verify token (para el webhook de Meta)
function getOrgByWebhookToken(token) {
  const wc = getDb().prepare('SELECT * FROM whatsapp_configs WHERE webhook_verify_token = ?').get(token);
  if (!wc) return null;
  return { org: getOrgById(wc.organization_id), whatsappConfig: wc };
}

function getOrgByPhoneNumberId(phoneNumberId) {
  const wc = getDb().prepare('SELECT * FROM whatsapp_configs WHERE phone_number_id = ?').get(phoneNumberId);
  if (!wc) return null;
  return { org: getOrgById(wc.organization_id), whatsappConfig: wc };
}

// ─── DATA SOURCES ─────────────────────────────────────────────────

function createDataSource({ organizationId, type, name, config }) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO data_sources (organization_id, type, name, config)
    VALUES (?, ?, ?, ?)
  `).run(organizationId, type, name, JSON.stringify(config));
  return d.prepare('SELECT * FROM data_sources WHERE id = ?').get(r.lastInsertRowid);
}

function getDataSources(orgId) {
  return getDb().prepare('SELECT * FROM data_sources WHERE organization_id = ?').all(orgId);
}

function getDataSource(id, orgId) {
  const ds = getDb().prepare('SELECT * FROM data_sources WHERE id = ? AND organization_id = ?').get(id, orgId);
  if (ds) ds.config = JSON.parse(ds.config || '{}');
  return ds;
}

function updateDataSourceStatus(id, status) {
  getDb().prepare('UPDATE data_sources SET status = ?, last_sync_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
}

function getPrimaryDataSource(orgId) {
  const ds = getDb().prepare("SELECT * FROM data_sources WHERE organization_id = ? AND status = 'connected' LIMIT 1").get(orgId);
  if (ds) ds.config = JSON.parse(ds.config || '{}');
  return ds;
}

// ─── AGENTS ───────────────────────────────────────────────────────

function createAgent({ organizationId, dataSourceId, name, type, systemPrompt = null, config = {} }) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO agents (organization_id, data_source_id, name, type, system_prompt, config)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(organizationId, dataSourceId, name, type, systemPrompt, JSON.stringify(config));
  return d.prepare('SELECT * FROM agents WHERE id = ?').get(r.lastInsertRowid);
}

function getAgents(orgId) {
  return getDb().prepare('SELECT * FROM agents WHERE organization_id = ? ORDER BY type').all(orgId);
}

function createDefaultAgents(orgId, dataSourceId) {
  const d = getDb();
  const existing = d.prepare('SELECT COUNT(*) as n FROM agents WHERE organization_id = ?').get(orgId);
  if (existing.n > 0) return;

  const agents = [
    { type: 'orchestrator', name: 'Orquestador', systemPrompt: null },
    { type: 'sales',        name: 'Agente de Ventas', systemPrompt: null },
    { type: 'orders',       name: 'Agente de Órdenes', systemPrompt: null },
  ];
  for (const a of agents) {
    createAgent({ organizationId: orgId, dataSourceId, name: a.name, type: a.type });
  }
}

// ─── CONVERSATIONS ────────────────────────────────────────────────

function upsertConversation(orgId, phoneNumber, contactName = null) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM conversations WHERE organization_id = ? AND phone_number = ?').get(orgId, phoneNumber);
  if (existing) {
    if (contactName && contactName !== existing.contact_name) {
      d.prepare('UPDATE conversations SET contact_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contactName, existing.id);
    }
    return d.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
  }
  const r = d.prepare(`
    INSERT INTO conversations (organization_id, phone_number, contact_name) VALUES (?, ?, ?)
  `).run(orgId, phoneNumber, contactName || 'Cliente');
  return d.prepare('SELECT * FROM conversations WHERE id = ?').get(r.lastInsertRowid);
}

function getAllConversations(orgId) {
  return getDb().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
    FROM conversations c
    WHERE c.organization_id = ?
    ORDER BY c.last_message_at DESC
  `).all(orgId);
}

function getConversationById(id, orgId = null) {
  if (orgId) return getDb().prepare('SELECT * FROM conversations WHERE id = ? AND organization_id = ?').get(id, orgId);
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

function updateConversationLastMessage(id, message, incrementUnread = false) {
  const d = getDb();
  if (incrementUnread) {
    d.prepare(`UPDATE conversations SET last_message = ?, last_message_at = CURRENT_TIMESTAMP, unread_count = unread_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(message, id);
  } else {
    d.prepare(`UPDATE conversations SET last_message = ?, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(message, id);
  }
}

function markConversationAsRead(id) {
  getDb().prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(id);
}

function setAgentMode(id, mode) {
  getDb().prepare('UPDATE conversations SET agent_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mode, id);
}

function updatePipelineState(id, state, orderDraft = null) {
  const d = getDb();
  if (orderDraft !== null) {
    d.prepare('UPDATE conversations SET pipeline_state = ?, order_draft = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(state, JSON.stringify(orderDraft), id);
  } else {
    d.prepare('UPDATE conversations SET pipeline_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(state, id);
  }
}

function getOrderDraft(id) {
  const conv = getDb().prepare('SELECT order_draft FROM conversations WHERE id = ?').get(id);
  try { return JSON.parse(conv?.order_draft || '{}'); } catch { return {}; }
}

// ─── MESSAGES ─────────────────────────────────────────────────────

function saveMessage({ conversationId, whatsappMessageId, direction, content, type = 'text', status = 'sent', sentBy = 'ai', agentType = null }) {
  const d = getDb();
  try {
    const r = d.prepare(`
      INSERT INTO messages (conversation_id, whatsapp_message_id, direction, content, type, status, sent_by, agent_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conversationId, whatsappMessageId || null, direction, content, type, status, sentBy, agentType);
    return d.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
    throw err;
  }
}

function getMessagesByConversation(conversationId, limit = 50) {
  return getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?').all(conversationId, limit);
}

function getLastMessages(conversationId, limit = 10) {
  const rows = getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?').all(conversationId, limit);
  return rows.reverse();
}

function updateMessageStatus(whatsappMessageId, status) {
  getDb().prepare('UPDATE messages SET status = ? WHERE whatsapp_message_id = ?').run(status, whatsappMessageId);
}

// ─── PRODUCTS CACHE ───────────────────────────────────────────────

function cacheProducts(orgId, dataSourceId, products) {
  const d = getDb();
  const upsert = d.prepare(`
    INSERT INTO products_cache (organization_id, data_source_id, external_id, title, description, price, compare_at_price, sku, inventory_quantity, image_url, tags, product_type, handle, raw_json, cached_at)
    VALUES (@orgId, @dataSourceId, @externalId, @title, @description, @price, @compareAtPrice, @sku, @inventoryQuantity, @imageUrl, @tags, @productType, @handle, @rawJson, CURRENT_TIMESTAMP)
    ON CONFLICT(organization_id, data_source_id, external_id) DO UPDATE SET
      title = excluded.title, description = excluded.description, price = excluded.price,
      compare_at_price = excluded.compare_at_price, sku = excluded.sku,
      inventory_quantity = excluded.inventory_quantity, image_url = excluded.image_url,
      tags = excluded.tags, product_type = excluded.product_type,
      handle = excluded.handle, raw_json = excluded.raw_json, cached_at = CURRENT_TIMESTAMP
  `);
  const tx = d.transaction((prods) => { for (const p of prods) upsert.run(p); });
  tx(products.map(p => ({ orgId, dataSourceId, ...p })));
}

function getCachedProducts(orgId) {
  return getDb().prepare('SELECT * FROM products_cache WHERE organization_id = ? ORDER BY title ASC').all(orgId);
}

function getProductsCacheAge(orgId) {
  const row = getDb().prepare('SELECT MIN(cached_at) as oldest FROM products_cache WHERE organization_id = ?').get(orgId);
  if (!row?.oldest) return Infinity;
  return (Date.now() - new Date(row.oldest).getTime()) / 1000 / 60;
}

// ─── ORDERS ───────────────────────────────────────────────────────

function createOrder({ conversationId, organizationId, items, customerName, customerPhone, shippingAddress, totalPrice }) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO orders (conversation_id, organization_id, items, customer_name, customer_phone, shipping_address, total_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(conversationId, organizationId, JSON.stringify(items), customerName, customerPhone, JSON.stringify(shippingAddress), totalPrice);
  return d.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
}

function updateOrder(id, updates) {
  const d = getDb();
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  d.prepare(`UPDATE orders SET ${fields} WHERE id = ?`).run(...Object.values(updates), id);
  return d.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function getOrdersByOrg(orgId) {
  return getDb().prepare('SELECT * FROM orders WHERE organization_id = ? ORDER BY created_at DESC').all(orgId);
}

module.exports = {
  getDb,
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
  saveMessage, getMessagesByConversation, getLastMessages, updateMessageStatus,
  // Products
  cacheProducts, getCachedProducts, getProductsCacheAge,
  // Orders
  createOrder, updateOrder, getOrdersByOrg,
};
