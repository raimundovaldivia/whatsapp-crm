const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db/database');
const pipeline = require('../src/services/pipeline');
const orders = require('../src/services/agents/orders');
const socialCrm = require('../src/services/social-crm');

test('un pedido social exige un teléfono válido antes de poder confirmarse', () => {
  const base = {
    requires_customer_phone: true,
    customer_name: 'Ana Pérez',
    address: 'Los Aromos 123',
    city: 'Paine',
    items: [{ product_name: 'Huevos L', quantity: 1 }],
  };
  assert.equal(orders.hasRequiredData(base), false);
  assert.deepEqual(orders.missingFields(base), ['teléfono de contacto']);
  assert.equal(orders.hasRequiredData({ ...base, customer_phone: '123' }), false);
  assert.equal(orders.normalizeCustomerPhone('+56 9 1234 5678'), '56912345678');
  assert.equal(orders.hasRequiredData({ ...base, customer_phone: '+56 9 1234 5678' }), true);
  assert.equal(orders.hasRequiredData({ ...base, requires_customer_phone: false }), true);
});

test('el puente social guarda el chat en el CRM y usa el pipeline único de pedidos', async () => {
  const originals = {
    upsertSocialConversation: db.upsertSocialConversation,
    getPool: db.getPool,
    saveMessage: db.saveMessage,
    updateConversationLastMessage: db.updateConversationLastMessage,
    updateLastInbound: db.updateLastInbound,
    getConversationById: db.getConversationById,
    processMessage: pipeline.processMessage,
  };
  const saved = [];
  try {
    db.upsertSocialConversation = async (orgId, channel, externalId) => ({
      id: 44, organization_id: orgId, source_channel: channel,
      external_user_id: externalId, agent_mode: 'ai',
    });
    db.getPool = () => ({ query: async (sql, params) => {
      assert.match(sql, /organization_id=\$3/);
      assert.deepEqual(params, [44, 9, 7]);
      return { rows: [] };
    } });
    db.saveMessage = async message => { saved.push(message); return { id: saved.length, ...message }; };
    db.updateConversationLastMessage = async () => {};
    db.updateLastInbound = async () => {};
    db.getConversationById = async () => ({ id: 44, organization_id: 7, source_channel: 'instagram', agent_mode: 'ai' });
    pipeline.processMessage = async (orgId, conversationId, content) => {
      assert.deepEqual([orgId, conversationId, content], [7, 44, 'Quiero una bandeja']);
      return { response: '¿Me indicas tu nombre completo?', agentType: 'orders', newState: 'collecting_order' };
    };

    const thread = { id: 9, organization_id: 7, channel: 'instagram', external_user_id: 'ig-person-1', contact_name: 'Ana' };
    const inbound = await socialCrm.recordInbound({ orgId: 7, thread, event: {
      externalId: 'mid-1', content: 'Quiero una bandeja', messageType: 'text',
    } });
    const reply = await socialCrm.generateReply({ orgId: 7, conversation: inbound.conversation, content: 'Quiero una bandeja' });
    await socialCrm.recordOutbound({ orgId: 7, thread, externalMessageId: 'mid-2', content: reply.response, sentBy: 'ai', agentType: reply.agentType });

    assert.equal(saved.length, 2);
    assert.equal(saved[0].whatsappMessageId, 'social:instagram:mid-1');
    assert.equal(saved[1].whatsappMessageId, 'social:instagram:mid-2');
    assert.equal(saved[1].agentType, 'orders');
  } finally {
    Object.assign(db, {
      upsertSocialConversation: originals.upsertSocialConversation,
      getPool: originals.getPool,
      saveMessage: originals.saveMessage,
      updateConversationLastMessage: originals.updateConversationLastMessage,
      updateLastInbound: originals.updateLastInbound,
      getConversationById: originals.getConversationById,
    });
    pipeline.processMessage = originals.processMessage;
  }
});

test('el puente social rechaza enlazar un hilo de otra organización', async () => {
  await assert.rejects(
    () => socialCrm.ensureConversation(7, { id: 1, organization_id: 8, channel: 'facebook', external_user_id: 'x' }),
    /inválida/
  );
});
