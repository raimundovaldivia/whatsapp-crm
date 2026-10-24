const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');
const policy = require('../src/services/outbound-policy');
const NIGHT = new Date('2026-10-24T03:50:00Z');
const MORNING = new Date('2026-10-24T11:30:00Z');

async function fixture(t) {
  const pg = new PGlite(); t.after(() => pg.close());
  await pg.exec(`SET TIME ZONE 'UTC';
    CREATE TABLE conversations(id INT PRIMARY KEY,organization_id INT,phone_number TEXT,whatsapp_channel_id INT,agent_mode TEXT DEFAULT 'ai');
    CREATE TABLE users(id INT PRIMARY KEY,organization_id INT,role TEXT,merged_into_user_id INT);
    CREATE TABLE orders(id INT PRIMARY KEY,organization_id INT,conversation_id INT,status TEXT,created_at TIMESTAMP,updated_at TIMESTAMP);
    CREATE TABLE messages(id SERIAL PRIMARY KEY,conversation_id INT,direction TEXT,content TEXT,type TEXT,status TEXT,sent_by TEXT,agent_type TEXT,
      ai_provider TEXT,ai_model TEXT,prompt_version TEXT,whatsapp_message_id TEXT UNIQUE,created_at TIMESTAMP DEFAULT NOW());
    INSERT INTO conversations(id,organization_id,phone_number) VALUES(11,1,'56911111111'),(22,2,'56922222222');
    INSERT INTO users VALUES(1,1,'owner',NULL),(2,2,'owner',NULL),(3,1,'repartidor',NULL);`);
  const migration = fs.readFileSync(path.join(__dirname,'../src/db/outbound-message-queue.sql'),'utf8');
  await pg.exec(migration); await pg.exec(migration);
  let available = Promise.resolve();
  const connect = async () => {
    const previous = available; let release;
    available = new Promise(resolve => { release = resolve; });
    await previous;
    return { query: async(sql,args) => { const r=await pg.query(sql,args); return {...r,rowCount:r.affectedRows}; }, release };
  };
  const pool = {connect, query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args)}finally{c.release()}}};
  const db = { getPool:()=>pool, getSetting:async()=> 'true', updateConversationLastMessage:async()=>{}, getConversationById:async(id,org)=>
    (await pool.query('SELECT * FROM conversations WHERE id=$1 AND organization_id=$2',[id,org])).rows[0] };
  const sends=[];
  const provider={sendTextMessage:async(...args)=>{sends.push(args);return {messageId:'wa-'+sends.length}},messageId:r=>r?.messageId,
    configForConversation:async(org,conv)=>({provider:'kapso',organization_id:org,conversationId:conv.id})};
  const service=load('src/services/outbound-message-queue.js',{'../db/database':db,'./whatsapp-provider':provider,
    './response-guardrail':{checkResponseFreshness:async()=>({ok:true})}});
  const enqueue=(options={})=>service.deferOutsideHours({orgId:1,conversationId:11,text:'Hola, tu pedido está registrado',sentBy:'human',createdBy:1,now:NIGHT,...options},pool);
  const worker=(options={})=>service.createWorker({pool,clock:()=>MORNING,...options});
  const messages=async()=> (await pool.query('SELECT * FROM messages ORDER BY id')).rows;
  return {pg,pool,db,service,sends,enqueue,worker,messages};
}

test('next Chile window, DST, no overnight sending, durable duplicate protection',async t=>{
  const f=await fixture(t);
  assert.equal(await f.enqueue({now:MORNING}),null);
  const m=await f.enqueue();
  assert.equal(new Date(m.outbound_queue.dueAt).toISOString(),'2026-10-24T11:30:00.000Z');
  assert.equal(m.status,'pending'); assert.equal(m.whatsapp_message_id,null);
  assert.equal((await f.enqueue()).id,m.id);
  assert.equal((await f.messages()).length,1);
  await f.worker({clock:()=>NIGHT}).tick(1); assert.equal(f.sends.length,0);
  const winter=await f.enqueue({text:'Invierno',now:new Date('2026-06-10T02:00:00Z')});
  assert.equal(new Date(winter.outbound_queue.dueAt).toISOString(),'2026-06-10T12:30:00.000Z');
  const summer=await f.enqueue({text:'Noche',now:new Date('2026-10-25T00:00:00Z')});
  assert.equal(new Date(summer.outbound_queue.dueAt).toISOString(),'2026-10-25T11:30:00.000Z');
});

test('queued text waits at 08:29:59 and sends at 08:30, including Chile winter',async t=>{
  for (const [night, opening] of [['2026-10-24T03:50:00Z','2026-10-24T11:30:00Z'],['2026-06-10T04:50:00Z','2026-06-10T12:30:00Z']]) {
    const f=await fixture(t);
    const m=await f.enqueue({now:new Date(night)});
    assert.equal(new Date(m.outbound_queue.dueAt).toISOString(),new Date(opening).toISOString());
    await f.worker({clock:()=>new Date(new Date(opening).getTime()-1000)}).tick(1);
    assert.equal(f.sends.length,0);
    assert.equal((await f.messages())[0].outbound_queue.state,'queued');
    await f.worker({clock:()=>new Date(opening)}).tick(1);
    assert.equal(f.sends.length,1);
    assert.equal((await f.messages())[0].outbound_queue.state,'sent');
  }
});

test('validates text, tenant and owner before queueing',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.enqueue({conversationId:22}),/no encontrada/);
  await assert.rejects(f.enqueue({createdBy:2}),/No autorizado/);
  await assert.rejects(f.enqueue({createdBy:3}),/No autorizado/);
  await assert.rejects(f.enqueue({text:'x'.repeat(4097)}),/4096/);
  await assert.rejects(f.enqueue({text:42}),/4096/);
  assert.equal((await f.messages()).length,0);
});

test('worker sends once, persists provider receipt on same message, preserves tenant',async t=>{
  const f=await fixture(t); const m=await f.enqueue();
  await f.worker().tick(2); assert.equal(f.sends.length,0);
  await Promise.all([f.worker().tick(1),f.worker().tick(1)]);
  await f.worker().tick(1);
  assert.equal(f.sends.length,1); assert.equal(f.sends[0][0],'56911111111');
  const rows=await f.messages(); assert.equal(rows.length,1);assert.equal(rows[0].id,m.id);
  assert.equal(rows[0].outbound_queue.state,'sent');assert.equal(rows[0].whatsapp_message_id,'wa-1');
});

test('only latest AI draft remains eligible, unsent text is excluded from pipeline history',async t=>{
  const f=await fixture(t);
  await f.pool.query("INSERT INTO messages(conversation_id,direction,content,status,sent_by) VALUES(11,'inbound','Pregunta','sent','client')");
  await f.enqueue({text:'Primera respuesta',sentBy:'ai',createdBy:null});
  await f.enqueue({text:'Respuesta actualizada',sentBy:'ai',createdBy:null});
  const rows=await f.messages(); assert.equal(rows[1].outbound_queue.state,'cancelled');assert.equal(rows[2].outbound_queue.state,'queued');
  const db=load('src/db/database.js',{pg:{Pool:class {constructor(){return f.pool}}}});
  const history=await db.getLastMessages(11,20);
  assert.equal(history.length,1);assert.equal(history[0].content,'Pregunta');
  await f.worker().tick(1);assert.equal(f.sends.length,1);assert.equal(f.sends[0][1],'Respuesta actualizada');
});

for (const reason of ['new-message','phone','channel','permission','freshness','human-mode']) {
  test(`holds queued text for review after ${reason}`,async t=>{
    const f=await fixture(t);
    await f.enqueue(reason==='human-mode'?{sentBy:'ai',createdBy:null}:{});
    if(reason==='new-message') await f.pool.query("INSERT INTO messages(conversation_id,direction,content,status,sent_by) VALUES(11,'inbound','Ya no lo quiero','sent','client')");
    if(reason==='phone') await f.pool.query("UPDATE conversations SET phone_number='56999999999' WHERE id=11");
    if(reason==='channel') await f.pool.query('UPDATE conversations SET whatsapp_channel_id=99 WHERE id=11');
    if(reason==='permission') await f.pool.query("UPDATE users SET role='repartidor' WHERE id=1");
    if(reason==='human-mode') await f.pool.query("UPDATE conversations SET agent_mode='human' WHERE id=11");
    await f.worker(reason==='freshness'?{checkFreshness:async()=>({ok:false})}:{}).tick(1);
    assert.equal(f.sends.length,0);assert.equal((await f.messages())[0].outbound_queue.state,'review');
  });
}

test('uncertain transport and interrupted processing are never retried',async t=>{
  const f=await fixture(t);await f.enqueue();let attempts=0;
  await f.worker({send:async()=>{attempts++;throw new Error('timeout')}}).tick(1);
  await f.worker().tick(1);assert.equal(attempts,1);assert.equal(f.sends.length,0);
  assert.equal((await f.messages())[0].outbound_queue.state,'uncertain');
  await f.enqueue({text:'Otra gestión'});
  await f.pool.query(`UPDATE messages SET outbound_queue=outbound_queue || '{"state":"processing","startedAt":"2026-10-24T11:00:00Z"}'::jsonb WHERE id=2`);
  await f.worker().tick(1);assert.equal(f.sends.length,0);assert.equal((await f.messages())[1].outbound_queue.state,'uncertain');
});

test('official 24h expiration is held, never sent through another channel',async t=>{
  const f=await fixture(t);await f.enqueue();
  await f.worker({send:async()=>{throw Object.assign(new Error('expired'),{is24hWindow:true})}}).tick(1);
  assert.equal((await f.messages())[0].outbound_queue.state,'review');
  await f.worker().tick(1);assert.equal(f.sends.length,0);
});

test('closing the window while validating postpones without transport',async t=>{
  const f=await fixture(t);await f.enqueue();let now=MORNING;
  await f.worker({clock:()=>now,checkFreshness:async()=>{now=new Date('2026-10-25T00:00:00Z');return {ok:true}}}).tick(1);
  assert.equal(f.sends.length,0);assert.equal((await f.messages())[0].outbound_queue.state,'queued');
});

test('cancel endpoint checks organization and only cancels unclaimed messages',async t=>{
  const f=await fixture(t);const m=await f.enqueue();
  const router=load('src/routes/conversations.js',{'../db/database':f.db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});
  const cancel=handler(router,'delete','/11/messages/1/queue');
  const foreign=response();await cancel({orgId:2,params:{id:11,messageId:m.id}},foreign);assert.equal(foreign.code,409);
  const own=response();await cancel({orgId:1,params:{id:11,messageId:m.id}},own);assert.equal(own.code,200);
  await f.worker().tick(1);assert.equal(f.sends.length,0);
  assert.equal((await f.messages())[0].outbound_queue.state,'cancelled');
});

test('manual chat endpoint returns queued record without invoking transport',async t=>{
  const f=await fixture(t);
  const config={provider:'kapso'};
  const router=load('src/routes/conversations.js',{
    '../db/database':{...f.db,getWhatsappConfig:async()=>config,setAgentMode:async()=>{}},
    '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
    '../services/outbound-message-queue':{deferOutsideHours:input=>f.enqueue({...input,now:NIGHT})},
    '../services/whatsapp-provider':{sendTextMessage:()=>{throw new Error('Must not send overnight')}}
  });
  const res=response();await handler(router,'post','/11/messages')({orgId:1,userId:1,params:{id:'11'},body:{text:'Pedido registrado'}},res);
  assert.equal(res.code,202);assert.equal(res.body.queued,true);assert.equal(res.body.data.outbound_queue.state,'queued');
});

test('relative dates crossing midnight and deactivated AI require review',async t=>{
  const f=await fixture(t);
  await f.enqueue({text:'Lo revisamos mañana',now:new Date('2026-10-24T01:00:00Z')});
  await f.worker().tick(1);assert.equal((await f.messages())[0].outbound_queue.state,'review');
  await f.enqueue({text:'Respuesta preparada',sentBy:'ai',createdBy:null});
  f.db.getSetting=async()=>false;
  await f.worker().tick(1);assert.equal(f.sends.length,0);assert.equal((await f.messages())[1].outbound_queue.state,'review');
});

test('explicit order must belong to this chat and remain unchanged and active',async t=>{
  const f=await fixture(t);
  await f.pool.query("INSERT INTO orders VALUES(464,2,22,'nuevo','2026-10-23',NULL)");
  await f.enqueue({text:'Tu pedido #DR-464 quedó registrado'});
  await f.worker().tick(1);assert.equal(f.sends.length,0);assert.equal((await f.messages())[0].outbound_queue.state,'review');
  await f.pool.query("UPDATE orders SET organization_id=1,conversation_id=11,updated_at='2026-10-24 05:00' WHERE id=464");
  await f.enqueue({text:'Registramos la orden DR-464'});
  await f.worker().tick(1);assert.equal(f.sends.length,0);assert.equal((await f.messages())[1].outbound_queue.state,'review');
  await f.pool.query("UPDATE orders SET updated_at=NULL WHERE id=464");
  await f.enqueue({text:'Orden DR-464 registrada'});
  await f.worker().tick(1);assert.equal(f.sends.length,1);
});

test('legacy provider change cannot silently switch the sending account',async t=>{
  const f=await fixture(t);await f.enqueue({sendingProvider:'twilio'});
  await f.worker().tick(1);assert.equal(f.sends.length,0);assert.equal((await f.messages())[0].outbound_queue.state,'review');
});
