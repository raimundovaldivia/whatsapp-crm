const test = require('node:test');
const assert = require('node:assert/strict');
const offers = require('../src/services/campaign-offers');

const now = new Date('2026-10-19T13:00:00.000Z');
const catalog = [
  { product_id: '50', title: 'Huevos Jumbo mixtos · Bandeja de 20', available: true, unit_cost: 6000, min_margin_pct: 20 },
  { product_id: '51', title: 'Huevos Jumbo cafés · Bandeja de 20', available: true },
];
const complete = {
  product_id: '51', offer_price: 8000, expires_at: '2026-10-19T23:59:00.000Z',
  scope: 'all_units', recipients: ['56967692870'],
};

test('una oferta sin costo ni margen queda bloqueada hasta que el operador confirme el margen', () => {
  const blocked = offers.validateOfferDraft(complete, { catalog, now });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missing, ['margin_confirmed']);
  assert.match(blocked.warnings[0], /margen sin verificar/);
  const confirmed = offers.validateOfferDraft({ ...complete, margin_confirmed: true }, { catalog, now });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.missing, []);
});

test('con costo y margen cargados no hace falta confirmación', () => {
  const r = offers.validateOfferDraft(complete, { catalog: [{ ...catalog[1], unit_cost: 6000, min_margin_pct: 20 }], now });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('campos faltantes se devuelven para revisión manual', () => {
  const { ok, missing } = offers.validateOfferDraft({ ...complete, margin_confirmed: true, expires_at: undefined, scope: '' }, { catalog, now });
  assert.equal(ok, false);
  assert.deepEqual(missing.sort(), ['expires_at', 'scope']);
});

test('el alcance por defecto debe ser explícito y el tope debe ser entero positivo', () => {
  assert.equal(offers.validateOfferDraft({ ...complete, margin_confirmed: true, scope: { cap_units: 2 } }, { catalog, now }).ok, true);
  assert.equal(offers.validateOfferDraft({ ...complete, margin_confirmed: true, scope: { cap_units: 0 } }, { catalog, now }).ok, false);
});

test('rechaza precio bajo el margen mínimo y producto ambiguo', () => {
  const low = offers.validateOfferDraft({ ...complete, product_id: '50', offer_price: 5000 }, { catalog, now });
  assert.equal(low.ok, false);
  assert.match(low.errors[0], /bajo el mínimo/);
  const unknown = offers.validateOfferDraft({ ...complete, product_id: '999' }, { catalog, now });
  assert.match(unknown.errors[0], /exactamente un producto/);
});

test('rechaza vigencia pasada', () => {
  const r = offers.validateOfferDraft({ ...complete, expires_at: '2026-10-18T10:00:00.000Z' }, { catalog, now });
  assert.match(r.errors[0], /ya pasó/);
});

test('fecha sin hora cubre el día de Chile; hora explícita vence exactamente al cierre', () => {
  assert.equal(offers.offerExpiryDate('2026-10-20').toISOString(), '2026-10-21T02:59:59.999Z');
  assert.equal(offers.offerExpiryDate('2026-07-20').toISOString(), '2026-07-21T03:59:59.999Z');
  assert.equal(offers.offerExpiryDate('2026-10-20T13:00').toISOString(), '2026-10-20T16:00:00.000Z');
  assert.equal(offers.offerExpiryDate('2026-07-20T13:00').toISOString(), '2026-07-20T17:00:00.000Z');
  for (const value of ['2026-02-30', '2026-10-20T25:00', '2026-09-06T00:30', 'invalid', null]) assert.equal(offers.offerExpiryDate(value), null);
  const fields = { ...complete, margin_confirmed: true, expires_at: '2026-10-20T13:00' };
  assert.equal(offers.validateOfferDraft(fields, { catalog, now: new Date('2026-10-20T15:59:59Z') }).ok, true);
  assert.equal(offers.validateOfferDraft(fields, { catalog, now: new Date('2026-10-20T16:00:00Z') }).ok, false);
  assert.equal(offers.validateOfferDraft({ ...fields, expires_at: '2026-10-20' }, { catalog, now: new Date('2026-10-21T02:59:59Z') }).ok, true);
});

test('la última oferta enviada es la válida y las anteriores pendientes quedan superseded', () => {
  const first = { offer_id: 1, status: 'sent', sent_at: '2026-10-19T12:00:00.000Z', expires_at: '2026-10-19T23:59:00.000Z', product_id: '51' };
  const second = { offer_id: 2, status: 'sent', sent_at: '2026-10-19T12:30:00.000Z', expires_at: '2026-10-19T23:59:00.000Z', product_id: '50' };
  const all = offers.supersedePending([first], now).concat(second);
  assert.equal(all[0].status, 'superseded');
  assert.equal(offers.activeOfferForNewOrder(all, now).offer_id, 2);
});

test('si la última oferta venció, no hay oferta para un pedido nuevo', () => {
  const old = { offer_id: 3, status: 'sent', sent_at: '2026-10-19T12:00:00.000Z', expires_at: '2026-10-19T12:30:00.000Z' };
  assert.equal(offers.activeOfferForNewOrder([old], now), null);
});

test('el precio aplica a todas las unidades del producto ofrecido, sin tope', () => {
  const offer = { offer_id: 4, status: 'sent', product_id: '51', offer_price: 8000, scope: 'all_units', expires_at: '2026-10-19T23:59:00.000Z' };
  const items = [{ product_id: '51', quantity: 6, unit_price: 10050 }, { product_id: '50', quantity: 1, unit_price: 9150 }];
  const { items: out, applied } = offers.applyOfferToItems(items, offer, null, now);
  assert.equal(applied, true);
  assert.equal(out[0].unit_price, 8000);
  assert.equal(out[0].offer_units, 6);
  assert.equal(out[1].unit_price, 9150);
});

test('un tope de unidades limita hasta dónde aplica el precio', () => {
  const offer = { offer_id: 5, status: 'sent', product_id: '51', offer_price: 8000, scope: { cap_units: 2 }, expires_at: '2026-10-19T23:59:00.000Z' };
  const items = [{ product_id: '51', quantity: 5, unit_price: 10050 }];
  const { items: out } = offers.applyOfferToItems(items, offer, null, now);
  assert.equal(out[0].offer_units, 2);
});

test('canjear pasa la oferta a redeemed; no se puede canjear dos veces', () => {
  const offer = { offer_id: 6, status: 'sent', product_id: '51', expires_at: '2026-10-19T23:59:00.000Z' };
  const redeemed = offers.redeem(offer, 777, now);
  assert.equal(redeemed.status, 'redeemed');
  assert.equal(redeemed.redeemed_order_id, 777);
  assert.throws(() => offers.redeem(redeemed, 778, now), /no está disponible/);
});

test('cancelar un pedido canjeado devuelve la oferta a sent solo si sigue vigente', () => {
  const valid = { offer_id: 7, status: 'redeemed', redeemed_order_id: 1, expires_at: '2026-10-19T23:59:00.000Z' };
  assert.equal(offers.onOrderCancelled(valid, now).status, 'sent');
  const expired = { offer_id: 8, status: 'redeemed', redeemed_order_id: 2, expires_at: '2026-10-19T12:00:00.000Z' };
  const after = offers.onOrderCancelled(expired, now);
  assert.equal(after.status, 'expired');
  assert.equal(after.redeemed_order_id, null);
});

test('un problema de despacho mantiene la oferta y su precio para ese pedido aunque haya vencido', () => {
  const redeemed = { offer_id: 9, status: 'redeemed', redeemed_order_id: 42, product_id: '51', offer_price: 8000, scope: 'all_units', expires_at: '2026-10-19T12:00:00.000Z' };
  assert.equal(offers.onDispatchProblem(redeemed).status, 'redeemed');
  const items = [{ product_id: '51', quantity: 3, unit_price: 10050 }];
  assert.equal(offers.applyOfferToItems(items, redeemed, 42, now).items[0].unit_price, 8000);
  assert.equal(offers.applyOfferToItems(items, redeemed, 99, now).applied, false);
});

test('una oferta vencida no se puede usar para un pedido nuevo', () => {
  const expired = { offer_id: 10, status: 'sent', product_id: '51', offer_price: 8000, scope: 'all_units', expires_at: '2026-10-19T12:00:00.000Z' };
  const items = [{ product_id: '51', quantity: 2, unit_price: 10050 }];
  assert.equal(offers.applyOfferToItems(items, expired, null, now).applied, false);
  assert.equal(offers.expireDue([expired], now)[0].status, 'expired');
});
