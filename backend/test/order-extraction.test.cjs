const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function ordersAgentWithExtraction(payload) {
  class Anthropic {
    constructor() {
      this.messages = { create: async () => ({ content: [{ text: JSON.stringify(payload) }] }) };
    }
  }
  return load('src/services/agents/orders.js', {
    '@anthropic-ai/sdk': Anthropic,
    '../order-pricing': { normalizeDraft: draft => ({ ...(draft || {}) }) },
  });
}

test('no inventa una fecha de entrega a partir del texto de una promoción', async () => {
  const agent = ordersAgentWithExtraction({
    customer_name: 'Cinthya Pantanalli',
    delivery_date: '2026-10-05',
    items: [{ product_name: 'Promo queso + XL', quantity: 1 }],
  });
  const draft = await agent.extractOrderData([
    { direction: 'outbound', content: 'Haz tu pedido antes de las 12:00 y te lo entregamos el mismo día.' },
    { direction: 'inbound', content: 'Hola quiero la promo de huevos XL y queso de cabra.' },
  ], {});

  assert.equal(draft.delivery_date, undefined);
});

test('conserva la fecha cuando el cliente sí la solicita', async () => {
  const agent = ordersAgentWithExtraction({ delivery_date: '2026-10-06' });
  const draft = await agent.extractOrderData([
    { direction: 'inbound', content: 'La quiero para mañana, por favor.' },
  ], {});

  assert.equal(draft.delivery_date, '2026-10-06');
});
