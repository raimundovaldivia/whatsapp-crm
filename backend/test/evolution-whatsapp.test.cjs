const test = require('node:test');
const assert = require('node:assert/strict');
const evolution = require('../src/services/evolution-whatsapp');

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
