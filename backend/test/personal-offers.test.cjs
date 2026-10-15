const test = require('node:test');
const assert = require('node:assert/strict');
const offers = require('../src/services/personal-offers');
const pricing = require('../src/services/order-pricing');
const { load } = require('./helpers.cjs');

const tiers = offers.DEFAULT_TIERS.map(tier => ({ ...tier }));
const activeOffer = {
  id: 9,
  status: 'sent',
  discount_amount: 7000,
  discount_tiers: tiers,
  unit_cost: 150,
  min_margin_pct: 40,
  expires_at: '2026-10-20T18:00:00Z',
};

test('la escala conserva el margen mínimo con el precio más bajo del catálogo', () => {
  assert.deepEqual(offers.safeTiers({ min_tray_price: 10990, unit_cost: 150, min_margin_pct: 40 }), tiers);
  assert.equal(offers.safeTiers({ min_tray_price: 6000, unit_cost: 150, min_margin_pct: 40 }), null);
});

test('el mensaje personal muestra toda la escala, asociación al número y vencimiento', () => {
  const text = offers.buildMessage(activeOffer, { contact_name: 'Ana Pérez' });
  assert.match(text, /Hola Ana/);
  assert.match(text, /huevos XL o L/);
  assert.match(text, /\$1\.000 con 1 bandeja/);
  assert.match(text, /\$4\.000 con 2/);
  assert.match(text, /\$7\.000 con 3 o más/);
  assert.match(text, /asociado exclusivamente a tu número/);
  assert.match(text, /vence el/);
});

test('aplica $1.000, $4.000 y $7.000 según bandejas sin bajar del margen', () => {
  const products = [{ id: 1, title: 'Huevos XL mixtos · Bandeja de 30', price: 10990 }];
  for (const [quantity, expected] of [[1, 1000], [2, 4000], [3, 7000], [5, 7000]]) {
    const base = pricing.priceItems([{ product_name: products[0].title, quantity }], products);
    assert.equal(offers.applicableDiscount(base, activeOffer, new Date('2026-10-16T12:00:00Z')), expected);
    const discounted = pricing.priceItems([{ product_name: products[0].title, quantity }], products, { fixedDiscountAmount: expected });
    assert.equal(discounted.fixedDiscountAmount, expected);
    assert.equal(discounted.total, quantity * 10990 - expected);
  }
});

test('no aplica la promoción a otros productos ni después del vencimiento', () => {
  const other = { items: [{ name: 'Queso de cabra', quantity: 3, price: 15000 }], subtotal: 45000, discountAmount: 0 };
  assert.equal(offers.applicableDiscount(other, activeOffer, new Date('2026-10-16T12:00:00Z')), 0);
  const medium = { items: [{ name: 'Huevos M mixtos · Bandeja de 30', quantity: 3, price: 9990 }], subtotal: 29970, discountAmount: 0 };
  assert.equal(offers.applicableDiscount(medium, activeOffer, new Date('2026-10-16T12:00:00Z')), 0);
  const eggs = { items: [{ name: 'Huevos XL · Bandeja de 30', quantity: 2, price: 10990 }], subtotal: 21980, discountAmount: 0 };
  assert.equal(offers.applicableDiscount(eggs, activeOffer, new Date('2026-10-21T12:00:00Z')), 0);
});

test('el seguimiento reclama, envía y audita una oferta confirmada por precio', async () => {
  const calls = { sent: [], claimed: [], marked: [] };
  const candidate = {
    id: 12, organization_id: 7, phone_number: '56911111111', contact_name: 'Ana',
    last_inbound_at: '2026-10-15T18:00:00Z', min_tray_price: 10990,
    unit_cost: 150, min_margin_pct: 40, price_reason_source: 'observed', price_reason_confidence: 0.94,
  };
  const db = {
    getPersonalOfferCandidates: async () => [candidate],
    getLastMessages: async () => [{ direction: 'inbound', content: 'Está muy caro' }, { direction: 'outbound', content: 'Entiendo' }],
    getContact: async () => ({ opt_out: false }),
    getSetting: async () => '48',
    claimPersonalOffer: async input => {
      calls.claimed.push(input);
      return { id: 90, ...input, discount_amount: 7000, discount_tiers: input.discountTiers, expires_at: input.expiresAt };
    },
    saveMessage: async message => ({ id: 88, ...message }),
    updateConversationLastMessage: async () => {},
    markPersonalOfferSent: async (...args) => calls.marked.push(args),
    markPersonalOfferFailed: async () => {},
    getConversationById: async () => candidate,
  };
  const whatsapp = {
    configForConversation: async () => ({ provider: 'kapso' }),
    sendTextMessage: async (phone, message) => { calls.sent.push({ phone, message }); return { messages: [{ id: 'wamid.1' }] }; },
    messageId: value => value.messages[0].id,
  };
  const service = load('src/services/follow-up.js', {
    '../db/database': db,
    './whatsapp-provider': whatsapp,
    './commercial': { permitted: async () => true },
    './personal-offers': offers,
  }, { console });
  const result = await service.runPersonalOfferFollowUp(null, new Date('2026-10-16T15:00:00-03:00'));
  assert.equal(result.sent, 1);
  assert.equal(calls.claimed[0].priceReasonSource, 'observed');
  assert.deepEqual(calls.claimed[0].discountTiers, tiers);
  assert.match(calls.sent[0].message, /\$7\.000 con 3 o más/);
  assert.deepEqual(calls.marked[0], [7, 90, 88]);
});

test('la selección SQL exige precio confirmado y mantiene el aislamiento por organización', async () => {
  const calls = [];
  class Pool {
    async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; }
  }
  const db = load('src/db/database.js', { pg: { Pool } });
  await db.getPersonalOfferCandidates({ organizationId: 44, limit: 10 });
  assert.deepEqual(Array.from(calls[0].params), [44, 18, 23, 10]);
  assert.match(calls[0].sql, /c\.organization_id = \$1/);
  assert.match(calls[0].sql, /limbo_reason_code = 'price'/);
  assert.match(calls[0].sql, /priceObjection/);
  assert.doesNotMatch(calls[0].sql, /priceQuestion/);
  assert.match(calls[0].sql, /personal_offers_enabled/);
});
