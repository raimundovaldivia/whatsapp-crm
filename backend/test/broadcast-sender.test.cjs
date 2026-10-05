const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

test('direct pacing serializes concurrent tabs, pauses each batch and survives reload', async () => {
  const pool = new PGlite();
  try {
    const setup = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/db/setup.js'), 'utf8');
    const migration = setup.match(/CREATE TABLE IF NOT EXISTS broadcast_channel_pacing[\s\S]*?\);/)[0];
    await pool.exec('CREATE TABLE organizations (id INTEGER PRIMARY KEY); INSERT INTO organizations VALUES (1),(2)');
    await pool.exec(migration);
    await pool.exec(migration);
    const deps = { '../db/database': { getPool: () => pool } };
    let sender = load('src/services/broadcast-sender.js', deps);
    const concurrent = await Promise.all([sender.claimDirectSlot(1, 3), sender.claimDirectSlot(1, 3)]);
    assert.equal(concurrent.filter(r => r.allowed).length, 1);
    assert.equal(concurrent.find(r => !r.allowed).retryAfterSeconds, 60);
    assert.equal((await sender.claimDirectSlot(2, 3)).allowed, true);
    assert.equal((await sender.claimDirectSlot(1, 4, { intervalSeconds: 12, batchSize: 1, batchPauseSeconds: 90 })).allowed, true);
    assert.equal((await sender.claimDirectSlot(1, 4)).retryAfterSeconds, 90);
    assert.throws(() => sender.pacingSettings({ batchSize: 0 }), /inválido/);
    assert.throws(() => sender.pacingSettings({ intervalSeconds: 1.5 }), /inválido/);

    for (let count = 2; count <= 10; count++) {
      await pool.exec(`UPDATE broadcast_channel_pacing SET next_send_at = NOW() - INTERVAL '1 second' WHERE organization_id=1 AND channel_id=3`);
      assert.equal((await sender.claimDirectSlot(1, 3)).allowed, true);
    }
    sender = load('src/services/broadcast-sender.js', deps);
    const pause = await sender.claimDirectSlot(1, 3);
    assert.equal(pause.allowed, false);
    assert.ok(pause.retryAfterSeconds >= 299);
    await pool.exec(`UPDATE broadcast_channel_pacing SET next_send_at = NOW() - INTERVAL '1 second' WHERE organization_id=1 AND channel_id=3`);
    assert.equal((await sender.claimDirectSlot(1, 3)).allowed, true);
    assert.equal((await pool.query('SELECT batch_count FROM broadcast_channel_pacing WHERE organization_id=1 AND channel_id=3')).rows[0].batch_count, 1);
  } finally { await pool.close(); }
});

test('sender checks tenant, provider and connection and exposes no credentials', async () => {
  const sender = load('src/services/broadcast-sender.js', { '../db/database': {
    getWhatsappConfig: async () => ({ provider: 'kapso', api_key: 'secret' }),
    getWhatsappChannel: async (org, id) => org === 1 && id === 3 ? { provider: 'evolution', status: 'disconnected' } : null,
    listWhatsappChannels: async () => [{ id: 3, provider: 'evolution', status: 'connected', evolution_api_key: 'secret' }],
  } });
  await assert.rejects(sender.resolveSender(2, 'evolution', 3), /no disponible/);
  await assert.rejects(sender.resolveSender(1, 'evolution', 3), /desconectada/);
  await assert.rejects(sender.resolveSender(1, 'other', null), /inválido/);
  assert.equal(JSON.stringify(await sender.sendingMethods(1)).includes('secret'), false);
});

test('direct route never falls back to Kapso, enforces opt-out and pauses before sending', async () => {
  let optedOut = false, allowed = false, sends = 0, channelUsed, unconfirmed = false, storageFails = false;
  const savedMessages = [];
  const router = load('src/routes/reengagement.js', {
    '@anthropic-ai/sdk': class Anthropic {},
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': {
      getPool: () => ({ query: async () => ({ rows: [] }) }),
      normalizePhone: p => p,
      getContact: async () => ({ opt_out: optedOut }),
      saveMessage: async message => { savedMessages.push(message); return { id: 90, ...message }; },
      updateConversationLastMessage: async () => {},
      getConversationById: async id => ({ id, whatsapp_channel_id: 3 }),
      upsertConversation: async (_org, _phone, _name, channel) => { channelUsed = channel; if (storageFails) throw new Error('storage unavailable'); return { id: 77 }; },
    },
    '../services/commercial': { permitted: async () => true },
    '../services/broadcast-sender': { resolveSender: async () => ({ provider: 'evolution' }), claimDirectSlot: async () => ({ allowed, retryAfterSeconds: 300 }) },
    '../services/evolution-whatsapp': { sendTextMessage: async (_phone, text) => { sends++; assert.equal(text, 'Hola'); return unconfirmed ? {} : { messageId: 'direct-1' }; } },
    '../services/kapso-whatsapp': { sendTemplate: () => { throw new Error('Must not use Kapso'); } },
  }, { setImmediate: fn => fn() });
  const send = handler(router.router || router, 'post', '/send-bulk');
  const req = { orgId: 1, body: { sendingProvider: 'evolution', sendingChannelId: 3, items: [{ phone: '56912345678', templateName: 'promo', previewText: 'Hola', force: true }] } };
  let res = response();
  await send(req, res);
  assert.equal(res.code, 429);
  assert.equal(sends, 0);
  optedOut = true; res = response(); await send(req, res);
  assert.equal(res.body.results[0].skipped, true);
  assert.equal(sends, 0);
  optedOut = false; allowed = true; res = response(); await send(req, res);
  assert.equal(res.body.results[0].success, true);
  assert.equal(sends, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channelUsed, 3);
  req.body.items = [{ phone: '56912345678', message: 'Hola', force: true }];
  res = response(); await send(req, res);
  assert.equal(res.body.results[0].success, true);
  assert.equal(sends, 2);
  assert.equal(res.body.results[0].conversationId, 77);
  assert.equal(res.body.results[0].persistencePending, undefined);
  assert.equal(savedMessages.at(-1).content, 'Hola');
  assert.equal(savedMessages.at(-1).type, 'text');
  assert.equal(savedMessages.at(-1).conversationId, 77);
  storageFails = true; res = response(); await send(req, res);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].success, true); // Provider acceptance must never cause a resend.
  assert.equal(res.body.results[0].persistencePending, true);
  assert.match(res.body.results[0].warning, /no reenvíes/);
  assert.equal(res.body.sent, 1);
  assert.equal(sends, 3);
  storageFails = false;
  unconfirmed = true; res = response(); await send(req, res);
  assert.equal(res.body.results[0].pending, true);
  assert.equal(sends, 4);
});

test('history restores exact Evolution text into the original channel without resending', async () => {
  const saved = [], channels = [];
  const router = load('src/routes/reengagement.js', {
    '@anthropic-ai/sdk': class Anthropic {},
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': {
      getPool: () => ({ query: async sql => ({ rowCount: 0, rows: sql.includes('SELECT r.*, bc.sending_provider') ? [
        { destination_phone: '56912345678', sending_provider: 'evolution', sending_channel_id: 3, whatsapp_message_id: 'ev-1', error_detail: { savedContent: 'Hola\nPromoción exacta' } },
        { destination_phone: '56911111111', sending_provider: 'evolution', sending_channel_id: 3, whatsapp_message_id: 'old-1', error_detail: null },
      ] : [] }) }),
      normalizePhone: p => p,
      getWhatsappConfig: async () => null,
      upsertConversation: async (org, phone, name, channel) => { assert.equal(org, 1); channels.push(channel); return { id: 77 }; },
      saveMessage: async message => { saved.push(message); return { id: 90, ...message }; },
      updateConversationLastMessage: async () => {},
      getConversationById: async () => ({ id: 77 }),
    },
    '../services/evolution-whatsapp': { sendTextMessage: () => { throw new Error('Recovery must never resend'); } },
  });
  const res = response();
  await handler(router, 'get', '/campaigns')({ orgId: 1, query: {} }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(saved.length, 1); // Historical records without exact text are not fabricated.
  assert.equal(channels[0], 3);
  assert.equal(saved[0].content, 'Hola\nPromoción exacta');
  assert.equal(saved[0].type, 'text');
  assert.equal(saved[0].whatsappMessageId, 'ev-1');
});

test('daily duplicate checks isolate Kapso and each Evolution channel', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(`
      CREATE TABLE conversations (id INT, organization_id INT, phone_number TEXT, whatsapp_channel_id INT);
      CREATE TABLE messages (conversation_id INT, direction TEXT, type TEXT, status TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE broadcast_campaigns (id INT, organization_id INT, sending_channel_id INT);
      CREATE TABLE broadcast_campaign_recipients (campaign_id INT, organization_id INT, destination_phone TEXT, result_status TEXT, created_at TIMESTAMPTZ);
      INSERT INTO conversations VALUES (1,1,'56912345678',NULL);
      INSERT INTO messages VALUES (1,'outbound','template','sent',NOW());
      INSERT INTO broadcast_campaigns VALUES (2,1,3);
      INSERT INTO broadcast_campaign_recipients VALUES (2,1,'56912345678','accepted',NOW());
    `);
    let sends = 0;
    const router = load('src/routes/reengagement.js', {
      '@anthropic-ai/sdk': class Anthropic {},
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../db/database': {
        getPool: () => ({query: async (sql, params) => sql.includes('SELECT 1 WHERE EXISTS') ? engine.query(sql, params) : { rows: [] }}),
        normalizePhone: p => p, getContact: async () => null,
        upsertConversation: async () => ({ id: 90 }), saveMessage: async () => ({id: 90}),
        updateConversationLastMessage: async () => {}, getConversationById: async () => ({id:90}),
      },
      '../services/commercial': { permitted: async () => true },
      '../services/broadcast-sender': { resolveSender: async () => ({}), claimDirectSlot: async () => ({allowed:true}) },
      '../services/evolution-whatsapp': {sendTextMessage: async () => { sends++; return {messageId:'ev-1'}; }},
    });
    const send = handler(router, 'post', '/send-bulk');
    const req = {orgId:1, body:{sendingProvider:'evolution', sendingChannelId:4, items:[{phone:'56912345678',message:'Hola'}]}};
    let res = response(); await send(req,res);
    assert.equal(res.body.sent, 1); // Neither Kapso nor Evolution channel 3 blocks channel 4.
    req.body.sendingChannelId = 3;
    res = response(); await send(req,res);
    assert.equal(res.body.skipped, 1);
    assert.equal(sends, 1);
    req.body.sendingProvider = 'kapso'; req.body.sendingChannelId = null;
    req.body.items[0].templateName = 'promo';
    res = response(); await send(req,res);
    assert.equal(res.body.skipped, 1);
  } finally { await engine.close(); }
});
