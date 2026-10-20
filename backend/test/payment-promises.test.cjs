const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('detecta una promesa de pago futura y descarta frases sin fecha', () => {
  const service = load('src/services/payment-promises.js', {
    '../db/database': { getPool: () => ({}) },
    './outbound-policy': { isCustomerMessagingHour: () => true },
  });
  const promise = service.detectPaymentPromise('El lunes deposito', '2026-10-17');
  assert.equal(promise.date, '2026-10-19');
  assert.match(promise.label, /lunes,? 19 de octubre/i);
  assert.equal(service.detectPaymentPromise('Deposito', '2026-10-17'), null);
  assert.equal(service.detectPaymentPromise('El lunes entregan?', '2026-10-17'), null);
});

test('reconoce problemas temporales de acceso bancario sin confundir una consulta normal', () => {
  const service = load('src/services/payment-promises.js', {
    '../db/database': { getPool: () => ({}) },
    './outbound-policy': { isCustomerMessagingHour: () => true },
  });
  assert.equal(service.isTemporaryPaymentAccessIssue('Se me bloqueó la clave del Banco'), true);
  assert.equal(service.isTemporaryPaymentAccessIssue('¿Cuál es la cuenta del banco?'), false);
});

test('guardar una promesa siempre incluye organización y pedido', async () => {
  const calls = [];
  const service = load('src/services/payment-promises.js', {
    '../db/database': { getPool: () => ({ query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: '88', payment_promised_for: '2026-10-19' }] };
    } }) },
    './outbound-policy': { isCustomerMessagingHour: () => true },
  });
  await service.recordPaymentPromise(7, { source: 'bot', id: '88' }, { date: '2026-10-19' }, 'El lunes deposito');
  assert.match(calls[0].sql, /organization_id = \$3 AND id = \$4/);
  assert.equal(calls[0].params[2], 7);
  assert.equal(calls[0].params[3], 88);
});
