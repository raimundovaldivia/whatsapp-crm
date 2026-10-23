const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

const config = {
  id: 9, organization_id: 3, provider: 'evolution',
  evolution_api_url: 'https://evolution.example.test',
  evolution_api_key: 'test-key', evolution_instance: 'ventas',
};
const pdf = Buffer.from('%PDF-1.4\nlocal test document');
const payload = { data: pdf.toString('base64'), mimeType: 'application/pdf', fileName: 'guia.pdf', caption: 'Tu guía' };

function fixture({ storage = 'absent', reply = { key: { id: 'PDF1' } }, sendError = null, blobError = false } = {}) {
  const requests = [], saved = [], blobs = [], cache = [];
  const evolution = load('src/services/evolution-whatsapp.js', {
    axios: { create: () => ({ post: async (url, body) => {
      requests.push({ url, body });
      if (sendError) throw sendError;
      return { data: reply };
    } }) },
  });
  const provider = load('src/services/whatsapp-provider.js', { './evolution-whatsapp': evolution });
  const service = load('src/services/outbound-media.js', {
    '../db/database': {
      saveMessage: async value => { saved.push(value); return { id: 8, ...value }; },
      saveMessageMediaBlob: async (...args) => {
        blobs.push(args);
        if (blobError) throw new Error('Copia local no disponible');
      },
      updateConversationLastMessage: async () => {},
    },
    './r2-storage': {
      isConfigured: () => storage !== 'absent',
      uploadBuffer: async () => {
        if (storage === 'broken') throw new Error('Almacenamiento público no disponible');
        return 'https://files.example.test/chat/guia.pdf';
      },
    },
    './media-cache': { set: (...args) => cache.push(args) },
    './whatsapp-provider': provider,
  });
  const send = (input = payload) => service.send({
    orgId: 3, conversation: { id: 42, phone_number: '56911112222' }, config, payload: input,
  });
  return { send, requests, saved, blobs, cache, evolution };
}

test('Evolution envía y registra un PDF sin almacenamiento público con cada respuesta compatible', async () => {
  for (const reply of [{ key: { id: 'PDF1' } }, { message: { key: { id: 'PDF1' } } }, { id: 'PDF1' }]) {
    const h = fixture({ reply });
    const result = await h.send();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/message/sendMedia/ventas');
    assert.equal(h.requests[0].body.number, '56911112222');
    assert.equal(h.requests[0].body.mediatype, 'document');
    assert.equal(h.requests[0].body.mimetype, 'application/pdf');
    assert.equal(h.requests[0].body.fileName, 'guia.pdf');
    assert.equal(h.requests[0].body.caption, 'Tu guía');
    assert.equal(h.requests[0].body.media, pdf.toString('base64'));
    assert.equal(result.message.whatsappMessageId, 'PDF1');
    assert.equal(result.message.mediaId, h.evolution.mediaReference(9, 'PDF1'));
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].conversationId, 42);
    assert.equal(h.saved[0].type, 'document');
    assert.equal(h.saved[0].status, 'sent');
    assert.deepEqual(h.blobs[0].slice(0, 2), [3, 8]);
    assert.deepEqual(h.blobs[0][2], pdf);
    assert.equal(h.cache[0][0], `3:${result.message.mediaId}`);
    assert.equal(await h.evolution.isApiMessage('PDF1', config), true);
  }
});

test('Evolution usa el PDF directo tanto si la copia pública funciona como si falla', async () => {
  for (const storage of ['available', 'broken']) {
    const h = fixture({ storage });
    const result = await h.send();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.media, pdf.toString('base64'));
    assert.equal(result.message.mediaId, storage === 'available'
      ? 'https://files.example.test/chat/guia.pdf'
      : h.evolution.mediaReference(9, 'PDF1'));
    assert.equal(h.blobs.length, 1);
  }
});

test('un fallo de la copia local después de enviar no pide reenviar el PDF', async () => {
  const h = fixture({ blobError: true });
  const result = await h.send();
  assert.equal(result.message.whatsappMessageId, 'PDF1');
  assert.equal(h.requests.length, 1);
  assert.equal(h.cache.length, 1);
});

test('el rechazo de Evolution no guarda un PDF como enviado ni reintenta', async () => {
  const h = fixture({ sendError: new Error('Evolution no disponible') });
  await assert.rejects(h.send(), /Evolution no disponible/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.saved.length, 0);
  assert.equal(h.blobs.length, 0);
  assert.equal(h.cache.length, 0);
});

test('un adjunto inválido se rechaza antes de enviar a Evolution', async () => {
  const h = fixture();
  for (const input of [
    { ...payload, mimeType: 'application/x-msdownload' },
    { ...payload, data: '***' },
    { ...payload, data: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') },
  ]) await assert.rejects(h.send(input));
  assert.equal(h.requests.length, 0);
  assert.equal(h.saved.length, 0);
});

test('la ruta de adjuntos rechaza otra organización antes de resolver el canal o enviar', async () => {
  const lookups = [];
  let accessed = false;
  const router = load('src/routes/conversations.js', {
    '../db/database': { getConversationById: async (...args) => { lookups.push(args); return null; } },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/whatsapp-provider': { configForConversation: async () => { accessed = true; } },
    '../services/outbound-media': { send: async () => { accessed = true; } },
  });
  const res = response();
  await handler(router, 'post', '/42/media')({ orgId: 4, params: { id: '42' }, body: payload }, res);
  assert.equal(res.code, 404);
  assert.deepEqual(lookups, [[42, 4]]);
  assert.equal(accessed, false);
});

test('el PDF enviado se abre desde la copia persistente sin caché ni descarga externa', async () => {
  const h = fixture();
  const result = await h.send();
  const lookups = [], headers = {};
  const router = load('src/routes/conversations.js', {
    '../db/database': {
      getWhatsappConfig: async () => null,
      getPool: () => ({ query: async (sql, params) => {
        assert.match(sql, /c\.organization_id = \$1 AND m\.media_id = \$2/);
        assert.deepEqual(Array.from(params), [3, result.message.mediaId]);
        return { rows: [{ id: 8, type: 'document', content: h.saved[0].content }] };
      } }),
      getMessageMediaBlob: async (...args) => {
        lookups.push(args);
        return { data: h.blobs[0][2], content_type: h.blobs[0][3] };
      },
    },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/media-cache': { get: () => null },
    '../services/evolution-whatsapp': { downloadMediaReference: async () => assert.fail('No debe descargar el PDF') },
  });
  const res = response();
  res.set = (name, value) => { headers[name] = value; return res; };
  await handler(router, 'get', '/media/ref')({
    orgId: 3, params: { mediaRef: Buffer.from(result.message.mediaId).toString('base64url') },
  }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, pdf);
  assert.deepEqual(lookups, [[3, 8]]);
  assert.equal(headers['Content-Type'], 'application/pdf');
  assert.equal(headers['Content-Disposition'], 'inline; filename="guia.pdf"');
});
