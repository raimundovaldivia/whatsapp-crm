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
