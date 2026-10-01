const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function buildPipeline(deliveryDate, status = 'draft') {
  const db = {
    getConversationById: async () => ({
      id: 71,
      organization_id: 1,
      phone_number: '56911111111',
      contact_name: 'Katherine',
      pipeline_state: 'exploring',
      agent_mode: 'ai',
    }),
    getLastMessages: async () => [],
    getSetting: async () => null,
    getContact: async () => ({ name: 'Katherine Andrea Bravo Becerra', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => ({}),
    getActiveOrderForBot: async () => ({
      id: 88,
      status,
      delivery_date: deliveryDate,
      customer_name: 'Katherine Andrea Bravo Becerra',
      total_price: 45000,
      items: [{ quantity: 1, name: 'Caja 100 Huevos Jumbo' }],
      shipping_address: { address: 'Gobernador Demetrio Reygada 4005', city: 'Coquimbo' },
    }),
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  };

  return load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => false },
    './inbound-message-policy': {
      isLikelyAutomaticReply: () => false,
      isGiftedStockReply: () => false,
      isBareLinkMessage: () => false,
    },
    './shopify-api': { formatProductsForAI: () => '' },
    './promotion-context': {
      fromHistory: () => null,
      restore: () => null,
      promptSection: () => '',
      selectedOffer: () => null,
    },
    './payment-collection': { getPendingCharges: async () => [] },
    './scheduled-orders': {
      isFutureOrderIntent: () => false,
      isSoftFutureIntent: () => false,
      extractScheduledOrderData: async () => ({}),
      formatDateEs: value => `fecha ${String(value).slice(0, 10)}`,
    },
    './agents/orchestrator': {
      checkEscalation: async () => ({ escalate: false, urgency: 'low', reason: '' }),
      classifyIntent: async () => ({ intent: 'post_sale', confidence: 1, reason: 'consulta de reparto' }),
    },
  });
}

test('un pedido agendado para hoy pero fuera de ruta pide confirmación humana con el estado real', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(today, 'draft');

  const result = await pipeline.processMessage(1, 71, '¿Mi pedido de los huevitos hoy se hará el reparto?');

  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /agendado para hoy/i);
  assert.match(result.response, /todavía figura en preparación/i);
  assert.match(result.response, /aún no aparece en ruta/i);
  assert.match(result.escalationReason, /agendado para hoy/i);
});

test('la fecha real de un pedido futuro se responde aunque logística no esté habilitada', async () => {
  const future = new Date(Date.now() + 4 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(future, 'draft');

  const result = await pipeline.processMessage(1, 71, '¿Cuándo llega mi pedido?');

  assert.equal(result.switchToHuman, false);
  assert.match(result.response, new RegExp(`agendado para el fecha ${future}`, 'i'));
});
