const test = require('node:test');
const assert = require('node:assert/strict');
const resolution = require('../src/services/post-sale-resolution');

test('ofrece cambio automático cuando un pedido reciente llegó distinto', () => {
  const result = resolution.detectPostSaleResolution(
    'Pedí dos bandejas blancas pero me llegaron de distinto color',
    { hasRecentDeliveredOrder: true }
  );
  assert.equal(result?.kind, 'exchange_offer');
  assert.match(resolution.exchangeOfferText('Jessy Soto'), /Jessy.*coordinemos.*cambio/i);
});

test('un sí posterior conserva el contexto de la oferta de cambio', () => {
  assert.equal(resolution.detectPostSaleResolution('Sí, por favor', { pendingExchange: true })?.kind, 'exchange_accept');
  assert.equal(resolution.detectPostSaleResolution('Sí, me gustaría hacer el cambio', { pendingExchange: true })?.kind, 'exchange_accept');
  assert.equal(resolution.detectPostSaleResolution('No gracias', { pendingExchange: true })?.kind, 'exchange_decline');
});

test('un posible problema de inocuidad nunca se resuelve automáticamente', () => {
  assert.equal(
    resolution.detectPostSaleResolution('El queso llegó con mal olor y está descompuesto', { hasRecentDeliveredOrder: true }),
    null
  );
  assert.equal(
    resolution.detectPostSaleResolution('El queso venía malo', { hasRecentDeliveredOrder: true }),
    null
  );
});

test('explica el calibre de huevo con los rangos chilenos y ofrece revisión', () => {
  const result = resolution.detectPostSaleResolution('Los huevos que recibí se ven muy chicos', { hasRecentDeliveredOrder: true });
  assert.equal(result?.kind, 'egg_weight_explanation');
  const text = resolution.eggWeightExplanationText('Paola');
  assert.match(text, /Grande 54–61 g.*Extra Grande 61–68 g.*Especial sobre 68 g/s);
  assert.match(text, /podemos revisar.*¿Alcanzaste a pesar alguno\?/s);
  assert.match(text, /foto.*balanza.*gramos.*respuesta concreta/s);
});

test('usa el pedido reciente de huevos cuando la clienta solo dice que se ven chicos', () => {
  const result = resolution.detectPostSaleResolution('Pero se ven súper chicos', {
    hasRecentDeliveredOrder: true,
    recentOrderHasEggs: true,
  });
  assert.equal(result?.kind, 'egg_weight_explanation');
});

test('una conocida consultando por el pedido de otra clienta se trata como estado de despacho', () => {
  const result = resolution.detectPostSaleResolution('Soy conocida de la clienta y quería saber cuándo llega su pedido');
  assert.equal(result?.kind, 'third_party_delivery_status');
  assert.match(resolution.thirdPartyStatusText(), /estado general.*privacidad/is);
});
