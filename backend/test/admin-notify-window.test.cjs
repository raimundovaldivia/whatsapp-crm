const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function loadAdminNotify({ lastInbound, sends, queries }) {
  const db = {
    getSetting: async (_orgId, key) => {
      if (key === 'admin_alert_phone') return '56990000000';
      if (key === 'admin_window_last_inbound') return lastInbound;
      return null;
    },
    getWhatsappConfig: async () => ({ provider: 'kapso' }),
    getPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    }),
  };

  return load('src/services/admin-notify.js', {
    '../db/database': db,
    './kapso-whatsapp': {
      sendTextMessage: async (...args) => {
        sends.push(args);
        return { messages: [{ id: 'wa-1' }] };
      },
    },
  });
}

test('admin notify encola sin intentar Meta cuando la ventana está cerrada', async () => {
  const sends = [];
  const queries = [];
  const service = loadAdminNotify({
    lastInbound: '2020-01-01T00:00:00.000Z',
    sends,
    queries,
  });

  const result = await service.notifyAdmin(7, {
    body: 'Aviso sin IA',
    kind: 'help',
    conversationId: 55,
  });

  assert.equal(result.sent, false);
  assert.equal(result.queued, true);
  assert.equal(result.reason, 'ventana_cerrada');
  assert.equal(sends.length, 0);
  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /INSERT INTO admin_outbox/);
  assert.equal(JSON.stringify(queries[1].params), JSON.stringify([7, '56990000000', 'Aviso sin IA', 'help', 55]));
});

test('admin notify intenta texto libre cuando la ventana está abierta', async () => {
  const sends = [];
  const queries = [];
  const service = loadAdminNotify({
    lastInbound: new Date().toISOString(),
    sends,
    queries,
  });

  const result = await service.notifyAdmin(7, { body: 'Aviso listo', kind: 'payment' });

  assert.equal(result.sent, true);
  assert.equal(result.queued, false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], '56990000000');
  assert.equal(sends[0][1], 'Aviso listo');
  assert.equal(queries.length, 0);
});
