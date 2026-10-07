const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response } = require('./helpers.cjs');

test('dispatcher connection is dedicated, idempotent, identity checked, tenant scoped and never a sales default', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => { const r = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1); return { ...r, rowCount: r.affectedRows ?? r.rows?.length ?? 0 }; };
  class Pool { query(...a) { return query(...a); } async connect() { return { query, release() {} }; } async end() {} }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
      INSERT INTO users(id,organization_id,email,password_hash,name,role) VALUES
      (1,1,'owner','x','Admin','owner'),(2,1,'fer','x','FER','repartidor'),(3,1,'luis','x','Luis Fernando','repartidor'),(4,2,'other','x','Other','repartidor');
      INSERT INTO whatsapp_channels(organization_id,name,evolution_api_url,evolution_api_key,evolution_instance,webhook_token,is_default,status)
      VALUES(1,'Sales','https://example.com','secret','sales','token',true,'connected');`);
    const db = load('src/db/database.js', { pg: { Pool } });
    let state = 'disconnected', phone = null, creates = 0, exists = false;
    const evo = { normalizeConnectionState: x => x, getConnectionState: async () => { if (!exists) throw { response: { status: 404 } }; return state; },
      createInstance: async () => { creates++; exists = true; }, configureWebhook: async () => {},
      getConnectQr: async () => ({ base64: 'image', secret: 'must not leak' }), getConnectedPhone: async () => phone };
    const service = load('src/services/driver-whatsapp.js', { '../db/database': db, './evolution-whatsapp': evo }, { process: { env: { CRM_PUBLIC_URL: 'https://crm.example' } } });
    await assert.rejects(service.prepare(1, 4, '56949162274'), /no encontrado/);
    let result = await service.prepare(1, 3, '+56 9 4916 2274');
    assert.equal(result.channel.status, 'disconnected');
    assert.equal(result.channel.expected_phone, '56949162274');
    assert.equal(JSON.stringify(result).includes('secret'), false);
    await service.prepare(1, 3, '56949162274'); assert.equal(creates, 1);
    assert.equal((await db.listWhatsappChannels(1)).length, 1);
    assert.equal((await db.getDefaultWhatsappChannel(1)).name, 'Sales');
    assert.equal((await db.getEvolutionWhatsappChannel(1)).name, 'Sales');
    assert.equal(await db.setDefaultWhatsappChannel(1, result.channel.id), null);
    assert.equal((await service.inspect(2, 3)).channel, null);
    state = 'connected'; phone = '56900000000';
    result = await service.inspect(1, 3); assert.equal(result.channel.status, 'wrong_number');
    const stop = { driver_user_id: 3, phone: '56911111111', customerName: 'Cliente' };
    assert.equal((await service.route(1, stop, true)).available, false);
    assert.equal((await engine.query('SELECT * FROM conversations')).rows.length, 0);
    phone = '56949162274'; result = await service.inspect(1, 3);
    assert.equal(result.channel.status, 'connected');
    const route = await service.route(1, stop, true);
    assert.equal(route.available, true); assert.equal(route.personal, true);
    assert.equal(route.config.id, result.channel.id);
    assert.equal((await db.getConversationById(route.conversation.id, 1)).agent_mode, 'human');
    state = 'disconnected'; await service.inspect(1, 3);
    assert.equal((await service.route(1, stop, true)).available, false);

    await engine.exec(`INSERT INTO delivery_routes(organization_id,name,driver_user_id,driver_name) VALUES(1,'Ruta FER',2,'FER');
      INSERT INTO delivery_expenses(organization_id,driver_user_id,amount,client_request_id) VALUES(1,2,1000,'same'),(1,3,2000,'same');`);
    const merge = load('src/services/merge-drivers.js', { '../db/database': db }).merge;
    await assert.rejects(merge(1, 2, 4, 1, 'Bad'), /activos/);
    await merge(1, 2, 3, 1, 'LUIS FERNANDO');
    assert.equal(await db.getUserById(2), null);
    assert.equal((await db.listOrgUsers(1)).length, 2);
    assert.equal((await db.getUserById(3)).name, 'LUIS FERNANDO');
    const expenses = (await engine.query('SELECT * FROM delivery_expenses ORDER BY id')).rows;
    assert.equal(expenses.length, 2); assert.equal(expenses[0].driver_user_id, 3); assert.equal(expenses[0].original_driver_user_id, 2);
    assert.notEqual(expenses[0].client_request_id, expenses[1].client_request_id);
    assert.equal((await engine.query('SELECT * FROM user_merge_audit')).rows.length, 1);
    assert.equal((await engine.query('SELECT * FROM delivery_routes')).rows[0].driver_user_id, 3);
    await assert.rejects(merge(1, 2, 3, 1), /activos/);
  } finally { await engine.close(); }
});

test('personal Evolution inbound audio and images are stored without AI or payment automation', async () => {
  const saved = [], modes = [];
  const channel = { id: 7, provider: 'evolution', assigned_user_id: 3 };
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': { getOrgById: async () => ({ id: 1 }), getWhatsappChannel: async () => channel,
      upsertConversation: async () => ({ id: 9 }), setAgentMode: async (...args) => modes.push(args),
      saveMessage: async m => { saved.push(m); return m; }, updateConversationLastMessage: async () => {}, getConversationById: async () => ({ id: 9 }) },
    '../services/evolution-whatsapp': { parseConnectionUpdate: () => null, parseStatusUpdate: () => null,
      parseWebhookMessage: body => ({ type: body.data.type, messageId: body.data.type, from: '56911111111' }), mediaReference: () => 'media' },
    '../services/inbound-text': { processInboundText: () => assert.fail('Sales bot must not run') },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
  });
  await handler(router, 'post', '/1/7/token')({ params: { orgId: '1', channelId: '7' }, body: { data: [{ type: 'audio' }, { type: 'image' }] } }, response());
  assert.equal(saved.length, 2); assert.equal(saved[0].sentBy, 'client'); assert.equal(modes.length, 2);
});
