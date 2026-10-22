const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const { validateEnvironment } = require('../src/sandbox/runtime');

const env = () => ({ CRM_SANDBOX: '1', NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://crm_sandbox:crm_sandbox@db:5432/crm_sandbox',
  SANDBOX_OWNER_PASSWORD: 'Sandbox-Local-Only-2026!' });

test('sandbox rejects production databases, credentials and connection overrides', () => {
  assert.doesNotThrow(() => validateEnvironment(env()));
  for (const change of [
    { NODE_ENV: 'production' }, { CRM_SANDBOX: '0' },
    { DATABASE_URL: 'postgresql://crm_sandbox:crm_sandbox@production.example:5432/crm_sandbox' },
    { DATABASE_URL: env().DATABASE_URL + '?host=production.example' },
    { DATABASE_URL: env().DATABASE_URL.replace('/crm_sandbox', '/crm') },
    { EVOLUTION_API_KEY: 'real-key' }, { KAPSO_API_KEY: 'real-key' },
    { OPENAI_API_KEY: 'real-key' }, { SHOPIFY_ACCESS_TOKEN: 'real-token' },
    { PGHOSTADDR: '10.0.0.1' }, { NODE_OPTIONS: '--require=other.js' },
    { SANDBOX_OWNER_PASSWORD: '' },
  ]) assert.throws(() => validateEnvironment({ ...env(), ...change }));
});

test('sandbox blocks all external HTTP clients and simulates WhatsApp/AI without network', () => {
  const run = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const runtime = require('./src/sandbox/runtime');
    (async () => {
      const {outbox} = runtime.initialize();
      const isBlocked = e => e.code === 'SANDBOX_EGRESS_BLOCKED';
      const axios = require('axios');
      await assert.rejects(() => axios.get('https://example.invalid'), isBlocked);
      await assert.rejects(() => axios.create().post('http://169.254.169.254'), isBlocked);
      await assert.rejects(() => fetch('https://example.invalid'), isBlocked);
      assert.throws(() => require('http').request('http://example.invalid'), isBlocked);
      assert.throws(() => require('https').get('https://example.invalid'), isBlocked);
      for (const name of ['whatsapp','twilio-whatsapp','kapso-whatsapp','evolution-whatsapp']) {
        const result = await require('./src/services/'+name).sendTextMessage('15550100101','fixture',{});
        assert.equal(result.simulated,true); assert.match(result.messageId,/^sandbox-/);
      }
      assert.equal(outbox.length,4);
      const ai = await require('./src/services/ai-provider').client.messages.create({});
      assert.equal(ai.stop_reason,'end_turn');
      assert.match(ai.content[0].text,/SANDBOX/);
    })().catch(e=>{console.error(e);process.exit(1)});
  `], { cwd: require('node:path').resolve(__dirname, '..'), env: { PATH: process.env.PATH, ...env() }, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
});

test('sandbox seed is idempotent and creates only synthetic isolated tenants', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => params?.length ? engine.query(sql, params) : (await engine.exec(sql)).at(-1);
  class Pool { query(...args) { return query(...args); } async connect() { return { query, release() {} }; } async end() {} }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    const { seed } = require('../src/sandbox/seed');
    await seed(new Pool(), env().SANDBOX_OWNER_PASSWORD);
    await seed(new Pool(), env().SANDBOX_OWNER_PASSWORD);
    const organizations = (await engine.query('SELECT * FROM organizations ORDER BY id')).rows;
    assert.deepEqual(organizations.map(o => o.slug), ['sandbox-a', 'sandbox-b']);
    for (const table of ['users','orders','products','conversations','messages','whatsapp_configs','commercial_contracts']) {
      assert.equal((await engine.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n, 2, table);
    }
    const users = (await engine.query('SELECT * FROM users ORDER BY id')).rows;
    assert.equal(await require('bcryptjs').compare(env().SANDBOX_OWNER_PASSWORD, users[0].password_hash), true);
    const db = load('src/db/database.js', { pg: { Pool } });
    const convB = (await engine.query('SELECT id FROM conversations WHERE organization_id=$1', [organizations[1].id])).rows[0];
    assert.equal(await db.getConversationById(convB.id, organizations[0].id), null);
  } finally { await engine.close(); }
});
