const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture(options = {}) {
  let savedDraft = null;
  let savedState = null;
  let agentMode = null;
  let escalationChecks = 0;
  let extractionCalls = 0;
  const history = options.history || [{
    direction: 'outbound',
    content: '📦 1x Huevos XL cafés · Bandeja de 30 — $12.990\n💰 Total: $12.990\n¿Todo correcto?',
  }];
  const draft = options.draft || {
    customer_name: 'Denisse', address: 'Avenida La Paz 4325, Las Cias', city: 'La Serena',
    items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }],
  };
  const db = {
    getConversationById: async () => ({ id: 91, organization_id: 1, phone_number: '56911111111', contact_name: 'Denisse', pipeline_state: options.state || 'collecting_order', agent_mode: 'ai' }),
    getLastMessages: async () => history,
    getSetting: async (_org, key) => key === 'catalog_source' ? 'local' : null,
    getContact: async () => ({ name: 'Denisse', address: 'Avenida La Paz 4325, Las Cias', city: 'La Serena', contact_type: 'lead', client_type: options.clientType || 'personal' }),
    getPrimaryDataSource: async () => null,
    getProducts: async () => [
      { id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: 20, active: true },
      { id: 8, title: 'Queso de cabra 900 g', price: 12000, stock: 20, active: true },
    ],
    getCachedProducts: async () => [],
    getOrderDraft: async () => draft,
    getActiveOrderForBot: async () => null,
    updatePipelineState: async (_id, state, nextDraft) => { savedState = state; if (nextDraft) savedDraft = nextDraft; },
    setAgentMode: async (_id, mode) => { agentMode = mode; },
    setLastEscalation: async () => {},
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false, isBareLinkMessage: () => false },
    './shopify-api': { formatProductsForAI: () => '' },
    './agents/orchestrator': {
      checkEscalation: async () => { escalationChecks++; return options.escalation || { escalate: true, urgency: 'medium', reason: 'mensaje breve' }; },
      classifyIntent: async () => ({ intent: 'unknown', confidence: 0.2 }),
    },
    './agents/orders': {
      isCancelDuringCollection: () => false,
      extractOrderData: async (...args) => {
        extractionCalls++;
        return options.extractOrderData ? options.extractOrderData(...args) : args[1];
      },
      generateOrderResponse: async (_history, _message, nextDraft) => `📦 ${nextDraft.items[0].quantity}x Huevos XL cafés · Bandeja de 30\n💰 Total: $25.980\n¿Todo correcto?`,
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => true,
      missingFields: () => [],
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './promotion-context': require('../src/services/promotion-context'),
    './xl-welcome-pricing': {
      context: async () => ({ enabled: false, eligible: false }),
      forStore: context => context,
      prompt: () => '',
      applyQuote: quote => quote,
    },
    './scheduled-orders': { isFutureOrderIntent: () => false, isSoftFutureIntent: () => false, extractScheduledOrderData: async () => ({}), formatDateEs: value => value },
  });
  return {
    pipeline,
    state: () => savedState,
    draft: () => savedDraft,
    mode: () => agentMode,
    escalationChecks: () => escalationChecks,
    extractionCalls: () => extractionCalls,
  };
}

test('dos bandejas corrige el resumen, recalcula y no escala a una persona', async () => {
  const f = fixture();
  const result = await f.pipeline.processMessage(1, 91, '2 bandejas!');

  assert.equal(f.escalationChecks(), 0);
  assert.equal(result.switchToHuman, undefined);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /2x Huevos XL cafés/i);
  assert.equal(f.draft().items[0].quantity, 2);
  assert.equal(f.draft().subtotal, 25980);
  assert.equal(f.draft().total, 25980);
});

test('una cantidad escrita como 3o se aclara antes de llamar a IA o alterar el pedido', async () => {
  const f = fixture();
  const result = await f.pipeline.processMessage(1, 91, 'necesito 3o L café');

  assert.equal(f.escalationChecks(), 0);
  assert.equal(f.extractionCalls(), 0);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /30 unidades/i);
  assert.match(result.response, /3 bandejas\/cajas/i);
  assert.equal(f.draft().items.length, 1);
});

test('un sí aislado no agrega un producto que apareció solo en un mensaje saliente', async () => {
  const original = {
    customer_name: 'Denisse', address: 'Avenida La Paz 4325, Las Cias', city: 'La Serena',
    items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }],
  };
  const f = fixture({
    draft: original,
    escalation: { escalate: false, urgency: 'low', reason: null },
    history: [
      { direction: 'outbound', content: '📦 1x Huevos XL cafés · Bandeja de 30. ¿Todo correcto?' },
      { direction: 'outbound', content: 'Queso de cabra 900 g — $12.000' },
    ],
    extractOrderData: async () => ({
      ...original,
      items: [...original.items, { product_name: 'Queso de cabra 900 g', quantity: 1 }],
    }),
  });
  const result = await f.pipeline.processMessage(1, 91, 'Sí');

  assert.equal(f.extractionCalls(), 1);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /evitar agregar algo que no pediste/i);
  assert.doesNotMatch(result.response, /queso de cabra/i);
  assert.deepEqual(f.draft().items, original.items);
});

test('una consulta por pallet se deriva sin mostrar precios empresa ni llamar clasificadores', async () => {
  const f = fixture({ state: 'interested' });
  const result = await f.pipeline.processMessage(1, 91, 'Quisiera ver precios por pallet');

  assert.equal(f.escalationChecks(), 0);
  assert.equal(f.mode(), 'coordinating');
  assert.equal(f.state(), 'interested');
  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /equipo comercial/i);
  assert.doesNotMatch(result.response, /\$\s*\d/);
  assert.match(result.adminNotice, /Consulta mayorista/i);
});
