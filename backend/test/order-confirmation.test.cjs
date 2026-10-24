const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const policy = require('../src/services/order-input-policy');
const agent = load('src/services/agents/orders.js', { '../ai-provider': {} });
const draft = () => ({
  customer_name: 'Cliente de prueba', address: 'Calle de prueba 123', city: 'La Serena',
  delivery_date: '2099-01-01',
  items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }],
});

test('acepta confirmaciones completas sin limitar la longitud', () => {
  for (const message of ['Siiii , por supuesto los espero', 'Si por supuesto, acá estoy',
    'Sí, todo correcto, muchas gracias', 'Dale, por favor, los espero', '👍🏽', 'ok', 'correcto']) {
    assert.equal(agent.isOrderConfirmed('¿Todo correcto?', message, draft()), true, message);
    assert.equal(agent.isOrderConfirmed('¿Todo correcto?', message, { items: [] }), false, message);
  }
});

test('una pregunta, condición, negativa o modificación no confirma por un prefijo', () => {
  for (const message of ['si cambio la dirección', 'simplemente estoy consultando', '¿Sí?',
    'Sí, pero cambia a dos bandejas', 'Ok, no lo envíes', 'Si llegan mañana confirmo',
    'No confirmo', 'Sí, los espero pero no hoy', 'Listo, cancelen el pedido', 'por supuesto que no']) {
    assert.equal(agent.isOrderConfirmed('¿Todo correcto?', message, draft()), false, message);
  }
});

test('las confirmaciones largas tampoco permiten inventar productos nuevos', () => {
  const previous = draft();
  const next = { ...previous, items: [...previous.items, { product_name: 'Queso de cabra', quantity: 1 }] };
  assert.equal(policy.unexpectedItemsFromBareAffirmative('Siiii , por supuesto los espero', previous, next).length, 1);
});

function fixture(options = {}) {
  const calls = { orders: [], states: [], claims: 0 };
  const current = options.draft || draft();
  const db = {
    getConversationById: async () => ({ id: 91, organization_id: 7, phone_number: '56911111111', pipeline_state: 'collecting_order', agent_mode: 'ai' }),
    getLastMessages: async () => options.history || [{ direction: 'outbound', content: '📦 1x Huevos XL cafés · Bandeja de 30 — $12.990\n💰 Total: $12.990\n¿Todo correcto?' }],
    getSetting: async (_org, key) => key === 'catalog_source' ? 'local' : null,
    getContact: async () => null,
    getPrimaryDataSource: async () => null,
    getProducts: async () => [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: 20, active: true }],
    getCachedProducts: async () => [],
    getOrderDraft: async () => current,
    getActiveOrderForBot: async () => null,
    updatePipelineState: async (...args) => calls.states.push(args),
    setAgentMode: async () => {},
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
    claimOrderCreation: async () => { calls.claims++; return !options.duplicate; },
    createOrder: async value => {
      if (options.failSave) throw new Error('Simulated database failure');
      calls.orders.push(value); return { id: 812 };
    },
    updateOrder: async () => {},
    upsertContact: async () => {},
    promoteToCustomer: async () => {},
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false, isBareLinkMessage: () => false },
    './shopify-api': { formatProductsForAI: () => '' },
    './agents/orchestrator': { checkEscalation: async () => ({ escalate: false }), classifyIntent: async () => ({ intent: 'wants_to_order', confidence: 1 }) },
    './agents/orders': {
      ...agent,
      extractOrderData: async (_history, previous) => previous,
      generateOrderResponse: async () => options.response || '¿Todo correcto?',
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './promotion-context': require('../src/services/promotion-context'),
    './xl-welcome-pricing': { context: async () => ({ enabled: false, eligible: false }), forStore: value => value, prompt: () => '', applyQuote: value => value },
    './scheduled-orders': { isFutureOrderIntent: () => false, isSoftFutureIntent: () => false, extractScheduledOrderData: async () => ({}), formatDateEs: value => value },
  });
  return { pipeline, calls };
}

for (const message of ['Siiii , por supuesto los espero', 'Si por supuesto, acá estoy']) {
  test(`el pipeline guarda la orden antes de confirmar: ${message}`, async () => {
    const f = fixture();
    const result = await f.pipeline.processMessage(7, 91, message);
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.orders[0].organizationId, 7);
    assert.equal(f.calls.orders[0].conversationId, 91);
    assert.equal(f.calls.orders[0].totalPrice, 12990);
    assert.equal(result.orderCreated.orderId, 812);
    assert.equal(result.newState, 'confirmed');
    assert.match(result.response, /pedido confirmado/i);
  });
}

test('una frase del bot no crea una orden sin la confirmación del cliente', async () => {
  const f = fixture({ response: 'Te confirmo el pedido: te llegan mañana.' });
  const result = await f.pipeline.processMessage(7, 91, 'Bandeja café');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /antes de crear tu pedido/i);
  assert.doesNotMatch(result.response, /te confirmo el pedido|te llegan/i);
});

test('si guardar falla no se confirma ni se promete entrega', async () => {
  const f = fixture({ failSave: true });
  const result = await f.pipeline.processMessage(7, 91, 'Si por supuesto, acá estoy');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.orderCreated, undefined);
  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /problema técnico al registrar/i);
  assert.doesNotMatch(result.response, /pedido confirmado|te llegan|en camino/i);
});

test('se conserva el bloqueo de duplicados al reconocer una confirmación larga', async () => {
  const f = fixture({ duplicate: true });
  const result = await f.pipeline.processMessage(7, 91, 'Siiii , por supuesto los espero');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.duplicate, true);
  assert.equal(result.response, null);
});

test('un producto ambiguo sigue requiriendo aclaración antes de guardar', async () => {
  const f = fixture({ history: [], draft: { ...draft(), items: [{ product_name: 'Producto inexistente', quantity: 1 }] } });
  const result = await f.pipeline.processMessage(7, 91, 'Siiii , por supuesto los espero');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /confirmar un producto/i);
});
