const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentBreakdown } = require('../src/utils/payment-breakdown');

test('pago mixto conserva ambos montos cuando suman el total', () => {
  assert.deepEqual(paymentBreakdown('mixto', 45000, 15000, 30000), { cash: 15000, transfer: 30000 });
});

test('pago mixto rechaza montos incompletos o sin participación de ambos medios', () => {
  assert.throws(() => paymentBreakdown('mixto', 45000, 15000, 25000), /sumar exactamente/);
  assert.throws(() => paymentBreakdown('mixto', 45000, 0, 45000), /sumar exactamente/);
});

test('pagos simples asignan el total al medio correspondiente', () => {
  assert.deepEqual(paymentBreakdown('efectivo', 12000), { cash: 12000, transfer: 0 });
  assert.deepEqual(paymentBreakdown('transferencia', 12000), { cash: 0, transfer: 12000 });
});
