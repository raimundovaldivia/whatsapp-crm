const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeliveredOrder, buildPaymentProofReply, isPaymentProofClarification } = require('../src/services/payment-proof-reply');
const { load } = require('./helpers.cjs');

const receipt = { direction: 'outbound', content: buildPaymentProofReply({
  order: { id: 12, status: 'entregado' }, amountMatches: true, amountText: '$20.100',
}) };

test('una aclaración sobre el titular después del comprobante no reactiva el carrito', async () => {
  const message = 'Lo realice el mismo día pero desde la cuenta de mi hija';
  const history = [
    { direction: 'outbound', content: '¿Quieres repetir las dos bandejas?' },
    { direction: 'inbound', type: 'image', content: '📸 [Comprobante de pago]' },
    receipt, { direction: 'inbound', content: message },
  ];
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': {
      getConversationById: async () => ({ pipeline_state: 'done' }),
      getLastMessages: async () => history,
    },
    './commercial': { consumeBotTurn: async () => {} },
  });
  const result = await pipeline.processMessage(1, 1, message);
  assert.match(result.response, /gracias por aclararlo.*comprobante/i);
  assert.equal(result.newState, 'done');
  assert.doesNotMatch(result.response, /pedido|bandeja|confirmas|pagado/i);
});

test('el acuse solo cubre aclaraciones de pago en respuesta al comprobante', () => {
  for (const message of ['Transferí ayer', 'Mi esposo hizo la transferencia', 'Fue desde otra cuenta']) {
    assert.equal(isPaymentProofClarification(message, [receipt]), true);
  }
  for (const message of ['Quiero otras dos bandejas', 'Pagué ayer y quiero repetir mi pedido',
    '¿Puedo pagar desde la cuenta de mi hija?', 'No pagué ayer', 'Hoy', 'Pagué dos veces']) {
    assert.equal(isPaymentProofClarification(message, [receipt]), false);
  }
  assert.equal(isPaymentProofClarification('Transferí ayer', []), false);
  assert.equal(isPaymentProofClarification('Transferí ayer', [receipt, {
    direction: 'outbound', content: '¿Cuándo quieres recibir el nuevo pedido?',
  }]), false);
});

test('recognizes an order delivered by timestamp even when its status is stale', () => {
  assert.equal(isDeliveredOrder({ status: 'payment_received', delivered_at: '2026-09-30T20:00:00Z' }), true);
});

test('post-delivery payment reply never promises another dispatch', () => {
  const reply = buildPaymentProofReply({
    order: { id: 3080, status: 'payment_received', delivered_at: '2026-09-30T20:00:00Z', total_price: 45000 },
    amountMatches: null,
    firstName: 'Yefferzon',
  });
  assert.match(reply, /pedido #DR-3080/);
  assert.doesNotMatch(reply, /despach|listo para/i);
});

test('unmatched proof receives a neutral confirmation when no order is found', () => {
  const reply = buildPaymentProofReply({ order: null, amountMatches: null, firstName: 'Yefferzon' });
  assert.match(reply, /verificaremos/i);
  assert.doesNotMatch(reply, /despach|listo para/i);
});

test('pre-delivery matched payment does not claim a dispatch state', () => {
  const reply = buildPaymentProofReply({
    order: { id: 3080, status: 'por_despachar', total_price: 45000 },
    amountMatches: true,
    amountText: '$45.000',
    firstName: 'Yefferzon',
  });
  assert.match(reply, /pago de \$45\.000 quedó registrado/i);
  assert.doesNotMatch(reply, /despach|listo para/i);
});
