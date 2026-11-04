const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');
const config = { provider: 'meta', phone_number_id: '12345678', business_account_id: '98765432', access_token: 'fake-meta-test' };
const payload = message => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
  metadata: { phone_number_id: config.phone_number_id }, messages: [{ id: 'wamid.test', from: '56911112222', ...message }],
} }] }] });
const graph = { GRAPH_URL: 'https://graph.facebook.com/v26.0' };

test('Meta parses media, interactive replies and valid locations; rejects invalid senders and coordinates', () => {
  const wa = load('src/services/whatsapp.js');
  for (const type of ['image', 'document', 'audio', 'video']) {
    const parsed = wa.parseWebhookMessage(payload({ type, [type]: { id: '12345', link: 'https://untrusted.invalid/file' } }));
    assert.equal(parsed.type, type); assert.equal(parsed.mediaId, '12345'); assert.equal(parsed.mediaUrl, null);
  }
  assert.equal(wa.parseWebhookMessage(payload({ type: 'interactive', interactive: { button_reply: { id: 'ok', title: 'Confirmo' } } })).text, 'Confirmo');
  assert.equal(wa.parseWebhookMessage(payload({ type: 'button', button: { text: 'Sí' } })).text, 'Sí');
  assert.equal(wa.parseWebhookMessage(payload({ type: 'location', location: { latitude: -29.9, longitude: -71.2 } })).location.lat, -29.9);
  for (const bad of [{ type: 'reaction' }, { type: 'text', from: '../private' }, { type: 'location', location: { latitude: 91, longitude: 0 } }]) {
    assert.equal(wa.parseWebhookMessage(payload(bad)), null);
  }
});

test('Meta sends text and templates directly, lists approved templates and scopes media lookup to the number', async () => {
  const calls = [];
  const wa = load('src/services/whatsapp.js', {
    './meta-platform': graph,
    axios: {
      post: async (...args) => { calls.push(args); return { data: { messages: [{ id: 'out' }] } }; },
      get: async (...args) => { calls.push(args); return { data: { data: [{ name: 'ok', status: 'APPROVED' }, { name: 'pending', status: 'PENDING' }] } }; },
    },
  });
  await wa.sendTextMessage('56911112222', 'Hola', config);
  await wa.sendTemplate('56911112222', 'order', 'es', [], config);
  assert.equal((await wa.getTemplates(config)).length, 1);
  await wa.getMediaUrl('12345', config);
  assert.equal(calls[0][0], `${graph.GRAPH_URL}/${config.phone_number_id}/messages`);
  assert.equal(calls[0][1].messaging_account_id, config.business_account_id);
  assert.equal(calls[1][1].type, 'template');
  assert.equal(calls[1][1].messaging_account_id, config.business_account_id);
  assert.equal(calls[3][1].params.phone_number_id, config.phone_number_id);
  for (const call of calls) {
    const options = call.at(-1);
    assert.equal(options.headers.Authorization, 'Bearer fake-meta-test');
    assert.equal(options.headers['X-API-Key'], undefined); assert.ok(options.timeout);
  }
  await assert.rejects(wa.getMediaUrl('../me', config), /inválido/);
});

test('Meta scopes media sends to the configured messaging account and preserves legacy configurations', async () => {
  const calls = [];
  const wa = load('src/services/whatsapp.js', { './meta-platform': graph, axios: {
    post: async (...args) => { calls.push(args); return { data: { messages: [{ id: 'out' }] } }; },
  } });
  await wa.sendMediaMessage('56911112222', { type: 'image', mediaUrl: 'https://example.com/photo.jpg' }, config);
  await wa.sendTextMessage('56911112222', 'Otra tienda', { ...config, business_account_id: '87654321' });
  await wa.sendTextMessage('56911112222', 'Anterior', { ...config, business_account_id: null });
  assert.equal(calls[0][1].messaging_account_id, config.business_account_id);
  assert.equal(calls[1][1].messaging_account_id, '87654321');
  assert.equal(Object.hasOwn(calls[2][1], 'messaging_account_id'), false);
  await assert.rejects(wa.sendTextMessage('56911112222', 'Inválido', { ...config, business_account_id: '../me' }), /inválida/);
  assert.equal(calls.length, 3);
});

test('Meta preserves the expired-window signal so collection can use an approved template', async () => {
  const wa = load('src/services/whatsapp.js', { './meta-platform': graph, axios: { post: async () => { throw { response: { data: { error: { code: 131047 } } } }; } } });
  await assert.rejects(wa.sendTextMessage('56911112222', 'Hola', config), error => error.is24hWindow === true);
});

test('legacy callers route through Meta without a Kapso key or request', async () => {
  const calls = [];
  const direct = Object.fromEntries(['sendTextMessage', 'sendMediaMessage', 'markAsRead', 'getTemplates', 'sendTemplate', 'getMediaUrl', 'createTemplate'].map(name => [name, async (...args) => calls.push([name, ...args])]));
  const legacy = load('src/services/kapso-whatsapp.js', { './whatsapp': direct, axios: { post: () => assert.fail('Kapso must not be called'), get: () => assert.fail('Kapso must not be called') } });
  await legacy.sendTextMessage('56911112222', 'Hola', config);
  await legacy.sendTemplate('56911112222', 'order', 'es', [], config);
  await legacy.getTemplates(config); await legacy.getMediaUrl('12345', config);
  assert.deepEqual(calls.map(c => c[0]), ['sendTextMessage', 'sendTemplate', 'getTemplates', 'getMediaUrl']);
});

test('Meta media credentials are stripped on redirects and lookalike hosts, and private addresses are rejected', async () => {
  const calls = []; let privateAddress = false;
  const media = load('src/services/safe-media.js', {
    'node:dns': { promises: { lookup: async () => [{ address: privateAddress ? '127.0.0.1' : '8.8.8.8', family: 4 }] } },
    axios: { get: async (url, opts) => {
      calls.push({ url, opts });
      return url.includes('/redirect') ? { status: 302, headers: { location: 'https://public.invalid/file' } }
        : { status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.from('fake-image') };
    } },
  });
  await media.downloadMedia('https://lookaside.fbsbx.com/redirect', config);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer fake-meta-test');
  assert.equal(calls[1].opts.headers.Authorization, undefined);
  await media.downloadMedia('https://lookaside.fbsbx.com.evil.invalid/file', config);
  assert.equal(calls[2].opts.headers.Authorization, undefined);
  privateAddress = true;
  await assert.rejects(media.downloadMedia('https://lookaside.fbsbx.com/file', config), /no público/);
  assert.equal(calls.length, 3);
});

test('activation validates ownership, same number and subscription before replacing Kapso', async () => {
  for (const scenario of ['ok', 'invalid', 'different-number', 'other-org', 'wrong-account', 'bad-token', 'subscription-failed', 'no-secret', 'webhook-missing', 'wrong-callback']) {
    const writes = [], subscriptions = [];
    const connection = load('src/services/meta-whatsapp-connection.js', {
      '../db/database': {
        getWhatsappConfig: async () => ({ provider: 'kapso', phone_number_id: '12345678' }),
        getOrgByPhoneNumberId: async () => ({ org: { id: scenario === 'other-org' ? 2 : 1 } }),
        upsertWhatsappConfig: async (...args) => writes.push(args),
      },
      './meta-platform': {
        graphGet: async path => {
          if (path.endsWith('/subscriptions')) return { data: scenario === 'webhook-missing' ? [] : [{ object: 'whatsapp_business_account', active: true, callback_url: scenario === 'wrong-callback' ? 'https://other.invalid/webhook' : 'https://crm.invalid/webhook', fields: [{ name: 'messages' }] }] };
          if (scenario === 'bad-token') throw new Error('Token inválido');
          return { data: scenario === 'wrong-account' ? [] : [{ id: '12345678', display_phone_number: '+56 9 1111 2222' }] };
        },
        graphPost: async (...args) => { subscriptions.push(args); return { success: scenario !== 'subscription-failed' }; },
      },
    }, { process: { env: { META_APP_ID: '12345', CRM_PUBLIC_URL: 'https://crm.invalid', META_APP_SECRET: scenario === 'no-secret' ? '' : 'fake-app-secret' } } });
    const input = { phoneNumberId: scenario === 'invalid' ? '../me' : scenario === 'different-number' ? '11111111' : '12345678', businessAccountId: '98765432', accessToken: 'fake-test', webhookVerifyToken: 'fake-verify' };
    if (scenario === 'ok') {
      await connection.activate(1, input);
      assert.equal(writes.length, 1); assert.equal(writes[0][0], 1); assert.equal(writes[0][1].phoneNumberId, '12345678');
      assert.equal(writes[0][1].provider, 'meta'); assert.equal(subscriptions.length, 1);
    } else {
      await assert.rejects(connection.activate(1, input)); assert.equal(writes.length, 0, scenario);
      if (scenario !== 'subscription-failed') assert.equal(subscriptions.length, 0, scenario);
    }
  }
});

test('Meta debounce groups consecutive input while receipts stay immediate', () => {
  const inbox = load('src/services/webhook-inbox.js');
  assert.equal(inbox.streamInfo('meta', payload({ type: 'text', text: { body: 'Hola' } }), '').delay, 12);
  assert.equal(inbox.streamInfo('meta', payload({ type: 'text', text: { body: 'Sí, correcto' } }), '').delay, 8);
  assert.equal(inbox.streamInfo('meta', { entry: [{ changes: [{ value: { statuses: [{ recipient_id: '56911112222' }] } }] }] }, '').delay, 0);
});

test('shared inbound handler keeps provider ownership and deduplicates Meta text before replying', async () => {
  let currentProvider = 'meta', saves = 0, replies = 0;
  const route = load('src/routes/kapso-webhook.js', {
    '../middleware/webhook-auth': { verifyWebhook: () => noop }, '../services/webhook-inbox': { durableWebhook: (_p, fn) => fn },
    '../db/database': {
      getOrgByPhoneNumberId: async () => ({ org: { id: 1 }, whatsappConfig: { ...config, provider: currentProvider } }),
      getSetting: async () => null, touchUserWaWindow: async () => {}, getUserByWhatsappPhone: async () => null,
      upsertConversation: async (org) => { assert.equal(org, 1); return { id: 10 }; }, touchLead: async () => {},
      saveMessage: async () => { saves++; return null; },
    },
  });
  const wa = load('src/services/whatsapp.js');
  const transport = { ...wa, sendTextMessage: async () => { replies++; } };
  await route.handleOfficialWebhook({ body: payload({ type: 'text', text: { body: 'Sí' } }), headers: {} }, response(), 'meta', transport);
  assert.equal(saves, 1); assert.equal(replies, 0);
  currentProvider = 'kapso';
  await route.handleOfficialWebhook({ body: payload({ type: 'text', text: { body: 'Sí' } }), headers: {} }, response(), 'meta', transport);
  assert.equal(saves, 1);
  currentProvider = 'meta';
  await route.handleOfficialWebhook({ body: { phone_number_id: config.phone_number_id, message: { type: 'text', text: { body: 'Sí' } } }, headers: { 'x-webhook-event': 'whatsapp.message.received' } }, response(), 'kapso', {
    ...transport, parseWebhookMessage: body => wa.parseWebhookMessage(payload(body.message)),
  });
  assert.equal(saves, 2, 'a signed Kapso job queued before cutover is still processed');
});

test('Meta audio is transcribed, stored with its media and respects human control; images are preserved without AI', async () => {
  for (const type of ['audio', 'image']) {
    const saved = [], blobs = [], cache = new Map(); let transcripts = 0;
    const conversation = { id: 7, agent_mode: 'human' };
    const route = load('src/routes/kapso-webhook.js', {
      '../middleware/webhook-auth': { verifyWebhook: () => noop }, '../services/webhook-inbox': { durableWebhook: (_p, fn) => fn },
      '../services/commercial': { permitted: async () => type === 'audio' },
      '../services/audio-transcription': { isConfigured: () => true, transcribeBuffer: async () => { transcripts++; return 'Quiero dos bandejas'; } },
      '../services/conversation-mode': { resumeDivaOnInbound: async () => false },
      '../services/notifications': { notifyAgentsNewMessage: async () => {}, notifyAdminHumanPendingReply: async () => {} },
      '../services/media-cache': { get: key => cache.get(key), set: (key, data, contentType) => cache.set(key, { data, contentType }) },
      '../db/database': {
        getOrgByPhoneNumberId: async () => ({ org: { id: 1 }, whatsappConfig: config }),
        getSetting: async () => null, touchUserWaWindow: async () => {}, getUserByWhatsappPhone: async () => null,
        upsertConversation: async org => { assert.equal(org, 1); return conversation; }, touchLead: async () => {},
        saveMessage: async data => { saved.push(data); return { ...data, id: 2 }; },
        saveMessageMediaBlob: async (...args) => blobs.push(args),
        updateLastInbound: async () => {}, updateConversationLastMessage: async () => {},
        getConversationById: async () => conversation, getLastMessages: async () => [],
      },
    });
    const wa = load('src/services/whatsapp.js');
    const transport = { ...wa, markAsRead: async () => {}, getMediaUrl: async id => {
      assert.equal(id, '12345'); return { url: 'https://lookaside.fbsbx.com/file' };
    }, downloadMedia: async (_url, wc) => { assert.equal(wc.provider, 'meta'); return { data: Buffer.from('media'), contentType: `${type}/fake` }; }, sendTextMessage: () => assert.fail('human control must not send') };
    await route.handleOfficialWebhook({ body: payload({ type, [type]: { id: '12345' } }), headers: {} }, response(), 'meta', transport);
    assert.equal(saved[0].type, type); assert.equal(saved[0].mediaId, '12345');
    assert.equal(blobs.length, 1); assert.equal(blobs[0][0], 1); assert.equal(blobs[0][1], 2);
    assert.equal(transcripts, type === 'audio' ? 1 : 0);
    if (type === 'audio') assert.match(saved[0].content, /Quiero dos bandejas/);
  }
});

test('Meta campaign sender uses the selected provider, old Kapso campaigns do not silently resume', async () => {
  const sender = load('src/services/broadcast-sender.js', {
    '../db/database': { getWhatsappConfig: async org => org === 1 ? config : null },
    './evolution-connection': { refreshedChannels: async () => [] },
  });
  assert.equal((await sender.resolveSender(1, 'meta')).provider, 'meta');
  await assert.rejects(sender.resolveSender(1, 'kapso'), /ya no está conectado/);
  await assert.rejects(sender.resolveSender(2, 'meta'));
  const methods = await sender.sendingMethods(1);
  assert.equal(methods[0].provider, 'meta'); assert.equal(methods[0].available, true);
  assert.equal(methods[0].access_token, undefined);
});

test('both manual entry points validate Meta without directly overwriting credentials', async () => {
  for (const [file, method] of [['settings', 'put'], ['setup', 'post']]) {
    let writes = 0, validations = 0;
    const router = load(`src/routes/${file}.js`, {
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../db/database': { upsertWhatsappConfig: async () => { writes++; } },
      '../services/meta-whatsapp-connection': { activate: async (org, input) => {
        assert.equal(org, 3); assert.equal(input.phoneNumberId, '12345678'); validations++;
        throw Object.assign(new Error('Webhook pendiente'), { status: 409 });
      } },
    });
    const res = response();
    await handler(router, method, '/whatsapp')({ orgId: 3, body: { provider: 'meta', phoneNumberId: '12345678', businessAccountId: '98765432', accessToken: 'fake', webhookVerifyToken: 'fake' } }, res);
    assert.equal(res.code, 409); assert.equal(validations, 1); assert.equal(writes, 0);
  }
});
