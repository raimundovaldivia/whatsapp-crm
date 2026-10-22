const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

const atChile = value => new Date(`${value}-03:00`);

function harness({ candidate, optedOut = false }) {
  const calls = { sent: [], claimed: [], saved: [] };
  const db = {
    getHotClosingCandidates: async () => candidate ? [candidate] : [],
    getLastMessages: async () => [
      { direction: 'inbound', content: 'Quiero dos bandejas XL' },
      { direction: 'outbound', content: 'Perfecto, ¿cuál es tu dirección?' },
    ],
    getContact: async () => ({ opt_out: optedOut }),
    claimHotClosingFollowUp: async (orgId, id, stage) => {
      calls.claimed.push({ orgId, id, stage });
      return { ...candidate, hot_follow_up_count: 1, hot_follow_up_stage: stage };
    },
    saveMessage: async message => { calls.saved.push(message); return message; },
    updateConversationLastMessage: async () => {},
    getConversationById: async () => candidate,
    updatePipelineState: async () => {},
  };
  const whatsapp = {
    configForConversation: async () => ({ provider: 'kapso' }),
    sendTextMessage: async (phone, message) => { calls.sent.push({ phone, message }); return { messages: [{ id: 'wamid.1' }] }; },
    messageId: value => value.messages[0].id,
  };
  const service = load('src/services/follow-up.js', {
    '../db/database': db,
    './whatsapp-provider': whatsapp,
    './commercial': { permitted: async () => true },
    '@anthropic-ai/sdk': class { constructor() { this.messages = { create: async () => ({ content: [{ text: 'seguimiento' }] }) }; } },
  }, { console });
  return { service, calls };
}

test('envía el recordatorio de cinco minutos y pide solo el dato pendiente', async () => {
  const candidate = {
    id: 10, organization_id: 1, phone_number: '56911111111', contact_name: 'Ana',
    pipeline_state: 'collecting_order', agent_mode: 'ai',
    order_draft: JSON.stringify({ items: [{ product_name: 'XL', quantity: 2 }], customer_name: 'Ana' }),
    sales_started_at: atChile('2026-10-14T12:49:00'),
    same_day_hold_until: atChile('2026-10-14T13:00:00'),
  };
  const { service, calls } = harness({ candidate });
  const result = await service.runHotClosingFollowUp(null, atChile('2026-10-14T12:55:00'));
  assert.equal(result.sent, 1);
  assert.deepEqual(calls.claimed, [{ orgId: 1, id: 10, stage: 'address' }]);
  assert.match(calls.sent[0].message, /mantengo la opción de despacho para hoy/i);
  assert.match(calls.sent[0].message, /dirección de entrega/i);
});

test('después de las 12:50 no persigue un pedido nuevo sin reserva', async () => {
  const candidate = {
    id: 11, organization_id: 1, phone_number: '56922222222', contact_name: 'Berta',
    pipeline_state: 'interested', agent_mode: 'ai', order_draft: '{}',
    sales_started_at: atChile('2026-10-14T12:51:00'), same_day_hold_until: null,
  };
  const { service, calls } = harness({ candidate });
  const result = await service.runHotClosingFollowUp(null, atChile('2026-10-14T12:55:00'));
  assert.equal(result.sent, 0);
  assert.equal(calls.claimed.length, 0);
});

test('una baja nunca recibe seguimiento aunque haya sido preseleccionada', async () => {
  const candidate = {
    id: 12, organization_id: 1, phone_number: '56933333333', contact_name: 'Cata',
    pipeline_state: 'collecting_order', agent_mode: 'ai',
    order_draft: JSON.stringify({ items: [{ product_name: 'XL', quantity: 1 }] }),
    sales_started_at: atChile('2026-10-14T12:40:00'), same_day_hold_until: atChile('2026-10-14T13:00:00'),
  };
  const { service, calls } = harness({ candidate, optedOut: true });
  const result = await service.runHotClosingFollowUp(null, atChile('2026-10-14T12:45:00'));
  assert.equal(result.sent, 0);
  assert.equal(calls.claimed.length, 0);
  assert.equal(calls.sent.length, 0);
});
