const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/services/order-input-policy');

test('detecta cantidades alfanuméricas ambiguas sin bloquear cantidades válidas', () => {
  assert.equal(policy.ambiguousQuantityToken('necesito 3o L café'), '3o');
  assert.equal(policy.ambiguousQuantityToken('quiero 30 huevos L café'), null);
  assert.equal(policy.ambiguousQuantityToken('quiero 3 cajas'), null);
});

test('un sí aislado no puede introducir un producto distinto en un pedido existente', () => {
  const previous = { items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }] };
  const renamed = { product_name: 'Bandeja 30 huevos XL café', quantity: 1 };
  const cheese = { product_name: 'Queso de cabra 900 g', quantity: 1 };

  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí', previous, { items: [renamed] }), []);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí', previous, { items: [renamed, cheese] }), [cheese]);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí, gracias', previous, { items: [renamed, cheese] }), [cheese]);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí, por favor', previous, { items: [renamed, cheese] }), [cheese]);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí, agrega un queso', previous, { items: [renamed, cheese] }), []);
});

test('reconoce intención mayorista y evita falsos positivos pequeños', () => {
  for (const text of ['venta por mayor', 'precio para empresa', 'quiero un paled', 'necesito 4 cajas']) {
    assert.equal(policy.isWholesaleInquiry(text), true, text);
  }
  for (const text of ['quiero una caja', 'precio de una bandeja', 'necesito 2 cajas']) {
    assert.equal(policy.isWholesaleInquiry(text), false, text);
  }
});
