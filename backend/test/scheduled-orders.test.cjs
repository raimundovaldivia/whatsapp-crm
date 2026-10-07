const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

class FakeAnthropic {
  constructor() { this.messages = { create: async () => ({ content: [{ text: '{}' }] }) }; }
}

const scheduled = load('src/services/scheduled-orders.js', { '@anthropic-ai/sdk': FakeAnthropic });

test('detecta la fecha aunque el cliente también diga que todavía le queda stock', () => {
  assert.equal(scheduled.isFutureOrderIntent('Hola buenas noches, si se pudiera para miércoles. Aún me quedan unos poquitos'), true);
});

test('detecta un día respondido después de preguntar cuánto durará el stock', () => {
  assert.equal(scheduled.isFutureOrderIntent('Miércoles los tengo calculados jajajaja, sí miércoles'), true);
  assert.equal(scheduled.isFutureOrderIntent('miércoles'), true);
  assert.equal(scheduled.isFutureOrderIntent('Para el viernes 16 de Octubre.'), true);
});

test('una consulta general que solo menciona un día no agenda un pedido', () => {
  assert.equal(scheduled.isFutureOrderIntent('¿Hacen repartos los miércoles en Coquimbo?'), false);
});

test('pipeline agenda una respuesta a template con fecha antes de iniciar un pedido inmediato', async () => {
  let scheduledOrder = null;
  let state = null;
  let immediateOrders = 0;
  const db = {
    getConversationById: async () => ({ id: 7, organization_id: 1, phone_number: '56911111111', contact_name: 'Katherine', pipeline_state: 'template_sent', agent_mode: 'ai' }),
    getLastMessages: async () => [{ direction: 'outbound', content: '[Template: recordatorio_pedido_habitual]\n\nTenemos Caja 100 Huevos Jumbo. ¿Te preparamos tu pedido?' }],
    getSetting: async (_org, key) => key === 'scheduled_order_template' ? 'confirmar_pedido_agendado' : null,
    getContact: async () => ({ name: 'Katherine Andrea Bravo Becerra', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => null,
    createScheduledOrder: async value => { scheduledOrder = value; return { id: 1, ...value }; },
    updatePipelineState: async (_id, value) => { state = value; },
    createOrder: async () => { immediateOrders++; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => ({ desiredDate: '2026-09-30', productNotes: '1 caja de 100 Huevos Jumbo' }),
      formatDateEs: () => 'miércoles 30 de septiembre',
    },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 7, 'Hola buenas noches. Si se pudiera para miércoles, aún me quedan unos poquitos');
  assert.equal(result.newState, 'scheduled');
  assert.match(result.response, /agendado.*miércoles/i);
  assert.equal(state, 'scheduled');
  assert.equal(scheduledOrder.desiredDate, '2026-09-30');
  assert.equal(scheduledOrder.productNotes, '1 caja de 100 Huevos Jumbo');
  assert.equal(immediateOrders, 0);
  scheduledOrder = null;
  const tentative = await pipeline.processMessage(1, 7, 'Lo tendré en cuenta para la próxima semana');
  assert.equal(scheduledOrder, null);
  assert.equal(tentative.newState, 'future_interest');
  assert.doesNotMatch(tentative.response, /agendado|apartado|pedido habitual/i);

});

test('una consulta por promo para mañana aclara condiciones y no agenda cantidad desconocida', async () => {
  let scheduledOrders = 0;
  let state = null;
  let savedDraft = null;
  const promoText = '[Template: promocion_general_entrega_mismo_dia]\n\n🥚✨ ¡Tenemos promos Enrique! 40 Jumbo $16.000 | 60 Jumbo $23.500 | 100 Jumbo $35.000 | Válido solo para pedidos de hoy. Haz tu pedido antes de las 11:00 AM y, si tenemos stock disponible, te lo entregamos el mismo día.';
  const db = {
    getConversationById: async () => ({ id: 17, organization_id: 1, phone_number: '56917171717', contact_name: 'Enrique', pipeline_state: 'template_sent', agent_mode: 'ai' }),
    getLastMessages: async () => [{ direction: 'outbound', content: promoText, created_at: new Date() }],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Enrique', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [
      { id: 1, title: 'Caja 40 Huevos Jumbo', price: 20000, active: true },
      { id: 2, title: 'Caja 60 Huevos Jumbo', price: 28000, active: true },
      { id: 3, title: 'Caja 100 Huevos Jumbo', price: 45000, active: true },
    ],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => null,
    createScheduledOrder: async () => { scheduledOrders++; },
    updatePipelineState: async (_id, value, draft) => { state = value; savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => ({ desiredDate: '2026-09-30', productNotes: 'cantidad pendiente' }),
      formatDateEs: () => 'miércoles 30 de septiembre',
    },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 17, 'Me gustaría pedir pero para mañana, ¿me respetan la oferta?');
  assert.equal(result.newState, 'interested');
  assert.equal(state, 'interested');
  assert.equal(scheduledOrders, 0);
  assert.match(result.response, /si confirmas el pedido hoy se respeta/i);
  assert.match(result.response, /100 Jumbo a \$35\.000/i);
  assert.doesNotMatch(result.response, /cantidad a confirmar/i);
  assert.equal(savedDraft.delivery_date, '2026-09-30');
  assert.equal(savedDraft.promotion.templateName, 'promocion_general_entrega_mismo_dia');
});

test('la cantidad promocional elegida después conserva fecha y precio en vez de crear un agendado genérico', async () => {
  let scheduledOrders = 0;
  let savedDraft = null;
  const promoText = '[Template: promocion_general_entrega_mismo_dia]\n\n🥚✨ ¡Tenemos promos Enrique! 40 Jumbo $16.000 | 60 Jumbo $23.500 | 100 Jumbo $35.000 | Válido solo para pedidos de hoy. Haz tu pedido antes de las 11:00 AM y, si tenemos stock disponible, te lo entregamos el mismo día.';
  const previousDraft = {
    delivery_date: '2026-09-30',
    promotion: {
      templateName: 'promocion_general_entrega_mismo_dia',
      offers: [
        { units: 40, descriptor: 'Jumbo', price: 16000, label: '40 Jumbo' },
        { units: 60, descriptor: 'Jumbo', price: 23500, label: '60 Jumbo' },
        { units: 100, descriptor: 'Jumbo', price: 35000, label: '100 Jumbo' },
      ],
      specialPrices: {}, sentDay: '2026-09-29', validUntil: '2026-09-29', validOnlyToday: true,
    },
  };
  const db = {
    getConversationById: async () => ({ id: 18, organization_id: 1, phone_number: '56918181818', contact_name: 'Enrique', pipeline_state: 'interested', agent_mode: 'ai' }),
    getLastMessages: async () => [
      { direction: 'outbound', content: promoText, created_at: new Date() },
      { direction: 'inbound', content: 'Me gustaría pedir pero para mañana, ¿me respetan la oferta?' },
      { direction: 'outbound', content: 'Sí. ¿Cuál te guardo: 40 Jumbo, 60 Jumbo o 100 Jumbo?' },
    ],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Enrique Collao', address1: 'Dirección 123', city: 'Coquimbo', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => previousDraft,
    getActiveOrderForBot: async () => null,
    createScheduledOrder: async () => { scheduledOrders++; },
    updatePipelineState: async (_id, state, draft) => { if (state === 'collecting_order') savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './agents/orchestrator': {
      checkEscalation: async () => ({ shouldEscalate: false }),
      classifyIntent: async () => ({ intent: 'unknown', confidence: 0.2 }),
    },
    './agents/orders': {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => draft,
      generateOrderResponse: async () => '¡Listo! 60 Jumbo a $23.500 para mañana. ¿Todo correcto?',
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => true,
      missingFields: () => [],
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => ({ desiredDate: '2026-09-30', productNotes: '60 Jumbo' }),
      formatDateEs: () => 'miércoles 30 de septiembre',
    },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 18, '60 huevos Jumbo $23.500 para el miércoles 30, por favor');
  assert.equal(result.newState, 'collecting_order');
  assert.equal(scheduledOrders, 0);
  assert.equal(savedDraft.delivery_date, '2026-09-30');
  assert.equal(savedDraft.items[0].name, '60 huevos Jumbo');
  assert.equal(savedDraft.items[0].price, 23500);
  assert.equal(savedDraft.total, 23500);
  assert.equal(savedDraft.items[0].locked_quote, true);
});

for (const scenario of [
  { name: 'una opción promocional exacta vigente entra al pedido sin escalar a humano', now: '2026-10-01T16:10:00Z', active: true },
  { name: 'una opción promocional vencida no aplica el precio antiguo y sigue la clasificación normal', now: '2026-10-05T16:10:00Z', active: false },
]) test(scenario.name, async () => {
  let escalationChecks = 0;
  let savedDraft = null;
  let agentMode = null;
  // El escenario conserva su fecha aunque cambie el día de ejecución.
  // Usamos el evaluador real de promociones con un reloj explícito.
  const promotions = require('../src/services/promotion-context');
  const now = new Date(scenario.now);
  const promoText = `[Template: promocion_general_entrega_mismo_dia]

🥚✨ ¡Tenemos promos Oscar! | 📅 Promoción válida hasta el sábado 03/10/2026, inclusive, para pedidos con entrega hasta ese día. | 🥚 Jumbo: 40 unidades $18.000 | 60 unidades $25.500 | 100 unidades $37.000 | 🥚 XL: 30 unidades $12.000 | 60 unidades $23.000 | 90 unidades $34.000 | 🫒 Aceitunas de 500 g: lleva 2 envases, paga el primero a precio normal y recibe 50% de descuento en el segundo. | 🧀 Queso de cabra 900 g $15.000 | 🚚 Despacho gratis en compras desde $10.000 | Promoción sujeta a disponibilidad de stock.`;
  const db = {
    getConversationById: async () => ({ id: 19, organization_id: 1, phone_number: '56919191919', contact_name: 'Oscar', pipeline_state: 'template_sent', agent_mode: 'ai' }),
    setAgentMode: async (_id, mode) => { agentMode = mode; },
    setLastEscalation: async () => {},
    getLastMessages: async () => [{ direction: 'outbound', content: promoText, created_at: '2026-10-01T13:05:00-03:00' }],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Oscar', address1: 'Dirección 123', city: 'Coquimbo', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [{ id: 3, title: 'Caja 100 Huevos Jumbo', price: 45000, active: true }],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => null,
    updatePipelineState: async (_id, state, draft) => { if (state === 'collecting_order') savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './promotion-context': {
      ...promotions,
      fromHistory: (history, products) => promotions.fromHistory(history, products, now),
      restore: saved => promotions.restore(saved, now),
    },
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './agents/orchestrator': {
      checkEscalation: async () => { escalationChecks++; return { escalate: true, urgency: 'medium', reason: 'incorrecto' }; },
      classifyIntent: async () => ({ intent: 'unknown', confidence: 0.1 }),
    },
    './agents/orders': {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => draft,
      generateOrderResponse: async () => '¡Listo! 100 Jumbo a $37.000. ¿Todo correcto?',
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => true,
      missingFields: () => [],
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => null,
      formatDateEs: value => value,
    },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 19, 'Quiero 100 jumbo');
  if (!scenario.active) {
    assert.equal(escalationChecks, 1);
    assert.equal(savedDraft, null);
    assert.equal(agentMode, 'coordinating');
    assert.equal(result.switchToHuman, true);
    assert.doesNotMatch(result.response, /37[.,]000/);
    return;
  }
  assert.equal(result.newState, 'collecting_order');
  assert.equal(escalationChecks, 0);
  assert.equal(savedDraft.items[0].price, 37000);
  assert.equal(savedDraft.items[0].locked_quote, true);
  assert.equal(savedDraft.total, 37000);
  assert.match(result.response, /100 Jumbo.*37\.000/i);
});

test('una preferencia de frescura se conserva como nota del pedido promocional', async () => {
  let savedDraft = null;
  const existingDraft = {
    customer_name: 'Oscar',
    address: 'Dirección 123',
    city: 'Coquimbo',
    items: [{ product_name: '100 Jumbo', quantity: 1, price: 37000, locked_quote: true, promotion_offer: true }],
    promotion: { active: true },
  };
  const db = {
    getConversationById: async () => ({ id: 20, organization_id: 1, phone_number: '56920202020', contact_name: 'Oscar', pipeline_state: 'collecting_order', agent_mode: 'ai' }),
    getLastMessages: async () => [],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Oscar', address1: 'Dirección 123', city: 'Coquimbo', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [{ id: 3, title: 'Caja 100 Huevos Jumbo', price: 45000, active: true }],
    getOrderDraft: async () => existingDraft,
    getActiveOrderForBot: async () => null,
    updatePipelineState: async (_id, state, draft) => { if (state === 'collecting_order') savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './agents/orchestrator': {
      checkEscalation: async () => ({ escalate: false }),
      classifyIntent: async () => ({ intent: 'order', confidence: 1 }),
    },
    './agents/orders': {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => ({ ...draft }),
      generateOrderResponse: async () => 'Claro, anoté que los quieres bien frescos. ¿Todo correcto?',
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => true,
      missingFields: () => [],
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => null,
      formatDateEs: value => value,
    },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 20, 'Pero que estén bien frescos por fa');
  assert.equal(result.newState, 'collecting_order');
  assert.match(savedDraft.notes, /productos bien frescos/i);
  assert.match(result.response, /bien frescos/i);
});

test('un sí a un template con varias promociones pide elegir y no crea un pedido al azar', async () => {
  let createdOrders = 0;
  let savedState = null;
  let savedDraft = null;
  const promoText = `[Template: promocion_general_entrega_mismo_dia]
PROMO DIEZ RIOS: QUESO DE CABRA + BANDEJA XL 30 = $25.000
| 2 BANDEJAS XL DE 30 HUEVOS A $23.000
| 2 BANDEJAS JUMBO DE 20 HUEVOS A $18.000
| 3 BANDEJAS XL DE 30 HUEVOS A $30.000
| 3 BANDEJAS JUMBO DE 20 HUEVOS A $27.000`;
  const db = {
    getConversationById: async () => ({ id: 31, organization_id: 1, phone_number: '56931000000', contact_name: 'Roxana', pipeline_state: 'template_sent', agent_mode: 'ai' }),
    getLastMessages: async () => [{ direction: 'outbound', content: promoText, created_at: new Date() }],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Roxana', address1: 'Juan Soldado 458', city: 'La Serena', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => null,
    createOrder: async () => { createdOrders++; },
    updatePipelineState: async (_id, state, draft) => { savedState = state; savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 31, 'Sí');
  assert.equal(result.newState, 'interested');
  assert.equal(savedState, 'interested');
  assert.equal(createdOrders, 0);
  assert.equal(savedDraft.items, undefined);
  assert.match(result.response, /¿Cuál de estas promociones quieres\?/i);
  assert.match(result.response, /QUESO DE CABRA \+ BANDEJA XL 30.*\$25\.000/is);
});

test('elegir la promo correcta tras una confirmación errónea prepara la edición del mismo pedido', async () => {
  let savedDraft = null;
  let createdOrders = 0;
  const promoText = `[Template: promocion_general_entrega_mismo_dia]
PROMO DIEZ RIOS: QUESO DE CABRA + BANDEJA XL 30 = $25.000
| 2 BANDEJAS XL DE 30 HUEVOS A $23.000
| 2 BANDEJAS JUMBO DE 20 HUEVOS A $18.000
| 3 BANDEJAS XL DE 30 HUEVOS A $30.000
| 3 BANDEJAS JUMBO DE 20 HUEVOS A $27.000`;
  const products = [
    { id: 'cheese', title: 'Queso de Cabra Fresco Pasteurizado – 900 g', price: 15000, active: true },
    { id: 'xl30', title: 'Huevos de Campo Tamaño XL – Bandeja 30 Unidades', price: 12000, active: true },
  ];
  const activeOrder = {
    id: 88, status: 'nuevo', customer_name: 'Roxana', created_at: new Date(), total_price: 30000,
    items: [{ name: 'Huevos de Campo Tamaño XL – Bandeja 30 Unidades', quantity: 1, price: 30000 }],
    shipping_address: { address: 'Juan Soldado 458', city: 'La Serena' },
  };
  const db = {
    getConversationById: async () => ({ id: 32, organization_id: 1, phone_number: '56932000000', contact_name: 'Roxana', pipeline_state: 'confirmed', agent_mode: 'ai' }),
    getLastMessages: async () => [
      { direction: 'outbound', content: promoText, created_at: new Date() },
      { direction: 'inbound', content: 'Si' },
      { direction: 'outbound', content: '✅ ¡Pedido confirmado!\n\n1x XL — $30.000', created_at: new Date() },
    ],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Roxana', address1: 'Juan Soldado 458', city: 'La Serena', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => products,
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => activeOrder,
    createOrder: async () => { createdOrders++; },
    updatePipelineState: async (_id, state, draft) => { if (state === 'collecting_order') savedDraft = draft; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './agents/orders': {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => ({ ...draft }),
      generateOrderResponse: async () => 'Queso de cabra + bandeja XL 30 por $25.000. ¿Todo correcto?',
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => true,
      missingFields: () => [],
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => null,
      formatDateEs: value => value,
    },
    './shopify-api': { formatProductsForAI: () => '' },
  });

  const result = await pipeline.processMessage(1, 32, 'Queso de cabra más huevos');
  assert.equal(result.newState, 'collecting_order');
  assert.equal(createdOrders, 0);
  assert.equal(savedDraft.editing_order_id, 88);
  assert.equal(savedDraft.total, 25000);
  assert.deepEqual(savedDraft.items.map(item => [item.name, item.price]), [
    ['QUESO DE CABRA + BANDEJA XL 30', 25000],
  ]);
});

test('pipeline agenda la fecha respondida tras decir que aún queda stock sin escalar a humano', async () => {
  let scheduledOrder = null;
  let state = null;
  let escalationChecks = 0;
  const db = {
    getConversationById: async () => ({ id: 8, organization_id: 1, phone_number: '56922222222', contact_name: 'Sandra', pipeline_state: 'future_interest', agent_mode: 'ai' }),
    getLastMessages: async () => [
      { direction: 'inbound', content: 'Hola. Aún me quedan huevos. Gracias.' },
      { direction: 'outbound', content: '¿Cuánto tiempo más te duran aproximadamente?' },
    ],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Sandra', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => null,
    createScheduledOrder: async value => { scheduledOrder = value; return { id: 2, ...value }; },
    updatePipelineState: async (_id, value) => { state = value; },
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => ({ desiredDate: '2026-10-16', productNotes: '1 bandeja de huevos M' }),
      formatDateEs: () => 'viernes 16 de octubre',
    },
    './shopify-api': { formatProductsForAI: () => '' },
    './agents/orchestrator': {
      checkEscalation: async () => { escalationChecks++; throw new Error('no debe clasificar ni escalar'); },
    },
  });

  const result = await pipeline.processMessage(1, 8, 'Para el viernes 16 de Octubre.');
  assert.equal(result.newState, 'scheduled');
  assert.match(result.response, /agendado.*viernes 16 de octubre/i);
  assert.equal(state, 'scheduled');
  assert.equal(scheduledOrder.desiredDate, '2026-10-16');
  assert.equal(escalationChecks, 0);
});

test('una conversación ya agendada recibe contexto humano y reglas contra repeticiones', async () => {
  let capturedSystem = '';
  class ConversationalAnthropic {
    constructor() {
      this.messages = { create: async input => {
        capturedSystem = input.system;
        return { content: [{ text: '¡De nada, Sandra! Quedó reservado para el viernes 😊' }] };
      } };
    }
  }
  const db = {
    getConversationById: async () => ({ id: 9, organization_id: 1, phone_number: '56933333333', contact_name: 'Sandra', pipeline_state: 'scheduled', agent_mode: 'ai' }),
    getLastMessages: async () => [{ direction: 'inbound', content: 'Muchas gracias' }],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Sandra', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => null,
    getPool: () => ({ query: async sql => sql.includes('FROM scheduled_orders')
      ? { rows: [{ id: 3, desired_date: '2026-10-02', product_notes: '1 bandeja de huevos XL' }] }
      : { rows: [], rowCount: 0 } }),
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false },
    './scheduled-orders': {
      isFutureOrderIntent: scheduled.isFutureOrderIntent,
      isSoftFutureIntent: scheduled.isSoftFutureIntent,
      extractScheduledOrderData: async () => ({}),
      formatDateEs: () => 'viernes 2 de octubre',
    },
    './shopify-api': { formatProductsForAI: () => '' },
    '@anthropic-ai/sdk': ConversationalAnthropic,
  });

  const result = await pipeline.processMessage(1, 9, 'Muchas gracias');
  assert.equal(result.newState, 'scheduled');
  assert.match(result.response, /De nada, Sandra/);
  assert.match(capturedSystem, /no volver a venderle ni reiniciar el pedido/i);
  assert.match(capturedSystem, /Si solo agradece, confirma brevemente y cierra sin preguntas/i);
  assert.match(capturedSystem, /no recites de nuevo todos los datos/i);
});


test('tentative interest never becomes a scheduled order even with a date', async () => {
  for (const message of ['Lo tendré en cuenta para la próxima semana', 'Quizás para el viernes', 'Te aviso que podría ser', 'Tal vez mañana']) {
    assert.equal(scheduled.isFutureOrderIntent(message), false, message);
    assert.equal(scheduled.isSoftFutureIntent(message), true, message);
  }
  const extracted = await scheduled.extractScheduledOrderData('Para la próxima semana', [], '2026-10-06');
  assert.equal(extracted.desiredDate, null);
  assert.equal(extracted.productNotes, null);
});

test('internal instructions are blocked before reaching the customer', async () => {
  const guard = load('src/services/response-guardrail.js');
  assert.equal((await guard.checkResponseFreshness(1, 1, 'El último mensaje está incompleto. Espero el resto para responder apropiadamente.')).ok, false);
  assert.equal((await guard.checkResponseFreshness(1, 1, 'Si el cliente completa el mensaje, responde únicamente a lo que diga.')).ok, false);
  assert.equal((await guard.checkResponseFreshness(1, 1, 'Claro, avísame cuando lo tengas decidido 😊')).ok, true);
});
