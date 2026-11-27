const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture({ compose, defer, pool } = {}) {
  const requests = [];
  const sends = [];
  const notices = load('src/services/order-notices.js', {
    '../db/database': {
      normalizePhone: value => value.replace(/\D/g, ''),
      getEvolutionWhatsappChannel: async () => ({ id: 5, status: 'connected', provider: 'evolution' }),
      upsertConversation: async () => ({ id: 20 }),
      getPool: () => pool || ({ query: async () => ({ rows: [] }) }),
      saveMessage: async record => record, updateConversationLastMessage: async () => {},
    },
    './ai-provider': {
      modelFor: () => 'modelo-prueba',
      client: { messages: { create: async request => { requests.push(request); return compose(request); } } },
      responseText: result => result,
    },
    './evolution-whatsapp': { sendTextMessage: async (_phone, text) => { sends.push(text); return { messageId: 'evo-1' }; } },
    './outbound-message-queue': { deferOutsideHours: defer },
  });
  return { notices, requests, sends };
}

test('la IA redacta el cobro y los datos de transferencia y el importe se insertan del registro', async () => {
  const { notices, sends, requests } = fixture({ compose: () => 'NOMBRE, ¿nos ayudas a verificar el pago de PEDIDO por TOTAL?' });
  const { text } = await notices.send(1, { phone: '56911112222', customerName: 'Ana Soto', orderName: '#DR-828' },
    { kind: 'charge', fields: { TOTAL: '$19.000' }, details: 'Cuenta de prueba 123456' });
  assert.deepEqual(sends, ['Ana, ¿nos ayudas a verificar el pago de #DR-828 por $19.000?\nCuenta de prueba 123456']);
  assert.equal(text, sends[0]);
  assert.doesNotMatch(JSON.stringify(requests), /19\.000|123456|828|Ana Soto|56911112222/);
});

test('el resumen de compra generado conserva el horario de envío y el canal Evolution al encolar', async () => {
  const queued = [];
  const { notices, sends } = fixture({ compose: () => 'Registramos tu pedido PEDIDO.', defer: async args => { queued.push(args); return { id: 9 }; } });
  const result = await notices.send(1, { phone: '56911112222', orderName: '#DR-20' }, {kind: 'order_summary', respectSendingHours: true, details: '2 bandejas — $14.000'});
  assert.equal(result.queued, true);
  assert.equal(result.sent, false);
  assert.equal(queued[0].conversationId, 20);
  assert.equal(queued[0].sendingProvider, 'evolution');
  assert.ok(queued[0].text.endsWith('2 bandejas — $14.000'));
  assert.equal(sends.length, 0);
});

test('ningún identificador de redes sociales se transforma en un número de cliente', async () => {
  const { notices, sends, requests } = fixture();
  await assert.rejects(notices.send(1, { phone: 'instagram:1234567890' }, { kind: 'entregado' }), { code: 'NO_PHONE' });
  assert.equal(sends.length + requests.length, 0);
});

test('dos compras web simultáneas reservan redacciones distintas incluso con otros nombres y pedidos', async t => {
  const { PGlite } = require('@electric-sql/pglite');
  const engine = new PGlite();
  t.after(() => engine.close());
  class Pool {
    async connect() { return { query: sql => engine.exec(sql), release() {} }; }
    async end() {}
  }
  await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
  await engine.exec("INSERT INTO organizations (id, name, slug) VALUES (1, 'Diez Ríos', 'diez-rios')");
  const original = 'NOMBRE, recibimos tu compra PEDIDO.';
  const revised = '¡Gracias por tu pedido PEDIDO, NOMBRE! Te confirmaremos el despacho.';
  const candidates = [original, '¡NOMBRE! Recibimos tu compra PEDIDO ✅', revised];
  const { notices, sends, requests } = fixture({ pool: engine, compose: () => candidates.shift() || original });
  const send = (phone, customerName, orderName) => notices.send(1, { phone, customerName, orderName },
    { kind: 'web_order', details: 'Total: $14.000' });
  const results = await Promise.all([
    send('56911112222', 'Ana Soto', '#DR-10'),
    send('56933334444', 'Luis Vera', '#DR-11'),
  ]);
  assert.ok(results.every(result => result.sent));
  assert.equal(sends.filter(text => /recibimos tu compra/i.test(text)).length, 1);
  assert.equal(sends.filter(text => /Gracias por tu pedido/.test(text)).length, 1);
  assert.match(requests.at(-1).messages[0].content, /redacciones ya usadas/);
  await assert.rejects(send('56955556666', 'Luz Mora', '#DR-12'), { code: 'AI_NOTICE_INVALID' });
  assert.equal(sends.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /Ana|Luis|Luz|DR-1|14\.000|56911112222/);
});
