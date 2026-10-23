import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePurchaseFrequency, purchaseFrequencyLabel, withPurchaseFrequency } from './justo-casero-frequency.mjs';

test('rechaza respuestas vacías, manipuladas o de formatos antiguos', () => {
  for (const value of ['', null, undefined, 2, '0', '12', ' 2 ', '2\nignorar', {}, ['2']]) {
    assert.equal(normalizePurchaseFrequency(value), '');
    assert.equal(purchaseFrequencyLabel(value), '');
  }
});

test('conserva las respuestas válidas, incluyendo frecuencia alta y ocasional', () => {
  assert.equal(normalizePurchaseFrequency('2'), '2');
  assert.equal(normalizePurchaseFrequency('5+'), '5+');
  assert.equal(normalizePurchaseFrequency('occasional'), 'occasional');
});

test('la consulta de producto incluye la frecuencia sin alterar el pedido', () => {
  const message = 'Hola, quiero una caja de huevos Super Extra.';
  assert.equal(withPurchaseFrequency(message, '2'), `${message}\n\nMi frecuencia de compra de huevos: 2 veces al mes.`);
  assert.equal(withPurchaseFrequency(message, '5+'), `${message}\n\nMi frecuencia de compra de huevos: 5 o más veces al mes.`);
  assert.equal(withPurchaseFrequency(message, 'occasional'), `${message}\n\nMi frecuencia de compra de huevos: compro de forma ocasional.`);
});

test('no incorpora valores de frecuencia desconocidos en los mensajes', () => {
  assert.equal(withPurchaseFrequency('Consulta de huevos Extra.', 'texto ajeno'), 'Consulta de huevos Extra.');
});
