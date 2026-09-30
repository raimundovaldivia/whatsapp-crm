const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

test('crear el pedido correcto manualmente elimina el borrador equivocado y pausa a Diva', async () => {
  const stateChanges = [];
  const modeChanges = [];
  const cleared = [];
  const emitted = [];
  const db = {
    getPool: () => ({ query: async () => ({ rows: [] }) }),
    getConversationById: async () => ({ id: 71, phone_number: '56911111111', contact_name: 'Rene' }),
    getContact: async () => ({ name: 'Rene', address: 'Floripondios 1021', city: 'La Serena' }),
    createOrder: async value => ({ id: 174, ...value }),
    updatePipelineState: async (id, state, draft) => stateChanges.push({ id, state, draft }),
    setAgentMode: async (id, mode) => modeChanges.push({ id, mode }),
    clearLastEscalation: async id => cleared.push(id),
    getWhatsappConfig: async () => null,
    saveMessage: async value => ({ id: 900, ...value }),
    updateConversationLastMessage: async () => {},
  };
  const router = load('src/routes/conversations.js', {
    '../db/database': db,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../utils/template-renderer.mjs': {
      getBodyComponent: () => null,
      getMissingBodyParameters: () => [],
      renderTemplateFromComponents: () => '',
    },
    '../services/outbound-policy': {},
    '../services/merge-conversations': {},
  });
  const res = response();
  await handler(router, 'post', '/71/orders')({
    orgId: 1,
    params: { id: '71' },
    body: {
      items: [{ productId: '20', title: 'Huevos Jumbo – Bandeja 20', price: 10000, quantity: 2 }],
      discount: 4000,
      discountType: 'fixed',
      sendSummary: true,
    },
    app: { get: () => ({ to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) }) },
  }, res);

  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(stateChanges)), [{ id: 71, state: 'confirmed', draft: {} }]);
  assert.deepEqual(modeChanges, [{ id: 71, mode: 'human' }]);
  assert.deepEqual(cleared, [71]);
  assert.equal(emitted.some(item => item.event === 'agent_mode_changed_1' && item.payload.mode === 'human'), true);
  assert.equal(res.body.order.totalPrice, 16000);
});
