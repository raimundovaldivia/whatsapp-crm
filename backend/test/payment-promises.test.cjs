const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function service(overrides = {}) {
  return load('src/services/payment-promises.js', {
    '../db/database': { getPool: () => ({ query: async () => ({ rows: [] }) }) },
    './outbound-policy': { isCustomerMessagingHour: () => true },
    ...overrides,
  });
}

test('detecta una promesa de pago con fecha explícita en horario de Chile', () => {
  const promises = service();
  const promise = promises.detectPaymentPromise('El lunes deposito', '2026-10-17');
  assert.equal(promise.date, '2026-10-19');
  assert.match(promise.label, /lunes,? 19 de octubre/i);
  assert.equal(promises.detectPaymentPromise('el lunes te escribo', '2026-10-17'), null);
  assert.equal(promises.detectPaymentPromise('deposité ayer', '2026-10-17'), null);
});

test('reconoce fallas temporales de acceso bancario sin escalar', () => {
  const promises = service();
  assert.equal(promises.isTemporaryPaymentAccessIssue('Se me bloqueó la clave del banco'), true);
  assert.equal(promises.isTemporaryPaymentAccessIssue('La app no me deja entrar para transferir'), true);
  assert.equal(promises.isTemporaryPaymentAccessIssue('No quiero pagar'), false);
});

test('guardar un compromiso aplica organización e identificador del pedido', async () => {
  let query;
  const promises = service({
    '../db/database': {
      getPool: () => ({
        query: async (sql, params) => {
          query = { sql, params };
          return { rows: [{ id: '44', payment_promised_for: '2026-10-19' }] };
        },
      }),
    },
  });
  const saved = await promises.recordPaymentPromise(7, { source: 'bot', id: '44' }, { date: '2026-10-19' }, 'Deposito el lunes');
  assert.equal(saved.id, '44');
  assert.match(query.sql, /organization_id = \$3 AND id = \$4/);
  assert.deepEqual(Array.from(query.params), ['2026-10-19', 'Deposito el lunes', 7, 44]);
});
