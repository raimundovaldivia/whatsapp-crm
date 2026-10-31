const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function fixture() {
  let channel = { id: 3, organization_id: 1, provider: 'evolution', status: 'disconnected',
    name: 'Ventas', evolution_instance: 'ventas', evolution_api_url: 'https://evolution.example',
    evolution_api_key: 'private-api-key', webhook_token: 'private-hook-token' };
  const calls = { checks: 0, hooks: 0, updates: [], sends: 0 };
  let actual = 'connected', failCheck = false, failHook = false, release;
  const database = {
    getWhatsappChannel: async (org, id) => org === 1 && id === 3 ? { ...channel } : null,
    listWhatsappChannels: async () => [{ id: 3, organization_id: 1, provider: 'evolution', name: 'Ventas', status: channel.status }],
    getWhatsappConfig: async () => ({ provider: 'kapso' }),
    updateWhatsappChannelStatus: async (org, id, state) => {
      assert.equal(org, 1); assert.equal(id, 3); calls.updates.push(state);
      channel = { ...channel, status: state }; return { ...channel };
    },
  };
  const evo = {
    getConnectionState: async (_channel, options) => {
      assert.equal(options.timeout, 8000); calls.checks++;
      if (release) await release;
      if (failCheck) throw new Error('private-api-key https://secret.example');
      return actual;
    },
    normalizeConnectionState: state => state,
    configureWebhook: async (_channel, url) => {
      calls.hooks++; assert.equal(url, 'https://crm.example/evolution-webhook/1/3/private-hook-token');
      if (failHook) throw new Error('private-hook-token');
    },
    sendTextMessage: async () => { calls.sends++; },
  };
  const connection = load('src/services/evolution-connection.js', {
    '../db/database': database, './evolution-whatsapp': evo,
  }, { process: { env: { CRM_PUBLIC_URL: 'https://crm.example/' } } });
  const sender = load('src/services/broadcast-sender.js', {
    '../db/database': database, './evolution-connection': connection,
  });
  return { connection, sender, calls, database, evo,
    state: value => { actual = value; }, failCheck: value => { failCheck = value; },
    failHook: value => { failHook = value; }, setChannel: value => { channel = { ...channel, ...value }; },
    hold: value => { release = value; }, getChannel: () => channel };
}

test('opening Messaging repairs stale disconnected state without opening Settings or sending', async () => {
  const f = fixture();
  const methods = await f.sender.sendingMethods(1);
  assert.equal(methods[1].available, true);
  assert.equal(f.getChannel().status, 'connected');
  assert.equal(f.calls.hooks, 1);
  assert.equal(f.calls.sends, 0);
  assert.doesNotMatch(JSON.stringify(methods), /private-|webhook_token|evolution_api_key/);
  assert.equal((await f.sender.resolveSender(1, 'evolution', 3)).id, 3);
  assert.equal(f.calls.checks, 2, 'sending forces a fresh check, bypassing the UI cache');
  assert.equal(f.calls.hooks, 1);
});

test('a cached connected channel is blocked when the actual instance closes', async () => {
  const f = fixture();
  await f.sender.sendingMethods(1);
  f.state('disconnected');
  await assert.rejects(f.sender.resolveSender(1, 'evolution', 3), /desconectada/);
  assert.equal(f.getChannel().status, 'disconnected');
  assert.equal(f.calls.sends, 0);
});

test('failed webhook registration retries after status was already saved as connected', async () => {
  const f = fixture(); f.failHook(true);
  const methods = await f.sender.sendingMethods(1);
  assert.equal(f.getChannel().status, 'connected');
  assert.equal(methods[1].available, false);
  assert.match(methods[1].warning, /recepción/);
  assert.doesNotMatch(methods[1].warning, /private-/);
  await assert.rejects(f.sender.resolveSender(1, 'evolution', 3), /recepción/);
  f.failHook(false);
  await f.sender.resolveSender(1, 'evolution', 3);
  assert.equal(f.calls.hooks, 3);
});

test('API failure is unverified, preserves last known status, and cannot permit sending', async () => {
  const f = fixture(); f.setChannel({ status: 'connected' }); f.failCheck(true);
  const methods = await f.sender.sendingMethods(1);
  assert.equal(methods[1].available, false);
  assert.equal(methods[1].connectionStatus, 'unverified');
  assert.equal(f.getChannel().status, 'connected');
  assert.equal(f.calls.updates.length, 0);
  await assert.rejects(f.sender.resolveSender(1, 'evolution', 3), err => err.status === 503 && !/private-/.test(err.message));
  assert.equal(f.calls.sends, 0);
});

test('tenant and personal-channel isolation are checked before any provider request', async () => {
  const f = fixture();
  await assert.rejects(f.connection.refreshChannel(2, 3), err => err.status === 404);
  f.setChannel({ assigned_user_id: 9 });
  await assert.rejects(f.connection.refreshChannel(1, 3), err => err.status === 404);
  assert.equal(f.calls.checks, 0);
});

test('simultaneous checks share one request; unknown states never authorize sending', async () => {
  const f = fixture(); let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const requests = [f.connection.refreshChannel(1, 3), f.connection.refreshChannel(1, 3)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.checks, 1); release();
  await Promise.all(requests);
  f.hold(null); f.state('unexpected-state');
  await assert.rejects(f.sender.resolveSender(1, 'evolution', 3), /desconocido/);
});

test('Settings uses the same refreshed connection and never returns connection secrets', async () => {
  const f = fixture();
  const router = load('src/routes/settings.js', {
    '../db/database': f.database, '../services/evolution-connection': f.connection,
    '../services/evolution-whatsapp': f.evo,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  let res = response();
  await handler(router, 'get', '/whatsapp/channels')({ orgId: 1 }, res);
  assert.equal(res.code, 200); assert.equal(res.body.data[0].status, 'connected');
  assert.doesNotMatch(JSON.stringify(res.body), /private-|webhook_token|evolution_api_key/);
  res = response();
  await handler(router, 'get', '/whatsapp/channels/3/status')({ orgId: 1, params: { id: '3' } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.data.state, 'connected');
  assert.doesNotMatch(JSON.stringify(res.body), /private-|webhook_token|evolution_api_key/);
  res = response();
  await handler(router, 'get', '/whatsapp/channels/3/qr')({ orgId: 1, params: { id: '3' } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.data.qr, null, 'an open instance must not be reconnected to get a QR');
  assert.equal(f.calls.sends, 0);
});
