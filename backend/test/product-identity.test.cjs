const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalizeProductItem, productMatchesQuery } = require('../src/services/product-identity');

test('normaliza nombres históricos de huevos sin mezclar calibre ni presentación', () => {
  const jumbo20 = canonicalizeProductItem({ name: 'Huevos de Campo Tamaño Jumbo – Bandeja 20 Unidades' });
  const jumbo40 = canonicalizeProductItem({ name: '40 huevos Jumbo' });
  const xl30 = canonicalizeProductItem({ name: 'Huevos de Campo Tamaño XL – Bandeja 30 Unidades' });
  assert.equal(jumbo20.product_label, 'Huevos Jumbo · 20 unidades');
  assert.equal(jumbo40.product_label, 'Huevos Jumbo · 40 unidades');
  assert.notEqual(jumbo20.product_key, jumbo40.product_key);
  assert.notEqual(jumbo20.product_key, xl30.product_key);
});

test('une los títulos históricos de queso de cabra 800 y 900 g', () => {
  const a = canonicalizeProductItem({ name: 'Queso de Cabra Fresco Pasteurizado – 900 g' });
  const b = canonicalizeProductItem({ name: 'Queso de Cabra Fresco Pasteurizado – 800 g' });
  assert.equal(a.product_key, b.product_key);
  assert.equal(a.product_label, 'Queso de cabra · pieza 900 g');
});

test('protege combos y permite buscar por identidad canónica', () => {
  const combo = canonicalizeProductItem({ name: 'Combo especial: queso de cabra + huevos Jumbo' });
  assert.match(combo.product_key, /^raw:/);
  assert.equal(productMatchesQuery({ name: '30 HUEVOS JUMBO' }, 'Huevos Jumbo'), true);
});
