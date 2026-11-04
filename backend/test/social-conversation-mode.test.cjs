const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

test('la bandeja social muestra el modo del bot sin leer conversaciones de otra tienda', async () => {
  const pool = new PGlite();
  try {
    await pool.exec(`
      CREATE TABLE conversations (id int, organization_id int, agent_mode text);
      CREATE TABLE meta_threads (id int, organization_id int, crm_conversation_id int, last_message_at timestamp);
      CREATE TABLE meta_messages (id int, thread_id int, content text, direction text, created_at timestamp);
      CREATE TABLE orders (id int, organization_id int, conversation_id int, status text, total_price numeric, created_at timestamp);
      INSERT INTO conversations VALUES (91,7,'coordinating'),(92,8,'human');
      INSERT INTO meta_threads VALUES (1,7,91,NOW()),(2,8,92,NOW()),(3,7,92,NOW());
    `);
    const router = load('src/routes/meta.js', {
      '../db/database': { getPool: () => pool },
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../middleware/commercial-access': { requireSolution: () => noop },
    });
    const res = response();
    await handler(router, 'get', '/threads')({ orgId: 7 }, res);
    assert.equal(res.body.threads.length, 2);
    assert.equal(res.body.threads.find(t => t.id === 1).agent_mode, 'coordinating');
    assert.equal(res.body.threads.find(t => t.id === 3).agent_mode, null);
    assert.equal(res.body.threads.some(t => t.organization_id === 8), false);
  } finally { await pool.close(); }
});

test('reactivar el bot usa el control existente y solo modifica una conversación de la tienda', async () => {
  let current = { id: 91, organization_id: 7, agent_mode: 'coordinating', order_draft: { customer_name: 'Prueba' } };
  const changes = [];
  const router = load('src/routes/conversations.js', {
    '../db/database': {
      getConversationById: async (id, orgId) => id === 91 && (orgId === undefined || orgId === 7) ? current : null,
      setAgentMode: async (id, mode) => { changes.push({ id, mode }); current = { ...current, agent_mode: mode }; },
    },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const change = handler(router, 'patch', '/:id/agent-mode');
  const res = response();
  await change({ orgId: 7, params: { id: '91' }, body: { mode: 'ai' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.agent_mode, 'ai');
  assert.equal(res.body.data.order_draft.customer_name, 'Prueba');
  for (const request of [
    { orgId: 8, params: { id: '91' }, body: { mode: 'ai' } },
    { orgId: 7, params: { id: '91' }, body: { mode: 'invalid' } },
  ]) {
    const denied = response();
    await change(request, denied);
    assert.ok([400, 404].includes(denied.code));
  }
  assert.deepEqual(changes, [{ id: 91, mode: 'ai' }]);
});
