const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const policy = require('../src/services/outbound-policy');

async function fixture(t) {
  const engine = new PGlite();
  t.after(() => engine.close());
  await engine.exec(`CREATE TABLE organizations(id INT PRIMARY KEY);
    INSERT INTO organizations VALUES(1);
    CREATE TABLE conversations(id INT PRIMARY KEY, organization_id INT, phone_number TEXT, whatsapp_channel_id INT, pipeline_state TEXT);
    INSERT INTO conversations VALUES(11,1,'56911111111',5,'exploring'),(12,1,'56922222222',5,'exploring');
    CREATE TABLE messages(id SERIAL PRIMARY KEY, conversation_id INT, direction TEXT, content TEXT, type TEXT, status TEXT,
      sent_by TEXT, agent_type TEXT, outbound_queue JSONB, whatsapp_message_id TEXT UNIQUE, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE contacts(organization_id INT, phone TEXT, opt_out BOOLEAN);
    CREATE TABLE delivery_routes(id INT PRIMARY KEY, organization_id INT, status TEXT, stop_statuses JSONB, orders JSONB);
    CREATE TABLE delivery_customer_events(id INT PRIMARY KEY,organization_id INT,status TEXT,sent_at TIMESTAMPTZ,last_error TEXT,updated_at TIMESTAMPTZ);
    INSERT INTO delivery_routes VALUES(7,1,'in_progress','{}','[{"source":"bot","id":836}]');
    INSERT INTO delivery_customer_events VALUES(18,1,'pending',NULL,NULL,NOW());`);
  let available = Promise.resolve();
  const pool = { connect: async () => {
    const previous = available;
    let release;
    available = new Promise(resolve => { release = resolve; });
    await previous;
    return { query: (sql,args) => engine.query(sql,args), release };
  }, query: async (sql,args) => {
    const client = await pool.connect();
    try { return await client.query(sql,args); } finally { client.release(); }
  } };
  await load('src/db/setup.js', { pg: {} }).ensureOrderNoticeLanes(pool);
  const config = { id: 5, provider: 'evolution', status: 'connected' };
  const db = { getPool: () => pool, normalizePhone: value => value, getWhatsappChannel: async () => config, updateConversationLastMessage: async () => {} };
  const createService = () => load('src/services/order-notice-queue.js', { '../db/database': db, './outbound-policy': policy });
  const service = createService();
  const phones = ['56911111111','56922222222'];
  const enqueue = (i, kind, ref = {}) => service.enqueue({ orgId: 1, conversationId: 11 + i, phone: phones[i], channelId: 5,
    kind, text: 'Texto transaccional ' + kind, agentType: kind, ref });
  const sent = [];
  let ms = new Date('2099-02-04T15:00:00Z').getTime();
  const options = { pool, clock: () => new Date(ms), send: async (...args) => { sent.push(args); return { messageId: 'evo-' + sent.length }; } };
  const advance = n => { ms += n * 1000; };
  return { pool, enqueue, service, createService, options, advance, sent, config };
}

test('una sola cola para tipos y destinatarios distintos, con 120 segundos entre aceptaciones incluso tras reiniciar', async t => {
  const f = await fixture(t);
  const ref = { key: 'event:18', deliveryEventId: 18, routeId: 7, stopKey: 'bot_836' };
  const one = await f.enqueue(0, 'delivery_consolidated', ref);
  const duplicate = await f.enqueue(0, 'delivery_consolidated', ref);
  const two = await f.enqueue(1, 'entregado');
  assert.equal(one.message.id, duplicate.message.id);
  assert.ok(one.queued && two.queued && !one.sent);
  assert.equal(f.sent.length, 0);
  const workers = [f.service, f.createService()];
  await Promise.all(workers.map(worker => worker.tick(1, f.options)));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], '56911111111');
  assert.equal((await f.pool.query('SELECT status FROM delivery_customer_events')).rows[0].status, 'sent');
  f.advance(119);
  await f.createService().tick(1, f.options);
  assert.equal(f.sent.length, 1);
  f.advance(1);
  await f.createService().tick(1, f.options);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1][0], '56922222222');
  assert.ok((await f.pool.query('SELECT * FROM messages')).rows.every(m => m.whatsapp_message_id && m.outbound_queue.state === 'sent'));
});

test('una parada entregada sale de la cola sin enviar el aviso de reparto; un envío incierto no se repite', async t => {
  const f = await fixture(t);
  await f.enqueue(0, 'delivery_consolidated', { routeId: 7, stopKey: 'bot_836', key: 'route-7' });
  await f.pool.query(`UPDATE delivery_routes SET stop_statuses='{"bot_836":"entregado"}'`);
  assert.equal((await f.service.tick(1, f.options)).outbound_queue.state, 'cancelled');
  await f.enqueue(1, 'web_order', { key: 'web-2' });
  f.config.status = 'disconnected';
  assert.equal((await f.service.tick(1, f.options)).outbound_queue.state, 'queued');
  f.config.status = 'connected'; f.advance(30);
  const uncertain = await f.service.tick(1, { ...f.options, send: async () => { throw new Error('timeout'); } });
  assert.equal(uncertain.outbound_queue.state, 'uncertain');
  f.advance(180);
  assert.equal(await f.createService().tick(1, f.options), undefined);
  await assert.rejects(f.enqueue(1, 'web_order', { key: 'web-2' }), { code: 'NOTICE_REQUIRES_REVIEW' });
  assert.equal(f.sent.length, 0);
});
