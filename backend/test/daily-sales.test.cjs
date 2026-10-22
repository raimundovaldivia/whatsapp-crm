const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { dayKey, validateRange, summarizeDailySales, getDailySales } = require('../src/services/daily-sales');
const NOW = new Date('2026-10-24T02:00:00Z');
const RANGE = { from: '2026-10-22', to: '2026-10-22' };
const conv = (id, phone, extra = {}) => ({ id, phone_number: phone, contact_name: `Cliente ${id}`, agent_mode: 'ai', pipeline_state: 'interested', first_inbound_at: '2026-10-22T12:00:00Z', period_first_inbound_at: '2026-10-22T12:00:00Z', last_message_at: '2026-10-22T13:00:00Z', ...extra });
const order = (id, conversation_id, extra = {}) => ({ id, conversation_id, total_price: '10000', status: 'nuevo', created_at: '2026-10-22T13:00:00Z', ...extra });
const report = data => summarizeDailySales({ conversations: [], orders: [], attributions: [], proofs: [], ...data }, RANGE, NOW);

test('Chile dates handle midnight and DST; invalid, oversized and future ranges are rejected', () => {
  assert.equal(dayKey('2026-10-23T02:59:59Z'), '2026-10-22');
  assert.equal(dayKey('2026-10-23T03:00:00Z'), '2026-10-23');
  assert.equal(dayKey('2026-09-06T03:59:59Z'), '2026-09-05');
  assert.equal(dayKey('2026-09-06T04:00:00Z'), '2026-09-06');
  for (const [from, to] of [['2026-02-30','2026-03-01'],['2026-10-24','2026-10-22'],['2026-01-01','2026-10-22'],['2026-10-24','2026-10-24'],['','2026-10-22']]) assert.throws(() => validateRange(from, to, NOW), e => e.status === 400);
});

test('one person across channels; cohort includes later purchase but day sales do not', () => {
  const r = report({ conversations: [conv(1,'+56911112222'), conv(2,'911112222'), conv(3,'56933334444')], orders: [order(1,2,{created_at:'2026-10-23T14:00:00Z'}),order(2,3,{status:'cancelled'}),order(3,3,{status:'draft'})] });
  assert.equal(r.cohort.contacts,2); assert.equal(r.cohort.converted,1); assert.equal(r.cohort.conversion_rate,50); assert.equal(r.activity.orders,0);
  assert.equal(r.opportunities.length,1); assert.equal(r.opportunities[0].reason_source,'inferred'); assert.notEqual(r.opportunities[0].reason_code,'price');
});

test('acquisition and latest purchase campaign stay separate; stale ads do not own repeat purchases', () => {
  const r = report({ conversations:[conv(1,'56911112222',{first_inbound_at:'2026-09-01T12:00:00Z'})],
    attributions:[{id:1,conversation_id:1,provider:'kapso',campaign_id:'A',campaign_name:'Origen',first_seen_at:'2026-09-01T12:00:00Z'},{id:2,conversation_id:1,provider:'kapso',campaign_id:'B',campaign_name:'Recuperación',first_seen_at:'2026-10-22T12:30:00Z'}],
    orders:[order(1,1,{created_at:'2026-09-01T13:00:00Z'}),order(2,1)] });
  assert.equal(r.cohort.acquisition_ads,1); assert.equal(r.results.campaigns[0].label,'Recuperación'); assert.equal(r.results.repeat_orders,1);
  const old = report({ conversations:[conv(1,'56911112222')],orders:[order(1,1)],attributions:[{id:1,conversation_id:1,provider:'kapso',campaign_id:'A',first_seen_at:'2026-09-01T12:00:00Z'}] });
  assert.equal(old.results.campaigns[0].key,'unattributed');
});

test('partial cash, duplicate verified transfers and undated payments do not create fake day revenue', () => {
  const r = report({ conversations:[conv(1,'56911112222')],orders:[
    order(1,1,{status:'entregado',delivered_at:'2026-10-22T14:00:00Z',payment_method:'mixto',payment_cash_amount:3000,payment_marked_at:'2026-10-22T14:00:00Z'}),
    order(2,1,{status:'paid',created_at:'2026-10-20T14:00:00Z',payment_marked_at:'2026-10-22T15:00:00Z'}),order(3,1,{status:'paid'}),order(4,1,{payment_method:'transferencia'}),order(5,1,{status:'cancelled'})
  ],proofs:[{order_id:1,status:'verified',extracted_amount:2000,extracted_reference:'ref1',bank_verified_at:'2026-10-22T15:00:00Z'},{order_id:1,status:'verified',extracted_amount:2000,extracted_reference:'ref1',bank_verified_at:'2026-10-22T15:00:00Z'},{order_id:4,status:'pre_verified',extracted_amount:10000,bank_verified_at:'2026-10-22T15:00:00Z'}] });
  assert.equal(r.activity.collected,15000); assert.equal(r.activity.receivable_current,15000); assert.equal(r.activity.confirmed_payments_without_date,10000); assert.equal(r.activity.orders,3); assert.equal(r.activity.order_value,30000);
});

test('opt-outs are not suggested for contact; existing orders move out of sales opportunities', () => {
  const r=report({conversations:[conv(1,'56911112222',{pipeline_state:'opted_out'}),conv(2,'56933334444')],orders:[order(1,2)]});
  assert.equal(r.opportunities.length,1); assert.match(r.opportunities[0].action,/No contactar/);
});

test('SQL works without Shopify, isolates organizations, respects Chile boundaries and never writes', async () => {
  const engine=new PGlite();
  try {
    await engine.exec(`
      CREATE TABLE conversations(id int,organization_id int,phone_number text,contact_name text,pipeline_state text,agent_mode text,attention_state text,order_draft text,limbo_reason_code text,limbo_reason_note text);
      CREATE TABLE messages(id int,conversation_id int,direction text,status text,content text,created_at timestamp);
      CREATE TABLE orders(id int,organization_id int,conversation_id int,customer_phone text,total_price text,status text,created_at timestamp,delivered_at timestamp,payment_method text,payment_marked_at timestamp,payment_cash_amount numeric);
      CREATE TABLE whatsapp_attributions(id int,organization_id int,conversation_id int,provider text,campaign_id text,campaign_name text,source_id text,source_url text,headline text,first_seen_at timestamptz);
      CREATE TABLE payment_proofs(order_id int,organization_id int,status text,extracted_amount numeric,extracted_reference text,bank_movement_id int,bank_verified_at timestamptz);
      INSERT INTO conversations VALUES(1,1,'56911112222','A','interested','ai',null,'{}',null,null),(2,2,'56911112222','OTHER ORG','collecting_order','ai',null,'{}',null,null);
      INSERT INTO messages VALUES(1,1,'inbound','sent','precio','2026-10-23 02:59:59'),(2,1,'outbound','sent','cuesta 10000','2026-10-23 03:00:00'),(3,2,'inbound','sent','private','2026-10-22 12:00:00');
      INSERT INTO orders VALUES(1,1,1,null,'10000','nuevo','2026-10-23 03:01:00',null,null,null,null),(2,2,2,null,'999999','paid','2026-10-22 12:00:00',null,null,null,null);
    `);
    const queries=[];
    const client={query:async(sql,params)=>{queries.push(sql);return params?engine.query(sql,params):(await engine.exec(sql)).at(-1);},release(){}};
    const r=await getDailySales({connect:async()=>client},1,RANGE,NOW);
    assert.equal(r.cohort.contacts,1);assert.equal(r.cohort.converted,1);assert.equal(r.activity.orders,0);assert.equal(r.activity.receivable_current,10000);
    assert.match(queries[0],/READ ONLY/);assert.equal(queries.at(-1),'COMMIT');assert.ok(!queries.some(q=>/shopify|INSERT |UPDATE |DELETE /i.test(q)));
    const next=await getDailySales({connect:async()=>client},1,{from:'2026-10-23',to:'2026-10-23'},NOW);
    assert.equal(next.activity.order_value,10000);assert.equal(next.cohort.contacts,0);
  } finally {await engine.close();}
});

test('route uses authenticated organization, disables caching and preserves role restrictions', async () => {
  const { load, handler, response, noop } = require('./helpers.cjs');
  const auth = load('src/middleware/auth.js', {});
  let received;
  const router = load('src/routes/dashboard.js', {
    '../db/database':{getPool:()=>({})},
    '../middleware/auth':{requireAuth:noop,requireRole:auth.requireRole},
    '../services/daily-sales':{getDailySales:async(pool,orgId,range)=>{received={orgId,range};return {source:'crm'};}},
  });
  for (const role of ['agent','supervisor','repartidor']) {
    const res=response();let allowed=false;
    router.stack[1].handle({role},res,()=>{allowed=true;});
    assert.equal(allowed,false);assert.equal(res.code,403);
  }
  const res=response();let cache;
  res.set=(key,value)=>{cache=[key,value];return res;};
  await handler(router,'get','/daily-sales')({orgId:7,query:{organization_id:99,from:'2026-10-22',to:'2026-10-22'}},res);
  assert.equal(received.orgId,7);assert.deepEqual(cache,['Cache-Control','no-store']);assert.equal(res.body.success,true);
});

test('a delivery or payment inquiry for an existing open order is operational, not a lost sale', () => {
  const r=report({conversations:[conv(1,'56911112222',{pipeline_state:'awaiting_payment'})],orders:[order(1,1,{created_at:'2026-10-21T14:00:00Z'})]});
  assert.equal(r.operational_contacts,1);assert.equal(r.opportunities.length,0);assert.equal(r.cohort.converted,0);assert.equal(r.cohort.limbo,0);
});
