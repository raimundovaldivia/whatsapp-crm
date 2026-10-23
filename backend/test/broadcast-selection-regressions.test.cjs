const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');
const purchases = require('../src/services/broadcast-purchases');
const identity = require('../src/services/customer-identity');

test('profile edits do not fabricate purchases; selector and AI share real, deduplicated tenant history', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool { query(...args) { return query(...args); } async connect() { return { query, release() {} }; } async end() {} }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec("INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b')");
    const db = load('src/db/database.js', { pg: { Pool } });
    await db.upsertContact(1, { phone: '56911111111', name: 'Ana', address: 'Calle 1' });
    await engine.exec("UPDATE contacts SET total_orders=99,last_order_at='2026-10-22T12:00:00Z' WHERE organization_id=1");
    const beforeEdit = await db.getContact(1, '56911111111');
    for (let i = 0; i < 3; i++) await db.upsertContact(1, { phone: '56911111111', address: 'Calle 2' });
    const profile = await db.getContact(1, '56911111111');
    assert.equal(profile.total_orders, 99, 'editing a profile must not increment order counters');
    assert.equal(String(profile.last_order_at), String(beforeEdit.last_order_at));
    await db.upsertContact(1, { phone: '56922222222', name: 'Lead', address: 'Calle 3' });
    await engine.exec(`
      INSERT INTO shopify_orders(organization_id,shopify_order_id,customer_phone,shopify_created_at,financial_status,items)
        VALUES(1,'123','+56 9 1111 1111','2026-09-30T12:00:00Z','paid','[]'),
              (2,'456','56911111111','2026-10-22T12:00:00Z','paid','[]');
      INSERT INTO orders(organization_id,customer_phone,created_at,status,items,shopify_order_id)
        VALUES(1,'911111111','2026-10-01T12:00:00Z','paid','[]',NULL),
              (1,'56911111111','2026-10-20T12:00:00Z','paid','[]','gid://shopify/Order/123'),
              (1,'56911111111','2026-10-22T12:00:00Z','draft','[]',NULL),
              (1,'56911111111','2026-10-22T12:00:00Z','cancelled','[]',NULL),
              (1,'56911111111','2026-10-22T12:00:00Z','sent','[]',NULL);
    `);
    const ledger = await purchases.loadPurchases(db.getPool(), 1);
    assert.equal(ledger.length, 2, 'CRM mirror, drafts, unpaid requests and other tenant are not purchases');
    const router = load('src/routes/contacts.js', {
      '../db/database': db, '../services/customer-identity': identity,
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    });
    const res = response();
    await handler(router, 'get', '/broadcast')({ orgId: 1 }, res);
    assert.equal(res.code, 200);
    const selected = res.body.contacts.find(c => c.phone === '56911111111');
    assert.equal(selected.total_orders, 2, 'corrupted cached count is ignored immediately, without a data migration');
    assert.equal(new Date(selected.last_order_at).toISOString().slice(0, 10), '2026-10-01');
    const lead = res.body.contacts.find(c => c.phone === '56922222222');
    assert.equal(lead.total_orders, 0);
    assert.equal(lead.last_order_at, null, 'an address alone never qualifies a non-buyer');
    await engine.exec(`
      INSERT INTO conversations(id,organization_id,phone_number) VALUES(1,1,'56911111111');
      INSERT INTO messages(conversation_id,direction,content,whatsapp_message_id,status)
        VALUES(1,'outbound','¿Quieres repetir los XL?','promo-id','sent'),
              (1,'outbound','Recibimos tu pago','receipt-id','sent');
      INSERT INTO broadcast_campaigns(id,organization_id,template_name,total_count) VALUES(1,1,'Campaña',2);
      INSERT INTO broadcast_campaign_recipients(campaign_id,organization_id,template_name,whatsapp_message_id,result_status)
        VALUES(1,1,'Redacción individual · Evolution','promo-id','accepted'),
              (1,1,'cobro_transferencia','receipt-id','accepted');
    `);
    const messages = await db.getMessagesByCustomerPhone(1, '56911111111', 80, true);
    assert.equal(messages.find(m => m.whatsapp_message_id === 'promo-id').is_marketing, true);
    assert.equal(messages.find(m => m.whatsapp_message_id === 'receipt-id').is_marketing, false);
    const drafts = load('src/services/broadcast-drafts.js', {
      '../db/database': { ...db, getProducts: async () => [], getMessagesByCustomerPhone: async () => [] },
      './customer-identity': identity,
      './ai-provider': { modelFor: () => 'test' },
    });
    let evidence;
    const ai = { messages: { create: async request => {
      evidence = JSON.parse(request.messages[0].content).cliente.compras;
      assert.match(request.system, /Nunca excluyas sólo por ciclo habitual/);
      return { content: [{ type: 'tool_use', name: 'customer_draft', input: {
        decision: 'draft', reason: 'Compradora real', message: 'Hola Ana, ¿te gustaría volver a pedir huevos XL?',
      } }] };
    } } };
    await drafts.generateDrafts(1, { phones: ['56911111111'], instruction: 'Invita a repetir huevos XL sin inventar precios.' }, ai);
    assert.equal(evidence.cantidadPedidos, selected.total_orders);
    assert.equal(evidence.ultimaCompra, '2026-10-01');
    assert.equal(evidence.pedidos.length, 2);
  } finally { await engine.close(); }
});

test('campaign silence ignores payment replies, failed messages and ordinary refusals, but preserves true opt-outs', () => {
  const { messageSafety } = load('src/services/broadcast-drafts.js');
  const inbound = content => ({ direction: 'inbound', content, created_at: '2026-10-20T15:00:00Z' });
  const outbound = (content, extra = {}) => ({ direction: 'outbound', content, status: 'sent', created_at: '2026-10-21T15:00:00Z', ...extra });
  for (const content of ['No gracias, por ahora tengo huevos', 'No necesito factura', 'No quiero queso', 'No me manden factura', 'No me manden queso']) {
    assert.equal(messageSafety([inbound(content)], '2026-10-22').explicitDecline, false, content);
  }
  for (const content of ['No me escriban más', 'Quiero darme de baja', 'No quiero recibir promociones', 'STOP', 'SALIR']) {
    assert.equal(messageSafety([inbound(content)], '2026-10-22').explicitDecline, true, content);
  }
  assert.equal(messageSafety([{ direction: 'outbound', content: 'Si no deseas recibir mensajes, responde NO', created_at: '2026-10-19T15:00:00Z' }, inbound('NO')], '2026-10-22').explicitDecline, true);
  assert.equal(messageSafety([inbound('NO')], '2026-10-22').explicitDecline, false);
  assert.equal(messageSafety([inbound('Gracias'), outbound('Gracias, recibimos tu pago')], '2026-10-22').unansweredRecentOutreach, false);
  assert.equal(messageSafety([outbound('Oferta de huevos', { status: 'failed', is_marketing: true })], '2026-10-22').unansweredRecentOutreach, false);
  assert.equal(messageSafety([inbound('No necesito factura')], '2026-10-22').recentDecline, false);
  assert.equal(messageSafety([outbound('¿Te gustaría repetir los XL?', { is_marketing: true })], '2026-10-22').unansweredRecentOutreach, true);
  assert.equal(messageSafety([outbound('Oferta de huevos', { created_at: '2026-10-01T15:00:00Z' }), outbound('Pago recibido')], '2026-10-22').unansweredRecentOutreach, false);
});

test('real purchase statistics combine historical phone aliases without changing other people', () => {
  const raw = [
    { phone: '56911111111', email: 'a@example.com', last_order_at: '2026-09-01' },
    { phone: '56922222222', email: 'a@example.com', last_order_at: '2026-10-01' },
    { phone: '56933333333', name: 'Ana' },
  ];
  const contacts = identity.consolidateBroadcastContacts(raw);
  const rows = [
    { phone: '56911111111', date: '2026-09-01', status: 'paid' },
    { phone: '56922222222', date: '2026-10-01', status: 'paid' },
  ];
  const result = purchases.withPurchaseStats(contacts, raw, rows);
  assert.equal(result.find(c => c.phone === '56922222222').total_orders, 2);
  assert.equal(result.find(c => c.phone === '56933333333').total_orders, 0);
});
