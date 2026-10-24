const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { resumeCampaign, hasOrderThisWeek } = require('../src/services/broadcast-resume');
const { load, handler, response, noop } = require('./helpers.cjs');

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE broadcast_campaigns (
    id BIGINT PRIMARY KEY, organization_id INT, status TEXT, server_managed BOOLEAN,
    sending_provider TEXT, sending_channel_id INT, completed_at TIMESTAMPTZ,
    scheduled_for TIMESTAMPTZ, pacing_settings JSONB);
    CREATE TABLE broadcast_jobs (id SERIAL, campaign_id BIGINT, organization_id INT,
      position INT, item JSONB, state TEXT DEFAULT 'pending', available_at TIMESTAMPTZ DEFAULT NOW(),
      claimed_at TIMESTAMPTZ, result JSONB);
    INSERT INTO broadcast_campaigns VALUES (1,1,'interrupted',TRUE,'kapso',NULL,NOW(),NULL,'{"intervalSeconds":60}');
    INSERT INTO broadcast_jobs(campaign_id,organization_id,position,item,state,result) VALUES
      (1,1,1,'{"phone":"56911111111","templateName":"reenganche"}','done','{"success":true}'),
      (1,1,2,'{"phone":"56922222222","templateName":"reenganche","components":[]}','pending',NULL);`);
  const pool = { query: (...a) => db.query(...a), connect: async () => ({ query: (...a) => db.query(...a), release() {} }) };
  return { db, pool };
}

test('resume only pending jobs; repeat clicks are idempotent; worker never resends accepted recipients', async () => {
  const { db, pool } = await fixture();
  try {
    const before = (await db.query('SELECT * FROM broadcast_jobs ORDER BY id')).rows;
    const calls = [];
    const options = { pool, orgId: 1, campaignId: 1, resolveSender: async (...args) => calls.push(args) };
    const result = await resumeCampaign(options);
    assert.equal(result.pending, 1);
    assert.equal(result.campaign.status, 'processing');
    assert.equal(result.campaign.completed_at, null);
    assert.equal(result.campaign.pacing_settings.intervalSeconds, 60);
    assert.equal(result.campaign.pacing_settings.excludeOrdersThisWeek, true);
    assert.deepEqual((await db.query('SELECT * FROM broadcast_jobs ORDER BY id')).rows, before);
    assert.equal((await resumeCampaign(options)).alreadyRunning, true);
    assert.equal(calls.length, 1);
    const sent = [];
    const { createWorker } = load('src/services/broadcast-worker.js');
    await createWorker(async job => { sent.push(job.item); return { status: 200, body: { results: [{success:true}] } }; }, pool).tick();
    assert.deepEqual(sent.map(item => item.phone), ['56922222222']);
    assert.equal(sent[0].templateName, 'reenganche');
    assert.equal((await db.query('SELECT status FROM broadcast_campaigns')).rows[0].status, 'completed');
  } finally { await db.close(); }
});

test('resume rejects other tenants, in-flight/unknown results, exhausted queues and payment blocks', async () => {
  const { db, pool } = await fixture();
  try {
    const opts = { pool, orgId: 1, campaignId: 1, resolveSender: async () => {} };
    await assert.rejects(resumeCampaign({...opts, orgId:2}), e => e.status === 404);
    for (const state of ['unknown','processing','done']) {
      await db.query('UPDATE broadcast_jobs SET state=$1 WHERE position=2', [state]);
      await assert.rejects(resumeCampaign(opts), e => e.status === 409);
      assert.equal((await db.query('SELECT status FROM broadcast_campaigns')).rows[0].status, 'interrupted');
    }
    await db.exec("UPDATE broadcast_jobs SET state='pending' WHERE position=2");
    for (const status of ['paused_payment', 'completed', 'cancelled']) {
      await db.query('UPDATE broadcast_campaigns SET status=$1', [status]);
      await assert.rejects(resumeCampaign(opts), e => e.status === 409);
    }
    await db.exec("UPDATE broadcast_campaigns SET status='interrupted', server_managed=FALSE");
    await assert.rejects(resumeCampaign(opts), /no conserva una cola/);
  } finally { await db.close(); }
});

test('missing legacy Kapso template cannot be sent as free text, disconnected senders roll back, Evolution resumes', async () => {
  const { db, pool } = await fixture();
  try {
    const opts = { pool, orgId: 1, campaignId: 1, resolveSender: async () => {} };
    await db.exec("UPDATE broadcast_jobs SET item=item-'templateName' WHERE position=2");
    await assert.rejects(resumeCampaign(opts), /no conserva la plantilla/);
    await db.exec("UPDATE broadcast_campaigns SET sending_provider='evolution', scheduled_for=NOW()+INTERVAL '1 hour'");
    await assert.rejects(resumeCampaign({...opts, resolveSender: async () => { throw new Error('Desconectado'); }}), /Desconectado/);
    assert.equal((await db.query('SELECT status FROM broadcast_campaigns')).rows[0].status, 'interrupted');
    const result = await resumeCampaign({...opts, excludeOrdersThisWeek:false});
    assert.equal(result.pending, 1);
    assert.equal(result.campaign.pacing_settings.excludeOrdersThisWeek, false);
    assert.ok(new Date(result.campaign.scheduled_for) > new Date());
  } finally { await db.close(); }
});

test('weekly order exclusion covers unpaid CRM and Shopify orders from Chile Monday, but not cancelled/draft/other tenants', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE conversations (id INT, organization_id INT, phone_number TEXT);
      CREATE TABLE orders (id INT, organization_id INT, conversation_id INT, customer_phone TEXT, status TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE shopify_orders (organization_id INT, customer_phone TEXT, crm_status TEXT, financial_status TEXT, shopify_created_at TIMESTAMPTZ);
      INSERT INTO conversations VALUES (1,1,'+56 9 1111 1111');
      INSERT INTO orders VALUES (1,1,1,NULL,'nuevo',NOW());
      INSERT INTO orders VALUES (2,1,NULL,'56922222222','paid',date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago' - INTERVAL '1 second');
      INSERT INTO orders VALUES (3,1,NULL,'56933333333','cancelled',NOW()),(4,1,NULL,'56944444444','draft',NOW()),(5,2,NULL,'56955555555','paid',NOW());
      INSERT INTO shopify_orders VALUES (1,'9 6666 6666',NULL,'pending',NOW()),(1,'56977777777','cancelled','paid',NOW());`);
    assert.equal(await hasOrderThisWeek(db,1,'56911111111'), true);
    assert.equal(await hasOrderThisWeek(db,1,'56966666666'), true);
    for (const phone of ['56922222222','56933333333','56944444444','56955555555','56977777777']) {
      assert.equal(await hasOrderThisWeek(db,1,phone), false, phone);
    }
    assert.equal(await hasOrderThisWeek(db,2,'56955555555'), true);
  } finally { await db.close(); }
});

test('resume endpoint forwards tenant and validated weekly exclusion, without sending from the browser', async () => {
  let options;
  const router = load('src/routes/reengagement.js', {
    '../middleware/auth': {requireAuth:noop,requireRole:()=>noop},
    '../db/database': {getPool:()=>({})},
    '../services/broadcast-resume': {resumeCampaign:async opts => {options=opts;return {pending:318,campaign:{status:'processing'}};}},
  });
  const resume = handler(router,'post','/campaigns/7/resume');
  let res = response(); await resume({orgId:3,params:{id:7},body:{excludeOrdersThisWeek:'false'}},res);
  assert.equal(res.code,400); assert.equal(options,undefined);
  res=response(); await resume({orgId:3,params:{id:7},body:{}},res);
  assert.equal(res.code,200); assert.equal(options.orgId,3); assert.equal(options.campaignId,7);
  assert.equal(options.excludeOrdersThisWeek,true); assert.equal(res.body.pending,318);
});

test('send-bulk applies the persisted weekly exclusion before any Kapso request and records the omission', async () => {
  let checks = 0;
  const audit = [];
  const pool = { query: async (sql, args) => {
    if (sql.includes('SELECT * FROM broadcast_campaigns')) return {rows:[{
      id:7, sending_provider:'kapso', status:'processing', server_managed:false,
      pacing_settings:{excludeOrdersThisWeek:true},
    }]};
    if (sql.includes('INSERT INTO broadcast_campaign_recipients')) audit.push(args);
    return {rows:[]};
  }};
  const router = load('src/routes/reengagement.js', {
    '../middleware/auth': {requireAuth:noop,requireRole:()=>noop},
    '../db/database': {getPool:()=>pool,normalizePhone:p=>p},
    '../services/broadcast-sender': {resolveSender:async()=>({provider:'kapso'})},
    '../services/commercial': {permitted:async()=>true},
    '../services/broadcast-resume': {hasOrderThisWeek:async(_pool,org,phone)=>{checks++;assert.equal(org,1);assert.equal(phone,'56911111111');return true;}},
    '../services/kapso-whatsapp': {sendTemplate:async()=>{throw new Error('Must not send');}},
  });
  const res=response();
  await handler(router,'post','/send-bulk')({orgId:1,body:{campaignId:7,items:[{phone:'56911111111',templateName:'reenganche'}]}},res);
  assert.equal(checks,1); assert.equal(res.body.skipped,1); assert.equal(res.body.sent,0);
  assert.equal(audit.length,1); assert.match(res.body.results[0].error,/pedido esta semana/);
});
