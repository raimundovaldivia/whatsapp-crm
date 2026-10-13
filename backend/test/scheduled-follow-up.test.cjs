const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function buildFollowUp(productNotes) {
  const calls = { sent: [], states: [], marked: [] };
  const db = {
    getConversationById: async () => ({ id: 25, organization_id: 3, phone_number: '56925252525' }),
    saveMessage: async value => ({ id: 1, ...value }),
    updateConversationLastMessage: async () => {},
    updatePipelineState: async (_id, state, draft) => calls.states.push({ state, draft }),
    markScheduledOrderSent: async (id, orgId) => calls.marked.push({ id, orgId }),
    createOrder: async () => { throw new Error('el recordatorio no debe crear pedidos'); },
  };
  const followUp = load('src/services/scheduled-follow-up.js', {
    '../db/database': db,
    './commercial': { permitted: async () => true },
    './kapso-whatsapp': {},
    './whatsapp-provider': {
      configForConversation: async () => ({ provider: 'evolution' }),
      sendTextMessage: async (_phone, content) => { calls.sent.push(content); return { id: 'wamid-1' }; },
      messageId: result => result.id,
    },
    './delivery-notifications': {},
    './template-automation': {},
    './conversation-mode': { activateDivaForAutomatedMessage: async () => {} },
    './outbound-policy': { isCustomerMessagingHour: () => true },
  });
  const order = {
    id: 95,
    organization_id: 3,
    conversation_id: 25,
    phone: '56925252525',
    customer_name: 'Patricia Cespedes',
    product_notes: productNotes,
    desired_date: '2026-10-13',
  };
  return { followUp, order, calls };
}

test('el recordatorio pide confirmación y no crea un pedido antes de la respuesta', async () => {
  const { followUp, order, calls } = buildFollowUp('30 huevos XL');

  await followUp._processScheduledOrder(order, null);

  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0], /¿Confirmamos el pedido\?/i);
  assert.doesNotMatch(calls.sent[0], /preparado para despacho|va en camino/i);
  assert.equal(calls.states.length, 1);
  assert.equal(calls.states[0].state, 'collecting_order');
  assert.equal(calls.states[0].draft.product_name, '30 huevos XL');
  assert.deepEqual(calls.marked, [{ id: 95, orgId: 3 }]);
});

test('un agendamiento legado sin producto concreto pregunta qué desea y no inventa el habitual', async () => {
  const { followUp, order, calls } = buildFollowUp('su pedido habitual');

  await followUp._processScheduledOrder(order, null);

  assert.match(calls.sent[0], /¿Qué te gustaría pedir\?/i);
  assert.doesNotMatch(calls.sent[0], /su pedido habitual/i);
  assert.equal(calls.states.length, 1);
  assert.equal(calls.states[0].state, 'collecting_order');
  assert.equal(Object.keys(calls.states[0].draft).length, 0);
});
