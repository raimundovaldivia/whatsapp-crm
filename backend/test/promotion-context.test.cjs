const test = require('node:test');
const assert = require('node:assert/strict');
const promotion = require('../src/services/promotion-context');
const pricing = require('../src/services/order-pricing');

const template = {
  direction: 'outbound',
  created_at: '2026-09-29T13:19:00.000Z',
  content: '[Template: promocion_general_entrega_mismo_dia]\n\n🥚✨ ¡Tenemos promos Diego! 40 Jumbo $16.000 | 60 Jumbo $23.500 | 100 Jumbo $35.000 | Válido solo para pedidos de hoy. Haz tu pedido antes de las 11:00 AM y, si tenemos stock disponible, te lo entregamos el mismo día.',
};

const products = [
  { id: '40', title: 'Caja 40 Huevos Jumbo', priceMin: 20000 },
  { id: '60', title: 'Caja 60 Huevos Jumbo', priceMin: 28000 },
  { id: '100', title: 'Caja 100 Huevos Jumbo', priceMin: 45000 },
];

test('extrae precios, vigencia y condiciones del template promocional', () => {
  const promo = promotion.fromHistory([template], products, new Date('2026-09-29T14:00:00.000Z'));
  assert.equal(promo.active, true);
  assert.equal(promo.validOnlyToday, true);
  assert.equal(promo.cutoff, '11:00 AM');
  assert.equal(promo.sameDayConditional, true);
  assert.equal(promo.stockConditional, true);
  assert.deepEqual(promo.offers.map(o => [o.units, o.price]), [[40,16000],[60,23500],[100,35000]]);
});

test('el pedido usa el precio promocional exacto y no el catálogo normal', () => {
  const promo = promotion.fromHistory([template], products, new Date('2026-09-29T14:00:00.000Z'));
  const result = pricing.priceItems(
    [{ product_name: 'Caja 100 Huevos Jumbo', quantity: 2 }],
    products,
    { specialPrices: promo.specialPrices }
  );
  assert.equal(result.items[0].price, 35000);
  assert.equal(result.total, 70000);
});

test('separa vigencia del precio y condición de entrega del mismo día', () => {
  const active = promotion.fromHistory([template], products, new Date('2026-09-29T14:00:00.000Z'));
  const reply = promotion.futureReply(active);
  assert.match(reply, /si confirmas el pedido hoy se respeta/i);
  assert.match(reply, /para mañana podemos dejar el despacho programado/i);
  assert.match(reply, /100 Jumbo a \$35\.000/i);

  const expired = promotion.fromHistory([template], products, new Date('2026-09-30T14:00:00.000Z'));
  assert.equal(expired.active, false);
  assert.match(promotion.futureReply(expired), /ya venció/i);
});

test('conserva la promoción durante la toma del pedido y la vence al cambiar de día', () => {
  const active = promotion.fromHistory([template], products, new Date('2026-09-29T14:00:00.000Z'));
  const saved = promotion.snapshot(active);
  assert.equal(promotion.restore(saved, new Date('2026-09-29T22:00:00.000Z')).specialPrices['100'], 35000);
  assert.equal(promotion.restore(saved, new Date('2026-09-30T14:00:00.000Z')).active, false);
});
