const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('dos bandejas corrige el resumen, recalcula y no escala a una persona', async () => {
  let savedDraft = null;
  let escalationChecks = 0;
  const history = [{
    direction: 'outbound',
    content: '📦 1x Huevos XL cafés · Bandeja de 30 — $12.990\n💰 Total: $12.990\n¿Todo correcto?',
  }];
  const db = {
    getConversationById: async () => ({ id: 91, organization_id: 1, phone_number: '56911111111', contact_name: 'Denisse', pipeline_state: 'collecting_order', agent_mode: 'ai' }),
    getLastMessages: async () => history,
    getSetting: async (_org, key) => key === 'catalog_source' ? 'local' : null,
    getContact: async () => ({ name: 'Denisse', address: 'Avenida La Paz 4325, Las Cias', city: 'La Serena', contact_type: 'lead', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getProducts: async () => [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: 20, active: true }],
    getCachedProducts: async () => [],
    getOrderDraft: async () => ({
      customer_name: 'Denisse', address: 'Avenida La Paz 4325, Las Cias', city: 'La Serena',
      items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }],
    }),
    getActiveOrderForBot: async () => null,
    updatePipelineState: async (_id, state, draft) => { if (state === 'collecting_order') savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false, isBareLinkMessage: () => false },
    './shopify-api': { formatProductsForAI: () => '' },
    './agents/orchestrator': {
      checkEscalation: async () => { escalationChecks++; return { escalate: true, urgency: 'medium', reason: 'mensaje breve' }; },
      classifyIntent: async () => ({ intent: 'unknown', confidence: 0.2 }),
    },
    './agents/orders': {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => draft,
      generateOrderResponse: async (_history, _message, draft) => `📦 ${draft.items[0].quantity}x Huevos XL cafés · Bandeja de 30\n💰 Total: $25.980\n¿Todo correcto?`,
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => true,
      missingFields: () => [],
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './promotion-context': require('../src/services/promotion-context'),
    './xl-welcome-pricing': { context: async () => ({ enabled: false, eligible: false }), prompt: () => '', applyQuote: quote => quote },
    './scheduled-orders': { isFutureOrderIntent: () => false, isSoftFutureIntent: () => false, extractScheduledOrderData: async () => ({}), formatDateEs: value => value },
  });

  const result = await pipeline.processMessage(1, 91, '2 bandejas!');

  assert.equal(escalationChecks, 0);
  assert.equal(result.switchToHuman, undefined);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /2x Huevos XL cafés/i);
  assert.equal(savedDraft.items[0].quantity, 2);
  assert.equal(savedDraft.subtotal, 25980);
  assert.equal(savedDraft.total, 25980);
});
