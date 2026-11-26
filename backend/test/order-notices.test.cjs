const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture({ compose, defer } = {}) {
  const requests = [];
  const sends = [];
  const notices = load('src/services/order-notices.js', {
    '../db/database': {
      normalizePhone: value => value.replace(/\D/g, ''),
      getEvolutionWhatsappChannel: async () => ({ id: 5, status: 'connected', provider: 'evolution' }),
      upsertConversation: async () => ({ id: 20 }),
      getPool: () => ({ query: async () => ({ rows: [] }) }),
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
