const test = require('node:test');
const assert = require('node:assert/strict');
const evolution = require('../src/services/evolution-whatsapp');
const { load, handler, response } = require('./helpers.cjs');

test('parsea un mensaje entrante de Evolution y conserva el JID para marcar leído', () => {
  const parsed = evolution.parseWebhookMessage({
    event: 'messages.upsert',
    data: {
      key: { id: 'ABC123', remoteJid: '56911112222@s.whatsapp.net', fromMe: false },
      pushName: 'María',
      messageTimestamp: 123456,
      message: { extendedTextMessage: { text: 'Quiero comprar dos unidades' } },
    },
  });
  assert.deepEqual(parsed, {
    messageId: 'ABC123',
    from: '56911112222',
    remoteJid: '56911112222@s.whatsapp.net',
    contactName: 'María',
    timestamp: 123456,
    type: 'text',
    text: 'Quiero comprar dos unidades',
  });
});

test('ignora mensajes propios y grupos', () => {
  assert.equal(evolution.parseWebhookMessage({
    event: 'MESSAGES_UPSERT',
    data: { key: { id: '1', remoteJid: '56911112222@s.whatsapp.net', fromMe: true }, message: { conversation: 'hola' } },
  }), null);
  assert.equal(evolution.parseWebhookMessage({
    event: 'MESSAGES_UPSERT',
    data: { key: { id: '2', remoteJid: '123@g.us', fromMe: false }, message: { conversation: 'hola' } },
  }), null);
});

test('normaliza estados de entrega de Evolution', () => {
  assert.deepEqual(evolution.parseStatusUpdate({
    event: 'MESSAGES_UPDATE',
    data: { key: { id: 'MSG1' }, status: 'DELIVERY_ACK' },
  }), { messageId: 'MSG1', status: 'delivered', error: null });
});

test('normaliza la conexión de Evolution y recupera el número vinculado', () => {
  assert.deepEqual(evolution.parseConnectionUpdate({
    event: 'CONNECTION_UPDATE',
    data: { state: 'open', wuid: '56954565558:12@s.whatsapp.net' },
  }), { status: 'connected', phoneNumber: '56954565558' });
  assert.deepEqual(evolution.parseConnectionUpdate({
    event: 'connection.update',
    data: { instance: { state: 'close' } },
  }), { status: 'disconnected', phoneNumber: null });
  assert.equal(evolution.parseConnectionUpdate({ event: 'MESSAGES_UPSERT', data: {} }), null);
});

test('el webhook de conexión actualiza el canal sin iniciar el pipeline de mensajes', async () => {
  const updates = [];
  let inboundCalls = 0;
  const channel = { id: 9, provider: 'evolution', webhook_token: 'token' };
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': {
      getWhatsappChannel: async () => channel,
      getOrgById: async () => ({ id: 1, name: 'Prueba' }),
      updateWhatsappChannelStatus: async (...args) => { updates.push(args); return { ...channel, status: args[2], phone_number: args[3] }; },
    },
    '../services/evolution-whatsapp': evolution,
    '../services/inbound-text': { processInboundText: async () => { inboundCalls++; } },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
  });
  const res = response();
  await handler(router, 'post', '/1/9/token')({
    params: { orgId: '1', channelId: '9', token: 'token' },
    body: { event: 'CONNECTION_UPDATE', data: { state: 'open', wuid: '56954565558@s.whatsapp.net' } },
  }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(updates, [[1, 9, 'connected', '56954565558']]);
  assert.equal(inboundCalls, 0);
});
