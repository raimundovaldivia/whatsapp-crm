import test from 'node:test';
import assert from 'node:assert/strict';
import { eggColor, eggImage, matchesEggColor } from './egg-products.js';

test('structured egg color takes precedence over the product title', () => {
  const product = { title: 'Huevos XL mixtos · Bandeja de 30', egg_color: 'blancos' };
  assert.equal(eggColor(product), 'blancos');
  assert.equal(matchesEggColor(product, 'blancos'), true);
  assert.equal(matchesEggColor(product, 'mixtos'), false);
});

test('egg color falls back to normalized titles for legacy products', () => {
  assert.equal(eggColor({ title: 'Huevos L cafés' }), 'cafe');
  assert.equal(eggColor({ title: 'Huevos Jumbo blancos' }), 'blancos');
  assert.equal(eggColor({ title: 'Huevos sin color' }), null);
});

test('XL trays use the photo for their shell color', () => {
  assert.equal(
    eggImage({ title: 'Huevos XL blancos · Bandeja de 30', egg_color: 'blancos' }, 30),
    'huevos-blancos-hogar-v3.jpg',
  );
  assert.equal(
    eggImage({ title: 'Huevos XL cafés · Bandeja de 20', egg_color: 'cafés' }, 20),
    'huevos-cafe-20-hogar-v4.jpg',
  );
  assert.equal(
    eggImage({ title: 'Huevos XL mixtos · Bandeja de 30', egg_color: 'mixtos' }, 30),
    'huevos-mixtos-hogar-v3.jpg',
  );
});

test('uncolored legacy XL products keep the generic XL photo', () => {
  assert.equal(
    eggImage({ title: 'Huevos XL · Bandeja de 30' }, 30),
    'huevos-xl-30-hogar-v5.jpg',
  );
  assert.equal(
    eggImage({ title: 'Huevos XL · Caja de 180' }, 180),
    'caja-logo-huevos-xl-v6.jpg',
  );
});
