const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture({ storageConfigured = true } = {}) {
  const saved = [];
  const sent = [];
  const db = {
    saveMessage: async value => { saved.push(value); return { id: 8, ...value }; },
    updateConversationLastMessage: async () => {},
  };
  const r2 = {
    isConfigured: () => storageConfigured,
    uploadBuffer: async (_buffer, fileName) => `https://files.example.test/chat/${encodeURIComponent(fileName)}`,
  };
  const provider = {
    sendMediaMessage: async (phone, media) => {
      sent.push({ phone, media });
      return { messages: [{ id: 'wamid.media' }], uploadedMediaId: media.mediaUrl ? null : 'meta-media-42' };
    },
    messageId: result => result.messages[0].id,
  };
  const mediaCache = { set: () => {} };
  const service = load('src/services/outbound-media.js', {
    '../db/database': db,
    './r2-storage': r2,
    './media-cache': mediaCache,
    './whatsapp-provider': provider,
  });
  return { service, saved, sent };
}

test('valida tipo, tamaño y nombre antes de aceptar un adjunto', () => {
  const { service } = fixture();
  const photo = service.decodePayload({ data: `data:image/jpeg;base64,${Buffer.from('foto').toString('base64')}`, mimeType: 'image/jpeg', fileName: '../foto.jpg' });
  assert.equal(photo.type, 'image');
  assert.equal(photo.fileName, 'foto.jpg');
  assert.throws(() => service.decodePayload({ data: Buffer.from('x').toString('base64'), mimeType: 'application/x-msdownload', fileName: 'malware.exe' }), /Formato no permitido/);
  assert.throws(() => service.decodePayload({ data: Buffer.alloc(service.MAX_MEDIA_BYTES + 1).toString('base64'), mimeType: 'application/pdf', fileName: 'grande.pdf' }), /6 MB/);
});

test('usa la carga directa de WhatsApp cuando no hay almacenamiento público', async () => {
  const { service, saved, sent } = fixture({ storageConfigured: false });
  await service.send({
    orgId: 3,
    conversation: { id: 42, phone_number: '56933334444' },
    config: { provider: 'kapso' },
    payload: { data: Buffer.from('foto').toString('base64'), mimeType: 'image/jpeg', fileName: 'entrega.jpg' },
  });
  assert.equal(sent[0].media.mediaUrl, null);
  assert.ok(Buffer.isBuffer(sent[0].media.buffer));
  assert.equal(saved[0].mediaId, 'meta-media-42');
});

test('envía el archivo por el número oficial y lo registra en la conversación', async () => {
  const { service, saved, sent } = fixture();
  const result = await service.send({
    orgId: 3,
    conversation: { id: 41, phone_number: '56911112222' },
    config: { provider: 'kapso' },
    payload: { data: Buffer.from('pdf').toString('base64'), mimeType: 'application/pdf', fileName: 'guia.pdf', caption: 'Tu guía de despacho' },
    agentType: 'driver:Pedro',
  });
  assert.equal(sent[0].phone, '56911112222');
  assert.equal(sent[0].media.type, 'document');
  assert.equal(sent[0].media.fileName, 'guia.pdf');
  assert.equal(saved[0].type, 'document');
  assert.equal(saved[0].agentType, 'driver:Pedro');
  assert.equal(saved[0].mediaId, 'https://files.example.test/chat/guia.pdf');
  assert.equal(result.message.whatsappMessageId, 'wamid.media');
});
