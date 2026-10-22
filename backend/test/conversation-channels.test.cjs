const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

test('buscar por teléfono devuelve el canal personal identificado como repartidor y aislado por organización', async () => {
  let captured;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [
        { id: 20, phone_number: '56962496975', whatsapp_channel_id: 2, whatsapp_channel_assigned_user_id: null },
        { id: 21, phone_number: '56962496975', whatsapp_channel_id: 7, whatsapp_channel_assigned_user_id: 9, whatsapp_channel_assignee: 'Pedro Ruta' },
      ] };
    },
  };
  const database = { getPool: () => pool };
  const router = load('src/routes/conversations.js', {
    '../db/database': database,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const res = response();
  await handler(router, 'get', '/search-by-phone')({ orgId: 3, query: { phone: '+56 9 6249 6975' } }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.conversations.length, 2);
  assert.equal(res.body.conversations[1].whatsapp_channel_assignee, 'Pedro Ruta');
  assert.equal(captured.params[0], 3);
  assert.match(captured.sql, /assigned_user\.organization_id = c\.organization_id/);
});
