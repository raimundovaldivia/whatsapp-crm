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

test('reconoce la opción exacta elegida sin confundirla con otra promo', () => {
  const promo = promotion.fromHistory([template], products, new Date('2026-09-29T14:00:00.000Z'));
  const chosen = promotion.selectedOffer('60 huevos Jumbo $23.500 para el miércoles, por favor', promo);
  assert.equal(chosen.units, 60);
  assert.equal(chosen.price, 23500);
  assert.deepEqual(promotion.offerOrderItem(chosen), {
    product_name: '60 huevos Jumbo', quantity: 1, price: 23500,
    locked_quote: true, promotion_offer: true,
  });
  assert.equal(promotion.selectedOffer('Me respetan la oferta para mañana', promo), null);
  assert.equal(promotion.isFuturePromotionQuestion('Me gustaría pedir pero para mañana, ¿me respetan la oferta?'), true);
});

test('valoriza como cerrada una presentación promocional que no es SKU del catálogo', () => {
  const result = pricing.priceItems([
    { product_name: '60 huevos Jumbo (3 bandejas de 20)', quantity: 1, price: 23500, locked_quote: true, promotion_offer: true },
  ], products);
  assert.equal(result.items[0].name, '60 huevos Jumbo (3 bandejas de 20)');
  assert.equal(result.items[0].price, 23500);
  assert.equal(result.items[0].matched, true);
  assert.equal(result.total, 23500);
});

test('extrae y aplica un porcentaje de descuento enviado en un template', () => {
  const percentageTemplate = {
    direction: 'outbound',
    created_at: '2026-09-29T13:19:00.000Z',
    content: '[Template: descuento_clientes_15]\n\nHoy tienes un 15% de descuento en tu pedido. Válido solo para pedidos de hoy.',
  };
  const promo = promotion.fromHistory([percentageTemplate], products, new Date('2026-09-29T14:00:00.000Z'));
  assert.equal(promo.discountPct, 15);
  assert.equal(promo.active, true);
  const result = pricing.priceItems(
    [{ product_name: 'Caja 100 Huevos Jumbo', quantity: 2 }],
    products,
    { discountPct: promo.discountPct, maxDiscountPct: 100 }
  );
  assert.equal(result.subtotal, 90000);
  assert.equal(result.discountAmount, 13500);
  assert.equal(result.total, 76500);
  assert.match(promotion.promptSection(promo), /15% de descuento/i);
});

test('no acumula porcentaje sobre precios finales ya indicados en la promo', () => {
  const finalPrices = {
    ...template,
    content: `${template.content} Ahorra hasta un 20% de descuento.`,
  };
  const promo = promotion.fromHistory([finalPrices], products, new Date('2026-09-29T14:00:00.000Z'));
  assert.equal(promo.discountPct, 0);
  const result = pricing.priceItems(
    [{ product_name: 'Caja 100 Huevos Jumbo', quantity: 2 }],
    products,
    { specialPrices: promo.specialPrices, discountPct: promo.discountPct, maxDiscountPct: 100 }
  );
  assert.equal(result.total, 70000);
});

test('interpreta una promoción mixta aunque sus reglas no estén en la ficha del producto', () => {
  const mixedTemplate = {
    direction: 'outbound',
    created_at: '2026-10-01T13:00:00.000Z',
    content: `[Template: promo_semana]
🥚✨ ¡Tenemos promos Cecilia! ⏰ ¡Extendimos el horario de pedidos de hoy hasta las 11:30 AM! La hora indicada más abajo en este mensaje no tiene validez para esta promoción. Promoción válida solo para pedidos con entrega durante esta semana. | 40 Jumbo $18.000 | 60 Jumbo $25.500 | 100 Jumbo $37.000 | 30 XL $12.000 | 60 XL $23.000 | 90 XL $34.000 | 30% dcto. en todas las aceitunas | Queso de cabra 900 g $15.000 | DESPACHOS GRATIS POR COMPRAS SOBRE $10.000 Haz tu pedido antes de las 11:00 AM y, si tenemos stock disponible, te lo entregamos el mismo día.`,
  };
  const mixedProducts = [
    ...products,
    { id: 'xl30', title: 'Huevos XL Bandeja 30', priceMin: 14000 },
    { id: 'olives', title: 'Aceitunas verdes 500 g', priceMin: 10000 },
    { id: 'cheese', title: 'Queso de cabra 900 g', priceMin: 18000 },
  ];
  const promo = promotion.fromHistory([mixedTemplate], mixedProducts, new Date('2026-10-01T14:00:00.000Z'));
  assert.equal(promo.cutoff, '11:30 AM');
  assert.equal(promo.orderCutoffOnlyToday, true);
  assert.equal(promo.deliveryWeekOnly, true);
  assert.equal(promo.validUntil, '2026-10-04');
  assert.equal(promo.freeShippingMin, 10000);
  assert.deepEqual(promo.categoryDiscounts, [{ pct: 30, target: 'aceitunas' }]);
  assert.equal(promo.offers.find(o => o.named)?.label, 'Queso de cabra 900 g');
  assert.equal(promotion.selectedOffer('Quiero un queso de cabra, por favor', promo).price, 15000);
  assert.equal(promotion.appliesToDelivery(promo, '2026-10-04'), true);
  assert.equal(promotion.appliesToDelivery(promo, '2026-10-05'), false);

  const olives = pricing.priceItems(
    [{ product_name: 'Aceitunas verdes 500 g', quantity: 1 }],
    mixedProducts,
    { categoryDiscounts: promo.categoryDiscounts }
  );
  assert.equal(olives.subtotal, 10000);
  assert.equal(olives.discountAmount, 3000);
  assert.equal(olives.total, 7000);
  assert.match(pricing.summaryBlock(olives), /Descuento promocional/);
  assert.match(promotion.promptSection(promo), /Despacho gratis.*10\.000/i);
  assert.equal(promotion.fromHistory([mixedTemplate], mixedProducts, new Date('2026-10-01T15:00:00.000Z')).active, false);
});

test('un producto ofrecido en una promoción activa no se rechaza por stock cacheado en cero', () => {
  const promoTemplate = {
    direction: 'outbound',
    created_at: '2026-10-03T12:30:00.000Z',
    content: '[Template: promocion_general_entrega_mismo_dia]\nQueso de cabra 900 g $15.000 | Jumbo: 20 unidades $9.000 | Promoción válida hasta hoy.',
  };
  const promoProducts = [
    { id: 'cheese', title: 'Queso de Cabra Fresco Pasteurizado', variants: [{ id: '900', title: '900 g', price: 15000, stock: 0, available: false }] },
    { id: 'other', title: 'Producto no promocionado', variants: [{ id: 'x', title: 'Unidad', price: 5000, stock: 0, available: false }] },
  ];
  const promo = promotion.fromHistory([promoTemplate], promoProducts, new Date('2026-10-03T13:00:00.000Z'));
  const catalog = '• Queso de Cabra Fresco Pasteurizado | $15.000\n  · 900 g: $15.000 (stock: 0) ❌ agotado\n\n• Producto no promocionado | $5.000\n  · Unidad: $5.000 (stock: 0) ❌ agotado';
  const aligned = promotion.alignPromotedAvailability(catalog, promo);

  assert.match(aligned, /Queso de Cabra[\s\S]*Disponibilidad: validar al registrar/i);
  assert.doesNotMatch(aligned.split('\n\n')[0], /agotado|stock:\s*0/i);
  assert.match(aligned.split('\n\n')[1], /agotado/i);
});

test('conserva la variedad en ofertas agrupadas y elige 60 XL sin confundirla con 60 Jumbo', () => {
  const groupedTemplate = {
    direction: 'outbound',
    created_at: '2026-10-01T16:06:00.000Z',
    content: `[Template: promocion_general_entrega_mismo_dia]
🥚✨ ¡Tenemos promos Jenny! | 📅 Promoción válida hasta el sábado 03/10/2026, inclusive. | 🥚 Jumbo: 40 unidades $18.000 | 60 unidades $25.500 | 100 unidades $37.000 | 🥚 XL: 30 unidades $12.000 | 60 unidades $23.000 | 90 unidades $34.000 | 🧀 Queso de cabra 900 g $15.000 | 🚚 Despacho gratis en compras desde $10.000`,
  };
  const promo = promotion.fromHistory([groupedTemplate], products, new Date('2026-10-01T16:17:00.000Z'));
  assert.equal(promo.validUntil, '2026-10-03');
  assert.deepEqual(
    promo.offers.filter(offer => offer.units === 60).map(offer => [offer.label, offer.price]),
    [['60 Jumbo', 25500], ['60 XL', 23000]],
  );
  const selected = promotion.selectedOffer('Hola quiero la promo XL 60 unidades 23.000', promo);
  assert.equal(selected.label, '60 XL');
  assert.deepEqual(promotion.offerOrderItem(selected), {
    product_name: '60 huevos XL', quantity: 1, price: 23000, locked_quote: true, promotion_offer: true,
  });
  assert.equal(promotion.fromHistory([groupedTemplate], products, new Date('2026-10-03T12:00:00.000Z')).active, true);
});

test('una promoción sin vigencia explícita vence automáticamente en 24 horas', () => {
  const withoutValidity = {
    direction: 'outbound',
    created_at: '2026-10-01T10:00:00.000Z',
    content: '[Template: promo_sin_fecha]\n100 Jumbo $37.000. ¿Te guardamos una?',
  };
  const active = promotion.fromHistory([withoutValidity], products, new Date('2026-10-02T09:59:00.000Z'));
  assert.equal(active.usesDefaultValidity, true);
  assert.equal(active.active, true);
  assert.equal(active.expiresAt, '2026-10-02T10:00:00.000Z');
  assert.match(promotion.promptSection(active), /vence 24 horas/i);

  const expired = promotion.fromHistory([withoutValidity], products, new Date('2026-10-02T10:01:00.000Z'));
  assert.equal(expired.active, false);
  assert.match(promotion.promptSection(expired), /pasaron 24 horas/i);
  assert.equal(promotion.restore(promotion.snapshot(active), new Date('2026-10-02T10:01:00.000Z')).active, false);
});

test('la segunda aceituna al 50% cobra un envase completo y medio envase por cada par', () => {
  const oliveTemplate = {
    direction: 'outbound',
    created_at: '2026-10-01T10:00:00.000Z',
    content: '[Template: promo_hasta_sabado]\nAceitunas de 500 g: lleva 2 envases y obtén 50% de descuento en el segundo. Válida hasta el 03/10/2026.',
  };
  const oliveProducts = [{ id: 'olive', title: 'Aceitunas verdes 500 g', priceMin: 8000 }];
  const promo = promotion.fromHistory([oliveTemplate], oliveProducts, new Date('2026-10-01T12:00:00.000Z'));
  assert.equal(promo.validUntil, '2026-10-03');
  assert.deepEqual(promo.categoryDiscounts, []);
  assert.equal(promo.secondUnitDiscounts[0].pct, 50);
  assert.equal(promo.secondUnitDiscounts[0].products[0].pairTotal, 12000);

  const priced = pricing.priceItems(
    [{ product_name: 'Aceitunas verdes 500 g', quantity: 2 }],
    oliveProducts,
    { secondUnitDiscounts: promo.secondUnitDiscounts }
  );
  assert.equal(priced.subtotal, 16000);
  assert.equal(priced.discountAmount, 4000);
  assert.equal(priced.total, 12000);
  assert.match(promotion.promptSection(promo), /1 envase \$8\.000; 2 envases.*\$12\.000/i);
});
