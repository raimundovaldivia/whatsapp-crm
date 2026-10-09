const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function service(settings = {}, bankDetails = '') {
  return load('src/services/payment-options.js', {
    '../db/database': { getSetting: async (_orgId, key) => settings[key] || null },
    './payment-collection': { getChargeSettings: async () => ({ bankDetails }) },
  });
}

test('arma las opciones con los métodos y las instrucciones oficiales configuradas', async () => {
  const payment = service({
    payment_info: 'Diez Ríos SpA\nBanco Santander · Cuenta 123',
    delivery_info: JSON.stringify({ paymentMethods: 'Transferencia o efectivo' }),
  });
  assert.equal(
    await payment.buildPaymentOptionsMessage(7),
    '💳 *Opciones de pago*\n\nPuedes pagar con: Transferencia o efectivo.\n\nDiez Ríos SpA\nBanco Santander · Cuenta 123'
  );
});

test('usa los datos de cobranza como respaldo sin inventar información', async () => {
  const payment = service({}, 'Banco Estado · Cuenta 456');
  assert.match(await payment.buildPaymentOptionsMessage(7), /Banco Estado · Cuenta 456/);
  assert.equal(service().composePaymentOptions(), '');
});
