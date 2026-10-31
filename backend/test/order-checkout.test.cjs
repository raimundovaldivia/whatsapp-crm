const test = require('node:test');
const assert = require('node:assert/strict');
const checkout = require('../src/services/order-checkout');

const draft = { customer_name: 'Cliente Prueba', address: 'Plaza de Armas s/n', city: 'La Serena',
  customer_phone: '56911111111', notes: 'No despachar' };
const priced = { items: [{ name: 'Huevos XL', quantity: 1, price: 11990 }], total: 11990 };
const history = [{ direction: 'outbound', content: checkout.reviewReply(draft, priced) }];

test('separa solo las comunas completas repetidas al final de la dirección', () => {
  const cases = [
    ['Plaza de Armas s/n, La Serena, LA SERENA', 'La Serena', 'Plaza de Armas s/n'],
    ['Av. La Serena 123, depto. 4', 'La Serena', 'Av. La Serena 123, depto. 4'],
    ['Calle 123, Tomé, TOME', 'Tomé', 'Calle 123'],
    ['Calle 123, La Serena Norte', 'La Serena', 'Calle 123, La Serena Norte'],
    ['La Serena, La Serena', 'La Serena', 'La Serena'],
  ];
  for (const [address, city, expected] of cases) {
    const original = { address, city };
    assert.equal(checkout.normalizeDraft(original).address, expected);
    assert.equal(original.address, address, 'no altera el borrador anterior');
  }
  assert.equal(checkout.formatAddress({ address: 'La Serena', city: 'La Serena' }), 'La Serena');
});

test('un resumen guardado por la versión anterior acepta la misma dirección normalizada', () => {
  const signature = JSON.parse(checkout.signature(draft, priced));
  signature.address = 'plaza de armas s/n, la serena, la serena';
  const previous = { ...draft, address: signature.address, _reviewed_order: JSON.stringify(signature) };
  assert.equal(checkout.matchesReview(previous, draft, priced, history), true);
  for (const change of [{ address: 'Otra calle 456' }, { city: 'Coquimbo' },
    { customer_phone: '56922222222' }, { notes: 'Entregar a otra persona' }]) {
    assert.equal(checkout.matchesReview(previous, { ...draft, ...change }, priced, history), false);
  }
  assert.equal(checkout.matchesReview(previous, draft, priced, []), false);
  assert.equal(checkout.matchesReview({ ...previous, _reviewed_order: 'invalid' }, draft, priced, history), false);
});

test('un resumen anterior sin firma admite solo la misma dirección y los mismos productos', () => {
  const previous = { ...draft, address: 'Plaza de Armas s/n, La Serena' };
  assert.equal(checkout.matchesReview(previous, draft, priced, history), true);
  assert.equal(checkout.matchesReview(previous, { ...draft, address: 'Otra calle 456' }, priced, history), false);
});
