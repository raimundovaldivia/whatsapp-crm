import test from 'node:test';
import assert from 'node:assert/strict';
import { eggTypes, resolveFormats, selectedFormat, orderMessage } from './justo-casero-packs.js';

const approved = [
  ['JC-EXTRA-90', 24900], ['JC-EXTRA-120', 31900], ['JC-EXTRA-150', 38900], ['JC-EXTRA-180', 44900],
  ['JC-SUPER-EXTRA-60', 19900], ['JC-SUPER-EXTRA-80', 24900], ['JC-SUPER-EXTRA-100', 29900],
].map(([sku, price]) => ({ sku, price: String(price), active: true, stock: 1 }));

test('every offered pack has at least three whole trays; larger packs cost less per egg', () => {
  for (const type of eggTypes) {
    const packs = resolveFormats(type, approved);
    assert.equal(packs[0].trays, 3);
    for (const [index, pack] of packs.entries()) {
      assert.ok(Number.isInteger(pack.trays) && pack.trays >= 3);
      assert.equal(pack.available, true);
      if (index) assert.ok(pack.price / pack.units < packs[index - 1].price / packs[index - 1].units);
    }
    assert.equal(packs.at(-1).units, type.boxUnits);
  }
});

test('missing, inactive, sold-out, unpriced and single-tray products cannot be ordered', () => {
  const type = eggTypes[0];
  for (const changes of [{ stock: 0 }, { stock: null }, { active: false }, { price: 'invalid' }, { price: '0' }]) {
    const catalog = approved.map(item => ({ ...item, ...changes }));
    assert.equal(resolveFormats(type, catalog).some(pack => pack.available), false);
    assert.equal(orderMessage(resolveFormats(type, catalog)), '');
  }
  assert.equal(resolveFormats(type, null).some(pack => pack.available), false);
  const singleTray = [{ sku: 'JC-EXTRA-30', price: 10000, stock: 10 }];
  assert.equal(resolveFormats(type, singleTray).some(pack => pack.available), false);
  assert.equal(selectedFormat(type, approved, 'JC-EXTRA-30').units, 90);
});

test('existing boxes remain usable until smaller packs are activated', () => {
  const catalog = approved.filter(item => /180$|100$/.test(item.sku));
  assert.equal(selectedFormat(eggTypes[0], catalog, 'JC-EXTRA-90').units, 180);
  assert.equal(selectedFormat(eggTypes[1], catalog).units, 100);
});

test('one WhatsApp order includes both types with the approved total and coverage condition', () => {
  const packs = eggTypes.map(type => selectedFormat(type, approved));
  const message = orderMessage(packs);
  assert.match(message, /Extra: 90 huevos \(3 bandejas\), \$24\.900/);
  assert.match(message, /Súper Extra: 60 huevos \(3 bandejas\), \$19\.900/);
  assert.match(message, /Total de productos: \$44\.800/);
  assert.match(message, /otras zonas, confirmar cobertura y costo/);
});
