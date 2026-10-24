process.env.EVOLUTION_SEND_HOUR_START = '0';
process.env.EVOLUTION_SEND_HOUR_END = '24';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');

test('durable queue survives workers, serializes a campaign, respects waits and stops without resending uncertain jobs', async () => {
  const pool = new PGlite();
  try {
    await pool.exec(`CREATE TABLE organizations (id INTEGER PRIMARY KEY); INSERT INTO organizations VALUES(1);
      CREATE TABLE broadcast_campaigns (id BIGINT PRIMARY KEY, organization_id INT, status TEXT DEFAULT 'processing', server_managed BOOLEAN DEFAULT TRUE, completed_at TIMESTAMPTZ, scheduled_for TIMESTAMPTZ, sending_provider TEXT DEFAULT 'kapso');
      INSERT INTO broadcast_campaigns(id,organization_id) VALUES(1,1);`);
    const source = fs.readFileSync(path.join(__dirname,'../src/db/setup.js'),'utf8');
    await pool.exec(source.match(/CREATE TABLE IF NOT EXISTS broadcast_jobs[\s\S]*?CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_pending[^;]*;/)[0]);
    await pool.exec(`INSERT INTO broadcast_jobs(campaign_id,organization_id,position,item) VALUES(1,1,1,'{"phone":"111"}'),(1,1,2,'{"phone":"222"}')`);
    const { createWorker } = load('src/services/broadcast-worker.js');
    let release, entered;
    const waiting = new Promise(r => entered = r);
    const first = createWorker(async job => { entered(); await new Promise(r => release = r); return { status:200,body:{results:[{success:true}]}}; },pool);
    const active = first.tick(); await waiting;
    let otherSends = 0;
    await createWorker(async () => { otherSends++; }, pool).tick();
    assert.equal(otherSends,0);
    release(); await active;
    assert.equal((await pool.query('SELECT state FROM broadcast_jobs ORDER BY id')).rows[0].state,'done');
    await createWorker(async () => ({status:429,body:{rateLimited:true,retryAfterSeconds:300}}),pool).tick();
    let rows = (await pool.query('SELECT * FROM broadcast_jobs ORDER BY id')).rows;
    assert.equal(rows[1].state,'pending');
    await createWorker(async () => { otherSends++; },pool).tick();
    assert.equal(otherSends,0);
    await pool.exec("UPDATE broadcast_jobs SET available_at = NOW() WHERE state = 'pending'; UPDATE broadcast_campaigns SET status='interrupted'");
    await createWorker(async () => { otherSends++; },pool).tick();
    assert.equal(otherSends,0);
    await pool.exec("UPDATE broadcast_campaigns SET status='processing'; UPDATE broadcast_jobs SET state='processing',claimed_at=NOW()-INTERVAL '6 minutes' WHERE position=2");
    await createWorker(async () => { otherSends++; },pool).tick();
    assert.equal(otherSends,0);
    assert.equal((await pool.query('SELECT state FROM broadcast_jobs WHERE position=2')).rows[0].state,'unknown');
    assert.equal((await pool.query('SELECT status FROM broadcast_campaigns')).rows[0].status,'interrupted');
    await pool.exec(`INSERT INTO broadcast_campaigns(id,organization_id) VALUES(2,1);
      INSERT INTO broadcast_jobs(campaign_id,organization_id,position,item) VALUES(2,1,1,'{}')`);
    await createWorker(async () => ({status:200,body:{results:[{skipped:true}]}}),pool).tick();
    assert.equal((await pool.query('SELECT status FROM broadcast_campaigns WHERE id=2')).rows[0].status,'completed');
  } finally { await pool.close(); }
});

test('starting a queued campaign is atomic, idempotent and tenant scoped for Evolution and Kapso; browsers cannot send or finish it', async () => {
  const { handler, response, noop } = require('./helpers.cjs');
  const engine = new PGlite();
  try {
    await engine.exec(`CREATE TABLE broadcast_campaigns (id BIGINT PRIMARY KEY, organization_id INT, total_count INT, scheduled_for TIMESTAMPTZ,
      sending_provider TEXT, sending_channel_id INT, server_managed BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'processing', completed_at TIMESTAMPTZ);
      CREATE TABLE broadcast_jobs (id SERIAL, campaign_id BIGINT, organization_id INT, position INT, item JSONB, UNIQUE(campaign_id,position));
      CREATE TABLE broadcast_campaign_recipients(campaign_id BIGINT);
      INSERT INTO broadcast_campaigns(id,organization_id,total_count,sending_provider,sending_channel_id) VALUES
        (1,1,2,'evolution',3),(2,1,2,'evolution',3),(3,1,2,'kapso',NULL);`);
    const pool = {query: (...args) => engine.query(...args), connect: async () => ({query: (...args) => engine.query(...args), release() {}})};
    const router = load('src/routes/reengagement.js', {
      '@anthropic-ai/sdk': class Anthropic {}, '../middleware/auth': { requireAuth:noop, requireRole:()=>noop },
      '../db/database': {getPool:()=>pool, normalizePhone:p=>p},
      '../services/broadcast-sender': {resolveSender:async()=>({})},
    });
    const start = handler(router,'post','/campaigns/1/start');
    const req = {orgId:1,params:{id:1},body:{items:[{phone:'56911111111',message:'Hola uno'},{phone:'56922222222',message:'Hola dos'}]}};
    let res = response(); await start({...req,orgId:2},res); assert.equal(res.code,404);
    res = response(); await start({...req,params:{id:2},body:{items:[req.body.items[0],req.body.items[0]]}},res);
    assert.equal(res.code,400); assert.equal((await engine.query('SELECT * FROM broadcast_jobs')).rows.length,0);
    res = response(); await start(req,res); assert.equal(res.code,200,JSON.stringify(res.body));
    res = response(); await start(req,res); assert.equal(res.code,200);
    assert.equal((await engine.query('SELECT * FROM broadcast_jobs')).rows.length,2);
    res = response(); await handler(router,'post','/campaigns/3/start')({...req,params:{id:3}},res);
    assert.equal(res.code,200,JSON.stringify(res.body));
    assert.equal((await engine.query('SELECT * FROM broadcast_jobs')).rows.length,4);
    res = response(); await handler(router,'post','/send-bulk')({orgId:1,body:{campaignId:1,items:req.body.items}},res);
    assert.equal(res.code,409);
    res = response(); await handler(router,'post','/campaigns/1/finish')({...req,body:{status:'completed'}},res);
    assert.equal(res.code,404);
    res = response(); await handler(router,'post','/campaigns/1/stop')(req,res);
    assert.equal(res.body.campaign.status,'interrupted');
  } finally { await engine.close(); }
});

test('Kapso campaigns accept a future start time and persist it for the server worker', async () => {
  const { handler, response, noop } = require('./helpers.cjs');
  const engine = new PGlite();
  try {
    await engine.exec(`CREATE TABLE broadcast_campaigns (
      id BIGSERIAL PRIMARY KEY, organization_id INT, created_by INT, template_name TEXT,
      total_count INT, test_mode BOOLEAN, test_phone TEXT, sending_provider TEXT,
      sending_channel_id INT, pacing_settings JSONB, scheduled_for TIMESTAMPTZ,
      server_managed BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'processing'
    );`);
    const pool = { query: (...args) => engine.query(...args) };
    const router = load('src/routes/reengagement.js', {
      '@anthropic-ai/sdk': class Anthropic {}, '../middleware/auth': { requireAuth:noop, requireRole:()=>noop },
      '../db/database': { getPool:()=>pool, normalizePhone:p=>p },
      '../services/broadcast-sender': { resolveSender:async()=>({ provider:'kapso' }) },
    });
    const create = handler(router,'post','/campaigns');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = response();
    await create({ orgId:7, userId:4, body:{ templateName:'reenganche', total:320, sendingProvider:'kapso', scheduledFor:future } },res);
    assert.equal(res.code,200,JSON.stringify(res.body));
    const campaign = (await engine.query('SELECT * FROM broadcast_campaigns')).rows[0];
    assert.equal(campaign.organization_id,7);
    assert.equal(campaign.total_count,320);
    assert.equal(new Date(campaign.scheduled_for).toISOString(),future);
  } finally { await engine.close(); }
});

test('a single failed recipient does not stop the campaign; three consecutive failures do', async () => {
  const pool = new PGlite();
  try {
    await pool.exec(`CREATE TABLE organizations (id INTEGER PRIMARY KEY); INSERT INTO organizations VALUES(1);
      CREATE TABLE broadcast_campaigns (id BIGINT PRIMARY KEY, organization_id INT, status TEXT DEFAULT 'processing', server_managed BOOLEAN DEFAULT TRUE, completed_at TIMESTAMPTZ, scheduled_for TIMESTAMPTZ, sending_provider TEXT DEFAULT 'kapso');
      INSERT INTO broadcast_campaigns(id,organization_id) VALUES(1,1),(2,1);`);
    const source = fs.readFileSync(path.join(__dirname,'../src/db/setup.js'),'utf8');
    await pool.exec(source.match(/CREATE TABLE IF NOT EXISTS broadcast_jobs[\s\S]*?CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_pending[^;]*;/)[0]);
    await pool.exec(`INSERT INTO broadcast_jobs(campaign_id,organization_id,position,item) VALUES
      (1,1,1,'{"phone":"111"}'),(1,1,2,'{"phone":"222"}'),(1,1,3,'{"phone":"333"}'),
      (2,1,1,'{"phone":"444"}'),(2,1,2,'{"phone":"555"}'),(2,1,3,'{"phone":"666"}'),(2,1,4,'{"phone":"777"}')`);
    const { createWorker } = load('src/services/broadcast-worker.js');
    const ok = { status: 200, body: { results: [{ success: true }] } };
    const fail = { status: 200, body: { results: [{ success: false, error: 'Request failed with status code 400' }] } };
    const sent = [];
    const run = (outcome) => createWorker(async job => { sent.push(job.item.phone); return outcome(job); }, pool).tick();
    // Campaign 1: middle recipient fails, the rest still go out and the campaign completes.
    const c1 = job => job.item.phone === '222' ? fail : ok;
    for (let i = 0; i < 3; i++) await run(c1);
    assert.deepEqual(sent, ['111', '222', '333']);
    assert.equal((await pool.query('SELECT status FROM broadcast_campaigns WHERE id=1')).rows[0].status, 'completed');
    // Campaign 2: three failures in a row stop it before the fourth recipient.
    sent.length = 0;
    for (let i = 0; i < 4; i++) await run(() => fail);
    assert.deepEqual(sent, ['444', '555', '666']);
    assert.equal((await pool.query('SELECT status FROM broadcast_campaigns WHERE id=2')).rows[0].status, 'interrupted');
  } finally { await pool.close(); }
});
