const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');
const evolution = require('../src/services/evolution-whatsapp');
const config = { id: 9, provider: 'evolution', evolution_api_url: 'https://evolution.example', evolution_api_key: 'test-key', evolution_instance: 'ventas' };
const event = message => ({ event: 'MESSAGES_UPSERT', data: { key: { id: 'MEDIA1', remoteJid: '56911112222@s.whatsapp.net', fromMe: false }, message } });

test('Evolution accepts captionless images, voice notes, image documents and wrapped messages', () => {
  for (const type of ['image', 'audio', 'document']) {
    const parsed = evolution.parseWebhookMessage(event({ ephemeralMessage: { message: { [`${type}Message`]: { mimetype: type === 'audio' ? 'audio/ogg; codecs=opus' : 'image/jpeg' } } } }));
    assert.equal(parsed.type, type);
    assert.equal(parsed.text, '');
    assert.equal(parsed.mediaMessage.key.id, 'MEDIA1');
    assert.ok(parsed.mediaMessage.message[`${type}Message`]);
  }
  assert.equal(evolution.parseWebhookMessage(event({ imageMessage: { caption: 'Esta caja llegó rota' } })).text, 'Esta caja llegó rota');
  const own = event({ audioMessage: {} }); own.data.key.fromMe = true;
  assert.equal(evolution.parseWebhookMessage(own), null);
});

test('media downloads use the configured Evolution endpoint, never untrusted media URLs; limits and tenant ownership apply', async () => {
  const requests = [];
  let mime = 'audio/ogg; codecs=opus', body = Buffer.from('audio bytes').toString('base64');
  const service = load('src/services/evolution-whatsapp.js', {
    axios: { create: opts => ({ post: async (url, payload, limits) => {
      requests.push({ opts, url, payload, limits }); return { data: { base64: body, mimetype: mime } };
    } }) },
    '../db/database': { getWhatsappChannel: async (org, id) => org === 1 && id === 9 ? config : null },
  });
  const parsed = evolution.parseWebhookMessage(event({ audioMessage: { url: 'http://127.0.0.1/private', mimetype: 'audio/ogg' } }));
  const media = await service.downloadMessageMedia(parsed, config);
  assert.equal(media.data.toString(), 'audio bytes');
  assert.equal(media.contentType, 'audio/ogg');
  assert.equal(requests[0].url, '/chat/getBase64FromMediaMessage/ventas');
  assert.equal(requests[0].limits.maxRedirects, 0);
  assert.equal(requests[0].opts.baseURL, 'https://evolution.example');
  const ref = service.mediaReference(9, 'MEDIA1');
  await assert.rejects(service.downloadMediaReference(2, ref), /Canal no disponible/);
  await service.downloadMediaReference(1, ref);
  assert.equal(requests.at(-1).payload.message.key.id, 'MEDIA1');
  mime = 'text/html';
  await assert.rejects(service.downloadMessageMedia(parsed, config), /no compatible/);
  mime = 'image/jpeg'; body = 'A'.repeat(15 * 1024 * 1024);
  await assert.rejects(service.downloadMessageMedia(parsed, config), /10 MB/);
});

function inboundHarness({ mode = 'ai', permitted = true, duplicate = false, scheduleResponse = null } = {}) {
  const saved = [], sent = [], pipelineCalls = [], queries = [];
  const conv = { id: 5, agent_mode: mode, agent_mode_changed_at: new Date().toISOString() };
  const service = load('src/services/inbound-text.js', {
    '../db/database': {
      upsertConversation: async (...args) => { assert.equal(args[3], 9); return conv; },
      getConversationById: async () => conv,
      getLastMessages: async () => saved,
      saveMessage: async message => { saved.push(message); return duplicate ? null : { ...message, id: saved.length }; },
      updateConversationLastMessage: async () => {}, updateLastInbound: async () => {},
      getPool: () => ({ query: async (...args) => { queries.push(args); } }),
    },
    './conversation-mode': { resumeDivaOnInbound: async () => false },
    './notifications': { notifyAdminHumanPendingReply: async () => {} },
    './commercial': { permitted: async () => permitted },
    './pipeline': { processMessage: async (...args) => { pipelineCalls.push(args); return { response: 'Anotado', agentType: 'orders' }; } },
    './whatsapp-provider': { sendTextMessage: async (...args) => { sent.push(args); return { messageId: 'OUT1' }; }, messageId: result => result.messageId },
  });
  const invoke = prepareMedia => service.processInboundText({ org: { id: 1 }, whatsappConfig: config, whatsappChannelId: 9,
    parsed: { from: '56911112222', messageId: 'MEDIA1', type: 'audio', text: '🎤 [Audio]', mediaId: evolution.mediaReference(9, 'MEDIA1') }, prepareMedia, scheduleResponse });
  return { saved, sent, pipelineCalls, queries, invoke };
}

test('voice transcript reaches the sales pipeline and history; reply stays on its Evolution channel', async () => {
  const h = inboundHarness();
  await h.invoke(async () => ({ text: '🎤 Quiero dos cajas para mañana' }));
  assert.equal(h.saved[0].type, 'audio');
  assert.ok(h.saved[0].mediaId.startsWith('evolution:9:'));
  assert.equal(h.pipelineCalls[0][2], '🎤 Quiero dos cajas para mañana');
  assert.equal(h.queries[0][1][2], 1);
  assert.equal(h.sent[0][2], config);
  assert.equal(h.saved[1].whatsappMessageId, 'OUT1');
});

test('duplicate, human-controlled and unsubscribed audio messages do not invoke AI or send replies', async () => {
  for (const options of [{ mode: 'human' }, { mode: 'coordinating' }, { permitted: false }, { duplicate: true }]) {
    const h = inboundHarness(options);
    await h.invoke(() => { throw new Error('Should not transcribe'); });
    assert.equal(h.pipelineCalls.length, 0);
    assert.equal(h.sent.length, 0);
  }
});

test('failed transcription gives an honest fallback without inventing audio content', async () => {
  const h = inboundHarness();
  await h.invoke(async () => ({ fallback: 'No pude transcribirlo. ¿Puedes escribirlo?' }));
  assert.equal(h.pipelineCalls.length, 0);
  assert.match(h.sent[0][1], /No pude transcribirlo/);
});

test('Evolution routes every attachment in a batch to the shared image/audio processors', async () => {
  const images = [], audio = [];
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': { getOrgById: async () => ({ id: 1 }), getWhatsappChannel: async () => config },
    '../services/evolution-whatsapp': { ...evolution, markAsRead: async () => {} },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
    './kapso-webhook': { handlePaymentProof: async (...args) => images.push(args), transcribeAudio: async () => 'Necesito huevos' },
    '../services/inbound-text': { processInboundText: async args => audio.push(await args.prepareMedia()) },
  }, { process: { env: { OPENAI_API_KEY: 'fake-test-key' } } });
  await handler(router, 'post', '/1/9/token')({ params: { orgId: '1', channelId: '9' },
    body: { event: 'MESSAGES_UPSERT', data: [event({ imageMessage: {} }).data, event({ audioMessage: {} }).data] } }, response());
  assert.equal(images.length, 1);
  assert.equal(images[0][3].channelId, 9);
  assert.equal(audio[0].text, '🎤 Necesito huevos');
});

test('image interpretation shares payment classification, keeps captions, persists context and skips duplicate responses', async () => {
  const sent = [], processed = [], stored = [], updates = [];
  let duplicate = false;
  const db = {
    upsertConversation: async (_org, _from, _name, channel) => { assert.equal(channel, 9); return { id: 5, agent_mode: 'ai' }; },
    touchLead: async () => {}, saveMessage: async msg => { stored.push(msg); return duplicate ? null : { ...msg, id: stored.length }; },
    updateConversationLastMessage: async () => {}, updateLastInbound: async () => {}, getConversationById: async () => ({ id: 5 }),
    getPool: () => ({ query: async (...args) => updates.push(args) }),
  };
  const kapso = load('src/routes/kapso-webhook.js', {
    '../db/database': db,
    '../middleware/webhook-auth': { verifyWebhook: () => noop },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
    '../services/commercial': { permitted: async () => true },
    '../services/analyzePaymentProof': { analyzePaymentProof: async () => ({ is_payment_proof: false }) },
    '../services/media-cache': { set() {} },
    '@anthropic-ai/sdk': class { constructor() { this.messages = { create: async () => ({ content: [{ text: 'Una caja de huevos rotos' }] }) }; } },
    '../services/pipeline': { processMessage: async (...args) => { processed.push(args); return { response: 'Revisemos la entrega' }; } },
    '../services/bot-logger': { createBotLogger: () => ({ in() {} }) },
    '../services/whatsapp-provider': { messageId: r => r?.messageId },
  });
  const service = { markAsRead: async () => {}, getMediaUrl: async () => ({ url: 'media' }),
    downloadMedia: async () => ({ data: Buffer.from('image'), contentType: 'image/jpeg' }),
    sendTextMessage: async (...args) => { sent.push(args); return { messageId: 'OUT1' }; } };
  const parsed = { from: '56911112222', messageId: 'IMAGE1', mediaId: evolution.mediaReference(9, 'IMAGE1'), text: 'Llegaron así' };
  await kapso.handlePaymentProof({ id: 1 }, config, parsed, { service, channelId: 9 });
  assert.match(processed[0][2], /huevos rotos/);
  assert.match(processed[0][2], /Llegaron así/);
  assert.equal(sent[0][2], config);
  assert.equal(stored[1].whatsappMessageId, 'OUT1');
  assert.match(updates[0][1][0], /huevos rotos/);
  duplicate = true;
  await kapso.handlePaymentProof({ id: 1 }, config, parsed, { service, channelId: 9 });
  assert.equal(sent.length, 1);
});

test('shared transcription uploads downloaded audio and returns its transcript', async () => {
  let request;
  const kapso = load('src/routes/kapso-webhook.js', {
    '../middleware/webhook-auth': { verifyWebhook: () => noop },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
  }, {
    FormData, Blob, AbortSignal,
    fetch: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ text: '  dos cajas por favor  ' }) }; },
    process: { env: { OPENAI_API_KEY: 'fake-test-key' } },
  });
  const text = await kapso.transcribeAudio({ mediaId: 'evolution:9:MEDIA' }, config, {
    getMediaUrl: async () => ({ url: 'media' }),
    downloadMedia: async () => ({ data: Buffer.from('fake wav'), contentType: 'audio/wav' }),
  });
  assert.equal(text, 'dos cajas por favor');
  assert.equal(request.options.body.get('file').name, 'audio.wav');
  assert.equal(request.options.body.get('language'), 'es');
  assert.equal(request.options.body.get('model'), 'whisper-1');
});

test('payment proof viewer retrieves Evolution media from its channel after cache expiry', async () => {
  const calls = [];
  const media = load('src/services/payment-proof-media.js', {
    './media-cache': { get: () => null, set() {} },
    './evolution-whatsapp': { downloadMediaReference: async (...args) => { calls.push(args); return { data: Buffer.from('proof'), contentType: 'image/png' }; } },
    './kapso-whatsapp': { getMediaUrl: () => { throw new Error('Wrong provider'); } },
  });
  const ref = evolution.mediaReference(9, 'PROOF1');
  assert.equal((await media.getPaymentProofMedia(1, ref, {})).data.toString(), 'proof');
  assert.deepEqual(calls, [[1, ref]]);
});

test('payment proof image route works without Kapso and rejects another organization before fetching media', async () => {
  let downloads = 0;
  const router = load('src/routes/payment-proofs.js', {
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': {
      getPaymentProofs: async org => org === 1 ? [{ id: 7, media_id: evolution.mediaReference(9, 'PROOF1') }] : [],
      getWhatsappConfig: async () => null,
    },
    '../services/payment-proof-media': { getPaymentProofMedia: async () => { downloads++; return { data: Buffer.from('proof'), contentType: 'image/png' }; } },
  });
  const get = handler(router, 'get', '/7/image');
  const res = response(); res.setHeader = () => {};
  await get({ orgId: 1, params: { id: '7' } }, res);
  assert.equal(res.body.toString(), 'proof');
  const foreign = response();
  await get({ orgId: 2, params: { id: '7' } }, foreign);
  assert.equal(foreign.code, 404);
  assert.equal(downloads, 1);
});


test('Evolution stores every text before producing one combined reply', async () => {
  let reply;
  const h = inboundHarness({scheduleResponse:fn=>{reply=fn;}});
  await h.invoke(null);
  await h.invoke(null);
  assert.equal(h.pipelineCalls.length,0);
  assert.equal(h.saved.length,2);
  await reply();
  assert.equal(h.pipelineCalls.length,1);
  assert.equal(h.pipelineCalls[0][2],'🎤 [Audio]\n🎤 [Audio]');
  assert.equal(h.sent.length,1);
});
