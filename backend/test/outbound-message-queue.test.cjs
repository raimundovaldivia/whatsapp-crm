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
    CREATE TABLE organizations(id INT PRIMARY KEY,slug TEXT);
    INSERT INTO organizations VALUES(1,'diez-rios-mrs96z69'),(2,'otra-tienda');
    CREATE TABLE conversations(id INT PRIMARY KEY,organization_id INT,phone_number TEXT,whatsapp_channel_id INT,agent_mode TEXT DEFAULT 'ai',campaign_manual_hold BOOLEAN DEFAULT FALSE);
    CREATE TABLE users(id INT PRIMARY KEY,organization_id INT,role TEXT,merged_into_user_id INT);
    CREATE TABLE orders(id INT PRIMARY KEY,organization_id INT,conversation_id INT,status TEXT,created_at TIMESTAMP,updated_at TIMESTAMP);
    CREATE TABLE messages(id SERIAL PRIMARY KEY,conversation_id INT,direction TEXT,content TEXT,type TEXT,status TEXT,sent_by TEXT,agent_type TEXT,
      ai_provider TEXT,ai_model TEXT,prompt_version TEXT,media_id TEXT,whatsapp_message_id TEXT UNIQUE,created_at TIMESTAMP DEFAULT NOW());
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

test('a photo selected overnight is sent and recorded as an image at opening',async t=>{
  const f = await fixture(t);
  const photo = { type: 'image', mediaUrl: 'https://tienda.example/cabra.jpg', caption: '📷 Queso de cabra' };
  await f.enqueue({ sentBy: 'ai', createdBy: null, productMedia: photo, text: 'Elegiste queso de cabra.' });
  const media = [];
  const worker = f.worker({ sendMedia: async (phone, payload) => { media.push([phone, payload]); return { messageId: 'photo-1' }; } });
  await worker.tick(1);
  await worker.tick(1);
  assert.deepEqual(media, [['56911111111', photo]]);
  assert.equal(f.sends.length, 0);
  const [saved] = await f.messages();
  assert.equal(saved.media_id, photo.mediaUrl);
  assert.equal(saved.content, photo.caption);
  assert.equal(saved.type, 'image');
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

async function recordTurn(f, direction, at, conversationId = 11) {
  await f.pool.query(`INSERT INTO messages(conversation_id,direction,content,status,created_at)
    VALUES($1,$2,'Mensaje de prueba','sent',$3::timestamptz AT TIME ZONE 'UTC')`, [conversationId, direction, at.toISOString()]);
}

test('manual composer answers an open inbound at night once, including resubmission and opening', async t => {
  const f = await fixture(t);
  await recordTurn(f, 'inbound', new Date(NIGHT.getTime() - 60000));
  const sent = await f.enqueue({ manualChatReply: true });
  assert.equal(sent.outbound_queue.state, 'sent');
  assert.equal(sent.outbound_queue.manualReplyBy, 1);
  assert.equal((await f.enqueue({ manualChatReply: true })).id, sent.id);
  await f.worker().tick(1);
  assert.equal(f.sends.length, 1);
});

test('manual release scopes recipient, actor and turn, and races safely against another release', async t => {
  const f = await fixture(t);
  const at = new Date(NIGHT.getTime() - 60000);
  await recordTurn(f, 'inbound', at);
  const draft = await f.enqueue();
  const w = f.worker({ clock: () => NIGHT });
  for (const [org, conv, user] of [[2,11,2],[1,22,1],[1,11,2],[1,11,3]]) {
    assert.equal(await w.sendReplyNow(org, conv, draft.id, user), null);
  }
  await Promise.all([w.sendReplyNow(1,11,draft.id,1), w.sendReplyNow(1,11,draft.id,1)]);
  await f.worker().tick(1);
  assert.equal(f.sends.length, 1);
});

test('cold, expired, answered and automatic messages remain queued overnight', async t => {
  const f = await fixture(t);
  const manual = text => f.enqueue({ text, manualChatReply: true });
  assert.equal((await manual('Sin consulta')).outbound_queue.state, 'queued');
  await recordTurn(f, 'inbound', new Date(NIGHT.getTime() - 86400000));
  assert.equal((await manual('Vencida')).outbound_queue.state, 'queued');
  await recordTurn(f, 'inbound', new Date(NIGHT.getTime() - 60000));
  const ai = await f.enqueue({text:'Automática',sentBy:'ai',createdBy:null,manualChatReply:true});
  assert.equal(await f.worker().sendReplyNow(1,11,ai.id,1), null);
  await recordTurn(f, 'outbound', new Date(NIGHT.getTime() - 30000));
  assert.equal((await manual('Ya contestada')).outbound_queue.state, 'queued');
  assert.equal(f.sends.length, 0);
});

test('verified Evolution history can recover a missing inbound but never supersede a later CRM reply', async t => {
  const f = await fixture(t);
  const at = NIGHT.getTime() - 60000;
  const w = f.worker({ clock: () => NIGHT, configForConversation: async () => ({provider:'evolution'}),
    historyForPhone: async phone => { assert.equal(phone, '56911111111'); return {direction:'inbound',at}; } });
  const draft = await f.enqueue();
  assert.equal((await w.sendReplyNow(1,11,draft.id,1)).outbound_queue.state, 'sent');
  const other = await f.enqueue({text:'Otra propuesta'});
  assert.equal((await w.sendReplyNow(1,11,other.id,1)).outbound_queue.state, 'queued');
  assert.equal(f.sends.length, 1);
});

test('another organization retains its quiet hours even with a valid inbound and its own operator', async t => {
  const f = await fixture(t);
  await recordTurn(f, 'inbound', new Date(NIGHT.getTime() - 60000), 22);
  const draft = await f.enqueue({orgId:2,conversationId:22,createdBy:2,manualChatReply:true});
  assert.equal(draft.outbound_queue.state, 'queued');
  assert.equal(await f.worker().sendReplyNow(2,22,draft.id,2), null);
  assert.equal(f.sends.length, 0);
});

test('Evolution history verifies the direct number, content, author and latest turn locally', async () => {
  const number = '56911111111', jid = number + '@s.whatsapp.net';
  const at = Math.floor(NIGHT.getTime()/1000) - 100;
  let records = [];
  const evolution = load('src/services/evolution-whatsapp.js', {
    axios:{create:() => ({post:async (url,body) => {
      assert.equal(url,'/chat/findMessages/channel');
      assert.equal(body.where.key.remoteJid, jid);
      return {data:{messages:{records}}};
    }})},
    './whatsapp-attribution':{}, './ad-attribution':{evolutionReferral:() => null},
  });
  const config={evolution_api_url:'https://example.test',evolution_api_key:'test',evolution_instance:'channel'};
  const entry=(id,remoteJid,fromMe,offset) => ({key:{id,remoteJid,fromMe},messageTimestamp:at+offset,message:{conversation:'Consulta'}});
  records=[entry('a','123@g.us',false,9),entry('b','56922222222@s.whatsapp.net',false,5),entry('c',jid,null,1)];
  assert.equal(await evolution.latestDirectMessage(number,config),null);
  records.push(entry('d',jid,false,0));
  assert.equal((await evolution.latestDirectMessage(number,config)).direction,'inbound');
  records.push(entry('e',jid,true,0));
  assert.equal((await evolution.latestDirectMessage(number,config)).direction,'outbound');
});

async function customerMessage(f, conversationId = 11, at = NIGHT) {
  const {rows:[message]} = await f.pool.query(`INSERT INTO messages
    (conversation_id,direction,content,status,sent_by,whatsapp_message_id,created_at)
    VALUES($1,'inbound','¿Cuánto sale?','sent','client','in-'||nextval('messages_id_seq'),$2::timestamptz AT TIME ZONE 'UTC')
    RETURNING id`, [conversationId, at.toISOString()]);
  return message.id;
}

function botResponse(f, inboundMessageId, options = {}) {
  return f.enqueue({sentBy:'ai',createdBy:null,inboundMessageId,text:'La bandeja cuesta $8.990.',...options});
}

test('Diva responds to a real inbound after closing once, including webhook retries and morning drain', async t => {
  const f = await fixture(t);
  const id = await customerMessage(f);
  const replies = await Promise.all([
    botResponse(f,id,{inboundTimestamp:NIGHT.getTime()/1000}), botResponse(f,id,{text:'Respuesta alternativa'}),
  ]);
  assert.equal(replies[0].id, replies[1].id);
  assert.equal((await f.messages()).at(-1).outbound_queue.state, 'sent');
  assert.equal(f.sends[0][3].botReply, true);
  assert.equal((await botResponse(f,id)).id, replies[0].id);
  await f.worker().tick(1);
  assert.equal(f.sends.length, 1);
});

test('a historic replay, superseded inbound or ID from another conversation cannot open the night window', async t => {
  const f = await fixture(t);
  const old = await customerMessage(f);
  const latest = await customerMessage(f);
  const foreign = await customerMessage(f,22);
  assert.equal((await botResponse(f,old)).outbound_queue.state, 'review');
  assert.equal((await botResponse(f,foreign)).outbound_queue.state, 'review');
  assert.equal((await botResponse(f,latest,{inboundTimestamp:new Date(NIGHT.getTime()-86400000).toISOString()})).outbound_queue.state, 'review');
  await f.worker().tick(1);
  assert.equal(f.sends.length, 0);
});

test('a manual hold, a human takeover and disabled global AI keep Diva silent overnight', async t => {
  const f = await fixture(t);
  await f.pool.query('UPDATE conversations SET campaign_manual_hold=true WHERE id=11');
  assert.equal((await botResponse(f,await customerMessage(f))).outbound_queue.state, 'review');
  await f.pool.query("UPDATE conversations SET campaign_manual_hold=false,agent_mode='human' WHERE id=11");
  assert.equal((await botResponse(f,await customerMessage(f))).outbound_queue.state, 'review');
  await f.pool.query("UPDATE conversations SET agent_mode='ai' WHERE id=11");
  f.db.getSetting = async () => 'false';
  assert.equal((await botResponse(f,await customerMessage(f))).outbound_queue.state, 'review');
  assert.equal(f.sends.length, 0);
});

test('only a handoff acknowledgment may answer a turn in coordinating mode', async t => {
  const f = await fixture(t);
  await f.pool.query("UPDATE conversations SET agent_mode='coordinating' WHERE id=11");
  assert.equal((await botResponse(f,await customerMessage(f))).outbound_queue.state, 'review');
  assert.equal((await botResponse(f,await customerMessage(f),{handoff:true})).outbound_queue.state, 'sent');
  assert.equal(f.sends.length, 1);
});

test('night worker recovers a busy inbound reply while leaving proactive and other-tenant drafts for opening', async t => {
  const f = await fixture(t);
  const queued = await f.enqueue();
  await f.pool.query(`UPDATE messages SET outbound_queue=outbound_queue||'{"state":"processing"}'::jsonb WHERE id=$1`, [queued.id]);
  const inbound = await customerMessage(f);
  const draft = await botResponse(f,inbound);
  assert.equal(draft.outbound_queue.state,'queued');
  await f.pool.query(`UPDATE messages SET outbound_queue=outbound_queue||'{"state":"queued"}'::jsonb WHERE id=$1`, [queued.id]);
  const foreign = await botResponse(f,await customerMessage(f,22),{orgId:2,conversationId:22});
  assert.equal(foreign.outbound_queue.replyToInboundId,undefined);
  const worker=f.worker({clock:()=>NIGHT});
  await worker.tick(2);
  await worker.tick(1);
  await worker.tick(1);
  assert.equal(f.sends.length,1);
  assert.equal((await f.messages()).find(m=>m.id===queued.id).outbound_queue.state,'queued');
});

test('Shared inbound pipeline passes the originating customer message to the night queue and sends a single answer', async t => {
  const f = await fixture(t);
  const config = {provider:'kapso'};
  const readConversation = () => f.db.getConversationById(11,1);
  const inbound = load('src/services/inbound-text.js', {
    '../db/database': {
      ...f.db, upsertConversation: readConversation, getConversationById: readConversation,
      saveMessage: async message => {
        assert.equal(message.direction, 'inbound');
        const {rows:[saved]} = await f.pool.query(`INSERT INTO messages(conversation_id,direction,content,status,sent_by,whatsapp_message_id,created_at)
          VALUES($1,'inbound',$2,'sent','client',$3,$4::timestamptz AT TIME ZONE 'UTC') RETURNING *`,
        [message.conversationId,message.content,message.whatsappMessageId,NIGHT.toISOString()]);
        return saved;
      },
    },
    './pipeline':{processMessage:async () => ({response:'La caja cuesta $37.000.',agentType:'sales'})},
    './pipeline-outbound':{evaluatePipelineResult:async () => ({escalate:false})},
    './outbound-message-queue':{deferOutsideHours:input => f.service.deferOutsideHours({...input,now:NIGHT},f.pool)},
    './whatsapp-provider':{sendTextMessage:() => assert.fail('El webhook no debe duplicar el envío de la cola')},
  });
  await inbound.processInboundText({org:{id:1},whatsappConfig:config,
    parsed:{from:'56911111111',text:'¿Cuánto cuesta la caja?',messageId:'wa-in-1',timestamp:NIGHT.getTime()/1000}});
  const [question,answer] = await f.messages();
  assert.equal(answer.outbound_queue.replyToInboundId,question.id);
  assert.equal(answer.outbound_queue.state,'sent');
  assert.equal(f.sends.length,1);
});
