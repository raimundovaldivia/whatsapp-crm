const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeliveredOrder, buildPaymentProofReply } = require('../src/services/payment-proof-reply');

test('recognizes an order delivered by timestamp even when its status is stale', () => {
  assert.equal(isDeliveredOrder({ status: 'payment_received', delivered_at: '2026-09-30T20:00:00Z' }), true);
});

test('post-delivery payment reply never promises another dispatch', () => {
  const reply = buildPaymentProofReply({
    order: { id: 3080, status: 'payment_received', delivered_at: '2026-09-30T20:00:00Z', total_price: 45000 },
    amountMatches: null,
    firstName: 'Yefferzon',
  });
  assert.match(reply, /pedido #3080/);
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
