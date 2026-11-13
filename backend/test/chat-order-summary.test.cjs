const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

const conversation = { id: 8, phone_number: '56900000000', whatsapp_channel_id: 4, contact_name: 'Cliente de prueba' };
const channel = { id: 4, provider: 'evolution' };
const item = { productId: 2, title: 'Bandeja', price: 3000, quantity: 2 };
const order = { id: 42 };

function setup(t, { queued = null, send = () => ({ key: { id: 'wa42' } }), save = message => message } = {}) {
  const create = t.mock.fn(async () => order);
  const defer = t.mock.fn(async () => queued);
  const transport = t.mock.fn(send);
  const saveMessage = t.mock.fn(save);
  const emit = t.mock.fn();
  const io = { to: room => { assert.equal(room, 'org_3'); return { emit }; } };
  const router = load('src/routes/conversations.js', {
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': {
      getPool: () => ({}),
      getConversationById: async () => conversation, getContact: async () => null,
      getWhatsappChannel: async (orgId, channelId) => {
        assert.deepEqual([orgId, channelId], [3, channel.id]);
        return channel;
      },
      createOrder: create, saveMessage, updateConversationLastMessage: async () => {},
    },
    '../services/outbound-message-queue': { deferOutsideHours: defer },
    '../services/whatsapp-provider': load('src/services/whatsapp-provider.js', {
      './evolution-whatsapp': { sendTextMessage: transport },
    }),
  });
  router.setSocketIO(io);
  async function submit(body = {}) {
    const res = response();
    await handler(router, 'post', '/8/orders')({
      orgId: 3, userId: 6, params: { id: '8' }, body: { items: [item], ...body },
    }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order, order);
    assert.equal(create.mock.callCount(), 1);
    return res.body;
  }
  return { submit, defer, transport, saveMessage, emit, io };
}

test('pedido del chat: envía un resumen por el WhatsApp del chat y publica el mensaje confirmado', async t => {
  const { submit, defer, transport, saveMessage, emit, io } = setup(t);
  const result = await submit();
  assert.equal(result.summaryWarning, undefined);
  assert.equal(defer.mock.calls[0].arguments[0].io, io);
  assert.equal(transport.mock.callCount(), 1);
  const [phone, text, config] = transport.mock.calls[0].arguments;
  assert.equal(phone, conversation.phone_number);
  assert.equal(config, channel);
  assert.match(text, /Pedido #DR-42/);
  assert.match(text, /Bandeja x2/);
  assert.match(text, /Total: \$6\.000/);
  const message = saveMessage.mock.calls[0].arguments[0];
  assert.equal(message.content, text);
  assert.equal(message.whatsappMessageId, 'wa42');
  assert.equal(emit.mock.calls[0].arguments[0], 'new_message_3');
  assert.equal(emit.mock.calls[0].arguments[1].message, message);
});

test('pedido fuera de horario: programa un solo resumen para el canal del chat', async t => {
  const { submit, defer, transport, saveMessage, io } = setup(t, { queued: { id: 14 } });
  assert.equal((await submit()).queued, true);
  assert.equal(defer.mock.callCount(), 1);
  const input = defer.mock.calls[0].arguments[0];
  assert.equal(input.io, io);
  assert.equal(input.sendingProvider, channel.provider);
  assert.equal(input.createdBy, 6);
  assert.equal(input.conversationId, conversation.id);
  assert.match(input.text, /Pedido #DR-42/);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(saveMessage.mock.callCount(), 0);
});

test('pedido sin resumen: omite la cola y el envío', async t => {
  const { submit, defer, transport } = setup(t);
  await submit({ sendSummary: false });
  assert.equal(defer.mock.callCount(), 0);
  assert.equal(transport.mock.callCount(), 0);
});

test('WhatsApp rechaza el resumen: confirma el pedido y avisa sin registrar un envío exitoso', async t => {
  const { submit, saveMessage } = setup(t, { send() { throw Object.assign(new Error(), { is24hWindow: true }); } });
  assert.match((await submit()).summaryWarning, /ventana de WhatsApp/);
  assert.equal(saveMessage.mock.callCount(), 0);
});

test('WhatsApp sin identificador: confirma el pedido y avisa que el envío es incierto', async t => {
  const { submit, saveMessage } = setup(t, { send: () => ({}) });
  assert.match((await submit()).summaryWarning, /confirmar el envío/);
  assert.equal(saveMessage.mock.callCount(), 0);
});

test('si falla el registro después del envío, indica que WhatsApp ya aceptó el resumen', async t => {
  const { submit, transport } = setup(t, { save() { throw new Error('sin conexión'); } });
  assert.match((await submit()).summaryWarning, /WhatsApp aceptó el resumen/);
  assert.equal(transport.mock.callCount(), 1);
});
