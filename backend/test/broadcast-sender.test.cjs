const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

test('direct pacing serializes concurrent tabs, pauses each batch and survives reload', async () => {
  const pool = new PGlite();
  try {
    const setup = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/db/setup.js'), 'utf8');
    const migration = setup.match(/CREATE TABLE IF NOT EXISTS broadcast_direct_pacing[\s\S]*?ALTER TABLE broadcast_direct_pacing[^;]*;/)[0];
    await pool.exec('CREATE TABLE organizations (id INTEGER PRIMARY KEY); INSERT INTO organizations VALUES (1),(2)');
    await pool.exec(migration);
    await pool.exec(migration);
    const deps = { '../db/database': { getPool: () => pool } };
    let sender = load('src/services/broadcast-sender.js', deps);
    const concurrent = await Promise.all([sender.claimDirectSlot(1), sender.claimDirectSlot(1)]);
    assert.equal(concurrent.filter(r => r.allowed).length, 1);
    assert.equal(concurrent.find(r => !r.allowed).retryAfterSeconds, 60);
    assert.equal((await sender.claimDirectSlot(2)).allowed, true);
    for (let count = 2; count <= 10; count++) {
      await pool.exec(`UPDATE broadcast_direct_pacing SET next_send_at = NOW() - INTERVAL '1 second' WHERE organization_id=1`);
      assert.equal((await sender.claimDirectSlot(1)).allowed, true);
    }
    sender = load('src/services/broadcast-sender.js', deps);
    const pause = await sender.claimDirectSlot(1);
    assert.equal(pause.allowed, false);
    assert.ok(pause.retryAfterSeconds >= 299);
    await pool.exec(`UPDATE broadcast_direct_pacing SET next_send_at = NOW() - INTERVAL '1 second' WHERE organization_id=1`);
    assert.equal((await sender.claimDirectSlot(1)).allowed, true);
    assert.equal((await pool.query('SELECT batch_count FROM broadcast_direct_pacing WHERE organization_id=1')).rows[0].batch_count, 1);
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
  let optedOut = false, allowed = false, sends = 0, channelUsed, unconfirmed = false;
  const router = load('src/routes/reengagement.js', {
    '@anthropic-ai/sdk': class Anthropic {},
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': {
      getPool: () => ({ query: async () => ({ rows: [] }) }),
      normalizePhone: p => p,
      getContact: async () => ({ opt_out: optedOut }),
      upsertConversation: async (_org, _phone, _name, channel) => { channelUsed = channel; return null; },
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
  unconfirmed = true; res = response(); await send(req, res);
  assert.equal(res.body.results[0].pending, true);
  assert.equal(sends, 3);
});
