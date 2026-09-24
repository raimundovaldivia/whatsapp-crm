const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('PostgreSQL migrations, tenant payment isolation, rollback and expense idempotency',async()=>{
  const engine=new PGlite();
  const query=async(sql,params)=>{
    const result=params?.length ? await engine.query(sql,params) : (await engine.exec(sql)).at(-1);
    return {...result,rowCount:result.affectedRows ?? result.rows?.length ?? 0};
  };
  class Pool { query(...args){return query(...args)} async connect(){return {query,release(){}}} async end(){} }
  try {
    const setup=load('src/db/setup.js',{pg:{Pool}});
    await setup.setupDatabase();
    await setup.setupDatabase(); // Migration must also be safe on the next boot.
    await engine.exec("INSERT INTO organizations (id,name,slug) VALUES (1,'A','a'),(2,'B','b'); INSERT INTO conversations(id,organization_id,phone_number) VALUES (1,1,'111'),(2,2,'222'); INSERT INTO orders(id,organization_id,conversation_id,items,total_price,status) VALUES (1,1,1,'[]','100','sent'),(2,2,2,'[]','100','sent'); INSERT INTO payment_proofs(id,organization_id,conversation_id,order_id,media_id) VALUES (1,1,1,1,'m1'),(2,2,2,2,'m2');");
    const db=load('src/db/database.js',{pg:{Pool}});
    assert.equal(await db.updatePaymentProof(2,{status:'verified'},1),null);
    assert.equal((await engine.query('SELECT status FROM orders WHERE id=2')).rows[0].status,'sent');
    await db.updatePaymentProof(1,{status:'verified'},1);
    assert.equal((await engine.query('SELECT status FROM orders WHERE id=1')).rows[0].status,'paid');
    await engine.exec("UPDATE payment_proofs SET order_id=2,status='pending' WHERE id=1");
    await assert.rejects(()=>db.updatePaymentProof(1,{status:'verified'},1));
    assert.equal((await engine.query('SELECT status FROM payment_proofs WHERE id=1')).rows[0].status,'pending');
    const {handler,response,noop}=require('./helpers.cjs');
    const router=load('src/routes/delivery.js',{'../db/database':{getPool:()=>({query}),getUserById:async()=>({name:'test'})},'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});
    for(let i=0;i<2;i++){
      const res=response();await handler(router,'post','/expenses')({orgId:1,userId:10,role:'repartidor',body:{amount:100,clientRequestId:'expense_test_123'}},res);assert.equal(res.code,201);
    }
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM delivery_expenses')).rows[0].n,1);
    const inbox=load('src/services/webhook-inbox.js',{'../db/database':{getPool:()=>new Pool()}});
    let calls=0;
    const receive=inbox.durableWebhook('test',async()=>{calls++;inbox.track(Promise.resolve());});
    const req={webhookOrg:{id:1},params:{},rawBody:Buffer.from('{"message":"test"}'),body:{message:'test'},headers:{}};
    for(let i=0;i<2;i++){const res=response();await receive(req,res);assert.equal(res.code,200);}
    assert.equal(calls,0,'acknowledgement only after persistence; worker is separate');
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM webhook_inbox')).rows[0].n,1);
    await inbox.processNext();await inbox.processNext();assert.equal(calls,1);
    assert.equal((await engine.query('SELECT status FROM webhook_inbox')).rows[0].status,'completed');
    const fail=inbox.durableWebhook('fails',async()=>{throw Error('provider timeout')});
    await fail(req,response());await inbox.processNext();
    assert.equal((await engine.query("SELECT status FROM webhook_inbox WHERE provider='fails'")).rows[0].status,'needs_review');
    await engine.exec("UPDATE webhook_inbox SET status='processing',updated_at=NOW()-INTERVAL '10 minutes' WHERE provider='fails'");
    await inbox.processNext();
    assert.equal((await engine.query("SELECT status FROM webhook_inbox WHERE provider='fails'")).rows[0].status,'needs_review');
  } finally { await engine.close(); }
});
