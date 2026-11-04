const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, handler, response } = require('./helpers.cjs');
const { getWhatsAppApp } = require('../src/services/meta-whatsapp-app');
const env = { META_APP_ID: '11111', META_APP_SECRET: 'fake-social', META_WHATSAPP_APP_ID: '22222', META_WHATSAPP_APP_SECRET: 'fake-whatsapp', CRM_PUBLIC_URL: 'https://crm.invalid' };
const proof = (secret, token) => crypto.createHmac('sha256', secret).update(token).digest('hex');

test('WhatsApp app preserves legacy configuration and rejects partial dedicated credentials', () => {
  assert.deepEqual(getWhatsAppApp({ META_APP_ID: '11111', META_APP_SECRET: 'fake-social' }), { appId: '11111', appSecret: 'fake-social', dedicated: false });
  assert.deepEqual(getWhatsAppApp(env), { appId: '22222', appSecret: 'fake-whatsapp', dedicated: true });
  for (const partial of [{ META_WHATSAPP_APP_ID: '22222' }, { META_WHATSAPP_APP_SECRET: 'fake-whatsapp' }, { META_WHATSAPP_APP_ID: '../me', META_WHATSAPP_APP_SECRET: 'fake-whatsapp' }]) {
    assert.throws(() => getWhatsAppApp({ META_APP_ID: '11111', META_APP_SECRET: 'fake-social', ...partial }), /Completa/);
  }
});

test('Graph uses the chosen WhatsApp proof without changing later social calls', async () => {
  const calls = [];
  const meta = load('src/services/meta-platform.js', { axios: {
    get: async (...args) => { calls.push(args); return { data: {} }; },
    post: async (...args) => { calls.push(args); return { data: {} }; },
  } }, { process: { env } });
  await meta.graphGet('numbers', 'fake-wa-token', {}, { appSecret: env.META_WHATSAPP_APP_SECRET });
  await meta.graphPost('subscriptions', 'fake-wa-token', {}, { appSecret: env.META_WHATSAPP_APP_SECRET });
  await meta.graphGet('pages', 'fake-social-token');
  await meta.graphPost('feed', 'fake-social-token');
  assert.equal(calls[0][1].params.appsecret_proof, proof('fake-whatsapp', 'fake-wa-token'));
  assert.equal(calls[1][1].appsecret_proof, proof('fake-whatsapp', 'fake-wa-token'));
  assert.equal(calls[2][1].params.appsecret_proof, proof('fake-social', 'fake-social-token'));
  assert.equal(calls[3][1].appsecret_proof, proof('fake-social', 'fake-social-token'));
  await assert.rejects(meta.graphGet('numbers', 'fake-wa-token', {}, { appSecret: '' }), /Falta/);
  assert.equal(calls.length, 4);
});

test('dedicated app activation validates permanent credential, app, number, org and webhook before switching', async () => {
  for (const scenario of ['ok', 'wrong-app', 'expired', 'temporary', 'user-token', 'missing-scope', 'wrong-number', 'other-org', 'missing-phone', 'missing-webhook', 'subscription-failed']) {
    const calls = [], writes = [];
    const connection = load('src/services/meta-whatsapp-connection.js', {
      '../db/database': {
        getWhatsappConfig: async () => ({ provider: 'kapso', phone_number_id: '12345678' }),
        getOrgByPhoneNumberId: async () => ({ org: { id: scenario === 'other-org' ? 2 : 1 } }),
        upsertWhatsappConfig: async (...args) => writes.push(args),
      },
      './meta-platform': {
        graphGet: async (path, token, params, options) => {
          calls.push({ path, token, options });
          if (path === 'debug_token') return { data: {
            is_valid: scenario !== 'expired', app_id: scenario === 'wrong-app' ? '11111' : '22222',
            type: scenario === 'user-token' ? 'USER' : 'SYSTEM_USER', expires_at: scenario === 'temporary' ? 100 : 0,
            scopes: scenario === 'missing-scope' ? ['whatsapp_business_management'] : ['whatsapp_business_management', 'whatsapp_business_messaging'],
          } };
          if (path.endsWith('/subscriptions')) return { data: scenario === 'missing-webhook' ? [] : [{ object: 'whatsapp_business_account', active: true, callback_url: 'https://crm.invalid/webhook', fields: ['messages'] }] };
          return { data: scenario === 'missing-phone' ? [] : [{ id: '12345678', display_phone_number: '+56 9 1111 2222' }] };
        },
        graphPost: async (path, token, data, options) => { calls.push({ path, token, options }); return { success: scenario !== 'subscription-failed' }; },
      },
    }, { process: { env } });
    const input = { phoneNumberId: scenario === 'wrong-number' ? '87654321' : '12345678', businessAccountId: '98765432', accessToken: 'fake-wa-token', webhookVerifyToken: 'fake-verify' };
    if (scenario === 'ok') {
      await connection.activate(1, input);
      assert.equal(writes.length, 1);
      assert.equal(writes[0][0], 1);
      assert.equal(writes[0][1].provider, 'meta');
      assert.equal(writes[0][1].phoneNumberId, '12345678');
      assert.equal(calls.find(c => c.path.endsWith('/subscriptions')).path, '22222/subscriptions');
    } else {
      await assert.rejects(connection.activate(1, input), undefined, scenario);
      assert.equal(writes.length, 0, scenario);
      if (scenario !== 'subscription-failed') assert.equal(calls.some(c => c.path.endsWith('/subscribed_apps')), false, scenario);
    }
    for (const call of calls) assert.equal(call.options.appSecret, 'fake-whatsapp');
  }
});

test('WhatsApp webhook accepts only its app signature and keeps organization/provider checks', async () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: '98765432', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '12345678' }, messages: [{ id: 'wamid.fake', from: '56911112222', type: 'text', text: { body: 'Prueba' } }] } }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  for (const scenario of ['ok', 'social-secret', 'bad-body', 'wrong-provider', 'missing-org', 'partial-app']) {
    let lookups = 0, passed = false;
    const auth = load('src/middleware/webhook-auth.js', {
      '../db/database': { getOrgByPhoneNumberId: async id => {
        lookups++;
        assert.equal(id, '12345678');
        return scenario === 'missing-org' ? null : { org: { id: 1 }, whatsappConfig: { provider: scenario === 'wrong-provider' ? 'kapso' : 'meta' } };
      } },
    }, { process: { env: scenario === 'partial-app' ? { ...env, META_WHATSAPP_APP_SECRET: '' } : env } });
    const req = { body, rawBody: scenario === 'bad-body' ? Buffer.from('{}') : raw, headers: { 'x-hub-signature-256': 'sha256=' + proof(scenario === 'social-secret' ? 'fake-social' : 'fake-whatsapp', raw) } };
    const res = response();
    await auth.verifyWebhook('meta')(req, res, () => { passed = true; });
    assert.equal(passed, scenario === 'ok', scenario);
    if (scenario === 'ok') assert.equal(req.webhookDeliveries[0].orgId, 1);
    else assert.equal(res.code, scenario === 'partial-app' ? 503 : 401, scenario);
    if (['social-secret', 'bad-body', 'partial-app'].includes(scenario)) assert.equal(lookups, 0);
  }
});
