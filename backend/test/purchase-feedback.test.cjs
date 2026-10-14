const test = require('node:test');
const assert = require('node:assert/strict');
const feedback = require('../src/services/purchase-feedback');
const { load } = require('./helpers.cjs');

test('pregunta por una compra futura cuando el cliente ya no necesita', () => {
  for (const message of [
    'Hola, por el momento no lo tomaré',
    'Disculpe pero no necesito... Gracias',
  ]) {
    const result = feedback.nextAction({ message, state: 'interested', draft: {} });
    assert.equal(result.state, 'future_interest');
    assert.match(result.response, /considerarías para una próxima compra/i);
    assert.equal(result.draft.purchase_feedback.status, 'awaiting_future_consideration');
    assert.equal(result.draft.purchase_feedback.initial_reason, 'no_need');
  }
});

test('también pregunta por una compra futura si compró en otro lugar', () => {
  const result = feedback.nextAction({
    message: 'YA NO NECESITO., YA COMPRÉ POR OTRO MEDIO',
    state: 'interested',
    draft: {},
  });
  assert.match(result.response, /considerarías para una próxima compra/i);
  assert.equal(result.draft.purchase_feedback.status, 'awaiting_future_consideration');
  assert.equal(result.draft.purchase_feedback.initial_reason, 'competitor');
});

test('una respuesta positiva cierra la consulta sin pedir un motivo', () => {
  const result = feedback.nextAction({
    message: 'Sí, claro',
    state: 'future_interest',
    draft: { purchase_feedback: { status: 'awaiting_future_consideration', initial_reason: 'no_need' } },
  });
  assert.equal(result.draft.purchase_feedback.status, 'completed');
  assert.equal(result.draft.purchase_feedback.future_consideration, true);
  assert.doesNotMatch(result.response, /precio|motivo/i);
});

test('una respuesta negativa pregunta el motivo una sola vez', () => {
  const pending = feedback.nextAction({
    message: 'No',
    state: 'future_interest',
    draft: { purchase_feedback: { status: 'awaiting_future_consideration', initial_reason: 'competitor' } },
  });
  assert.equal(pending.draft.purchase_feedback.status, 'awaiting_loss_reason');
  assert.equal(pending.draft.purchase_feedback.future_consideration, false);
  assert.match(pending.response, /precio, despacho, disponibilidad o producto.*atención/i);

  const completed = feedback.nextAction({
    message: 'Fue por precio',
    state: 'future_interest',
    draft: pending.draft,
  });
  assert.equal(completed.draft.purchase_feedback.status, 'completed');
  assert.equal(completed.draft.purchase_feedback.reason, 'price');
  assert.equal(completed.draft.purchase_feedback.future_consideration, false);
});

test('registra atención o servicio como motivo confirmado', () => {
  const result = feedback.nextAction({
    message: 'Fue por la atención, se demoraron mucho',
    state: 'future_interest',
    draft: { purchase_feedback: { status: 'awaiting_loss_reason', initial_reason: 'competitor' } },
  });
  assert.equal(result.draft.purchase_feedback.status, 'completed');
  assert.equal(result.draft.purchase_feedback.reason, 'service');
});

test('acepta el motivo junto con el no sin volver a preguntar', () => {
  const result = feedback.nextAction({
    message: 'No, fue por el despacho',
    state: 'future_interest',
    draft: { purchase_feedback: { status: 'awaiting_future_consideration', initial_reason: 'no_need' } },
  });
  assert.equal(result.draft.purchase_feedback.status, 'completed');
  assert.equal(result.draft.purchase_feedback.reason, 'delivery');
  assert.match(result.response, /gracias por contármelo/i);
});

test('no interfiere con bajas, pedidos activos ni una nueva intención de compra', () => {
  assert.equal(feedback.nextAction({ message: 'No me escriban más', state: 'interested', draft: {} }), null);
  assert.equal(feedback.nextAction({ message: 'Ya no necesito', state: 'collecting_order', draft: {} }), null);
  assert.equal(feedback.nextAction({
    message: 'Ahora sí, quiero pedir dos bandejas',
    state: 'future_interest',
    draft: { purchase_feedback: { status: 'awaiting_loss_reason', initial_reason: 'no_need' } },
  }), null);
});

test('el pipeline conserva el borrador y evita llamadas comerciales innecesarias', async () => {
  let update = null;
  const db = {
    getConversationById: async (_id, orgId) => ({
      id: 41, organization_id: orgId, pipeline_state: 'interested', agent_mode: 'ai',
      order_draft: JSON.stringify({ customer_name: 'Ana', items: [] }),
    }),
    getLastMessages: async () => [],
    updatePipelineState: async (id, state, draft) => { update = { id, state, draft }; },
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './order-pricing': require('../src/services/order-pricing'),
    './commercial': {
      consumeBotTurn: async orgId => assert.equal(orgId, 7),
      permitted: async () => { throw new Error('no debería consultar permisos después del cierre'); },
    },
  });

  const result = await pipeline.processMessage(7, 41, 'Disculpe pero no necesito... Gracias');

  assert.equal(result.newState, 'future_interest');
  assert.match(result.response, /próxima compra/i);
  assert.equal(update.id, 41);
  assert.equal(update.state, 'future_interest');
  assert.equal(update.draft.customer_name, 'Ana');
  assert.equal(update.draft.purchase_feedback.status, 'awaiting_future_consideration');
});
