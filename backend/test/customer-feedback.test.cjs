const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function serviceWith(query) {
  return load('src/services/customer-feedback.js', {
    '../db/database': { getPool: () => ({ query }), getConversationById: async () => null },
    './delivery-notifications': { sendCustomerFeedbackRequest: async () => ({ sent: true }) },
    './outbound-policy': { isCustomerMessagingHour: () => true },
  });
}

test('interpreta notas y comentarios claros sin confundir un pedido nuevo', () => {
  const service = serviceWith(async () => ({ rows: [] }));
  assert.equal(service.parseFeedbackReply('5, todo excelente').score, 5);
  assert.equal(service.parseFeedbackReply('5, todo excelente').sentiment, 'positive');
  assert.equal(service.parseFeedbackReply('2/5, podría mejorar').sentiment, 'negative');
  assert.equal(service.parseFeedbackReply('No quedé conforme').sentiment, 'negative');
  assert.equal(service.parseFeedbackReply('Quiero 2 bandejas'), null);
});

test('descubre solo la primera compra cruzando pedidos bot y Shopify', async () => {
  let sql = '';
  const service = serviceWith(async statement => { sql = statement; return { rows: [], rowCount: 3 }; });
  assert.equal(await service.discoverFirstPurchaseFeedback(), 3);
  assert.match(sql, /UNION ALL[\s\S]*shopify_orders/);
  assert.match(sql, /ROW_NUMBER\(\)[\s\S]*PARTITION BY[\s\S]*organization_id/);
  assert.match(sql, /purchase_number = 1/);
  assert.match(sql, /INTERVAL '24 hours'/);
  assert.match(sql, /ON CONFLICT \(organization_id, customer_phone\) DO NOTHING/);
});

test('registra la respuesta únicamente en la organización y conversación esperadas', async () => {
  let params;
  const service = serviceWith(async (_sql, values) => {
    params = values;
    return { rows: [{ id: 9, organization_id: 4, conversation_id: 22 }] };
  });
  const result = await service.handleInboundFeedback(4, 22, '3, la entrega fue lenta');
  assert.equal(result.needsHuman, true);
  assert.equal(params[3], 4);
  assert.equal(params[4], 22);
});

test('excluye bajas y postventa activa antes de enviar', async () => {
  const optedOut = serviceWith(async () => ({ rows: [{ agent_mode: 'ai', pipeline_state: 'done', opted_out: true }] }));
  assert.equal((await optedOut.requestEligibility({ query: async () => ({ rows: [{ agent_mode: 'ai', pipeline_state: 'done', opted_out: true }] }) }, {
    conversation_id: 1, organization_id: 2, customer_phone: '912345678',
  })).reason, 'OPTED_OUT');

  const activePostSale = serviceWith(async () => ({ rows: [] }));
  assert.equal((await activePostSale.requestEligibility({ query: async () => ({ rows: [{ agent_mode: 'coordinating', pipeline_state: 'done', opted_out: false }] }) }, {
    conversation_id: 1, organization_id: 2, customer_phone: '912345678',
  })).reason, 'ACTIVE_POST_SALE');
});

test('el reporte de feedback queda aislado por organización', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return /COUNT\(\*\)/.test(sql)
      ? { rows: [{ responses: 1, awaiting: 0, positive: 1, negative: 0, average_score: '5.00' }] }
      : { rows: [{ id: 1, feedback_text: 'Excelente' }] };
  } };
  const router = load('src/routes/customer-feedback.js', {
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const res = response();
  await handler(router, 'get', '/')({ orgId: 7, query: { limit: '20' } }, res);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.params[0] === 7));
});
