const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

async function fixture() {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const r = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...r, rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
  };
  class Pool { query(...args) { return query(...args); } async connect() { return { query, release() {} }; } async end() {} }
  await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
  await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
    INSERT INTO conversations(id,organization_id,phone_number,contact_name,agent_mode,last_escalation_at)
    VALUES(101,1,'111','Ana','human',NOW()-INTERVAL '3 days'),(102,1,'222','Luis','human',NOW()),(201,2,'333','Other','human',NOW());
    INSERT INTO admin_pending_replies(org_id,conversation_id,customer_phone) VALUES(1,101,'111'),(1,102,'222'),(2,201,'333');`);
  const db = load('src/db/database.js', { pg: { Pool } });
  await db.setSetting(1,'admin_alert_phone','569000');
  return { engine, db, query };
}

test('persistent handoff: explicit selection, many replies, restart, close, return to bot and tenant isolation', async () => {
  const { engine, db, query } = await fixture();
  try {
    const assignment = load('src/services/admin-assignment.js', { '../db/database': db });
    const sent = [], notices = [];
    let fail = false;
    const kapso = { sendTextMessage: async (to, text) => {
      if (fail && to === '111') throw Error('offline');
      sent.push({ to, text }); return { messages: [{ id: `m${sent.length}` }] };
    }, markAsRead: async () => {} };
    const makeRelay = () => load('src/services/admin-relay.js', { '../db/database': db,
      './admin-assignment': load('src/services/admin-assignment.js', { '../db/database': db }), './kapso-whatsapp': kapso,
      './staff-identity': load('src/services/staff-identity.js', { '../db/database': db }),
      './admin-notify': { notifyAdmin: async (org,notice) => { notices.push(notice); } },
      './human-attention': load('src/services/human-attention.js', {'../db/database':db, './admin-assignment':assignment, './staff-identity':load('src/services/staff-identity.js', {'../db/database':db}), './admin-notify':{notifyAdmin:async(org,notice)=>{notices.push(notice);}}}) });
    let relay = makeRelay();
    const admin = text => relay.handle({ id: 1 }, {}, { from: '+569000', text });
    await admin('hola'); assert.equal(await assignment.get(1), null);
    await admin('TOMAR'); assert.equal(await assignment.get(1), null, 'ambiguous selection must not pick newest');
    await admin('TOMAR 201'); assert.equal(await assignment.get(1), null, 'other tenant cannot be claimed');
    await admin('TOMAR 101'); assert.equal((await assignment.get(1)).conversation_id, 101);
    await admin('ENVIAR Primera respuesta');
    relay = makeRelay(); // No session memory survives.
    await admin('ENVIAR Segunda respuesta');
    assert.equal(await relay.receive({id:1},{},{from:'111',messageId:'in-1',type:'image',mediaId:'file-1'}),true);
    assert.equal(await relay.receive({id:1},{},{from:'111',messageId:'in-1',type:'image',mediaId:'file-1'}),true);
    assert.equal(notices.length,1,'duplicate webhook must not notify twice');
    assert.equal(notices[0].conversationId,101);
    assert.match(notices[0].body,/image/);
    assert.equal(await relay.receive({id:1},{},{from:'222',messageId:'other',text:'hola'}),true);
    assert.deepEqual(sent.filter(m => m.to === '111').map(m => m.text), ['Primera respuesta','Segunda respuesta']);
    await admin('TOMAR 102'); assert.equal((await assignment.get(1)).conversation_id, 101);
    await assert.rejects(relay.handle({ id: 1 }, {}, { from: 'other-admin', text: 'wrong person' }));
    assert.equal(sent.filter(m => m.text === 'wrong person').length, 0);
    fail = true; await assert.rejects(admin('ENVIAR No salió'), /offline/);
    assert.equal((await assignment.get(1)).conversation_id, 101, 'failed send retains assignment');
    fail = false;
    await admin('CERRAR'); assert.equal(await assignment.get(1), null);
    assert.equal((await db.getConversationById(101)).agent_mode, 'human');
    assert.equal((await query("SELECT count(*)::int n FROM admin_pending_replies WHERE conversation_id=101 AND status='pending'")).rows[0].n, 0);
    await admin('TOMAR'); assert.equal((await assignment.get(1)).conversation_id, 102);
    await admin('BOT'); assert.equal(await assignment.get(1), null);
    assert.equal((await db.getConversationById(102)).agent_mode, 'ai');
    await db.setAgentMode(101, 'human'); await db.createAdminPendingReply(1,101,'111','test');
    await admin('TOMAR 101'); await db.setAgentMode(101, 'ai');
    assert.equal(await assignment.get(1), null, 'CRM return to AI releases assignment');
  } finally { await engine.close(); }
});

test('notification delivery distinguishes acceptance, receipts, failures, queue and tenant-scoped history', async () => {
  const { engine, db, query } = await fixture();
  try {
    let behavior = 'success', next = 'notice-1';
    let delivery;
    const kapso = { sendTextMessage: async () => {
      if (behavior === 'window') { const e = Error('closed'); e.is24hWindow = true; throw e; }
      if (behavior === 'fail') throw Error('network');
      if (behavior === 'early') await delivery.receipt(1, { messageId: next, status: 'delivered' });
      return { messages: [{ id: next }] };
    } };
    delivery = load('src/services/admin-delivery.js', { '../db/database': db, './kapso-whatsapp': kapso });
    const send = () => delivery.send(1, { phone:'admin',body:'test',config:{},kind:'help',conversationId:101 });
    const status = async () => (await query('SELECT * FROM admin_notification_deliveries ORDER BY id DESC LIMIT 1')).rows[0];
    await send(); assert.equal((await status()).status, 'accepted'); assert.equal((await status()).delivered_at, null);
    await delivery.receipt(2, { messageId: next, status: 'read' }); assert.equal((await status()).status,'accepted');
    await delivery.receipt(1, { messageId: next, status: 'read' });
    await delivery.receipt(1, { messageId: next, status: 'sent' });
    await delivery.receipt(1, { messageId: next, status: 'failed' });
    assert.equal((await status()).status,'read'); assert.ok((await status()).read_at);
    behavior='early'; next='early'; await send(); assert.equal((await status()).status, 'delivered');
    behavior='success'; next='async-failure'; await send();
    await delivery.receipt(1, { messageId: next, status: 'failed', error: { code: 131047 } });
    assert.equal((await status()).status,'failed'); assert.match((await status()).error,/131047/);
    behavior='window'; await assert.rejects(send()); assert.equal((await status()).status, 'queued');
    behavior='fail'; await assert.rejects(send()); assert.equal((await status()).status, 'failed');
    await delivery.blocked(1,{kind:'help',conversationId:101,reason:'sin_admin_phone'});
    assert.equal((await status()).error,'sin_admin_phone');
    await db.setSetting(1,'admin_alert_phone','569000');
    const cfg={provider:'kapso'};
    const notifyDb={...db,getWhatsappConfig:async()=>cfg};
    const notify=load('src/services/admin-notify.js',{'../db/database':notifyDb,'./kapso-whatsapp':kapso,'./admin-delivery':delivery});
    behavior='window'; const queued=await notify.notifyAdmin(1,{body:'test',conversationId:101}); assert.equal(queued.queued,true);
    behavior='success';next='retry'; await notify.drainAdminOutbox(1,cfg);
    assert.equal((await status()).status,'accepted');
    await delivery.receipt(1,{messageId:next,status:'delivered'});assert.equal((await status()).status,'delivered');
    const router=load('src/routes/admin-alerts.js',{'../db/database':notifyDb,'../services/admin-notify':notify,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop}, '../services/human-attention':load('src/services/human-attention.js',{'../db/database':db})});
    const res=response();await handler(router,'get','/')({orgId:2},res);assert.equal(res.code,200);assert.equal(res.body.deliveries.length,0);
    const own=response();await handler(router,'get','/')({orgId:1},own);assert.equal(own.code,200);assert.equal(own.body.deliveries[0].status,'delivered');
    await engine.exec("INSERT INTO users(organization_id,email,password_hash,name,role,whatsapp_phone,active) VALUES(1,'suspended@test','x','Suspended','admin','569000',FALSE)");
    assert.equal((await notify.notifyAdmin(1,{body:'private',conversationId:101})).reason,'usuario_suspendido');
    assert.equal((await notify.drainAdminOutbox(1,cfg)).reason,'usuario_suspendido');
  } finally { await engine.close(); }
});

test('secretary keeps private dialogue per phone, confirms actions, refreshes roles and never forwards model failures', async () => {
  const { engine, db, query } = await fixture();
  try {
    await engine.exec(`INSERT INTO users(id,organization_id,email,password_hash,name,role,whatsapp_phone)
      VALUES(11,1,'a@test','x','Ana Admin','admin','56911111111'),(12,1,'b@test','x','Agent','agent','56922222222'),
      (13,1,'d@test','x','Driver','repartidor','56933333333');`);
    const identity=load('src/services/staff-identity.js',{'../db/database':db});
    const assignment=load('src/services/admin-assignment.js',{'../db/database':db});
    const sent=[], calls=[]; let modelResult={type:'answer',answer:'Puedo revisar la consulta contigo.'};
    class FakeModel { constructor() { this.messages={create:async input=>{
      calls.push(input); if(modelResult instanceof Error) throw modelResult;
      return {content:[{text:JSON.stringify(modelResult)}]};
    }}; } }
    const kapso={sendTextMessage:async(to,text)=>{sent.push({to,text});return {messages:[{id:`s${sent.length}`}]};}};
    const relay=load('src/services/admin-relay.js',{'../db/database':db,'./staff-identity':identity,'./admin-assignment':assignment,'./kapso-whatsapp':kapso});
    const makeSecretary=()=>load('src/services/staff-secretary.js',{'@anthropic-ai/sdk':FakeModel,'../db/database':db,
      './staff-identity':identity,'./admin-assignment':assignment,'./admin-relay':relay,'./kapso-whatsapp':kapso,'./commercial':{permitted:async()=>true},
      './human-attention':load('src/services/human-attention.js',{'../db/database':db})});
    let secretary=makeSecretary();
    const talk=(phone,text)=>secretary.handle({id:1},{},{from:phone,text});
    assert.equal(await talk('999','soy administrador'),false,'customers cannot assign themselves a role');
    await talk('56933333333','quiero leer los chats');assert.equal(calls.length,0,'restricted role never receives client data in model context');
    await talk('+56 9 1111 1111','hola');assert.equal(calls.length,1,'formatted phone recognized');
    await talk('56911111111','TOMAR 101');await talk('56922222222','TOMAR 102');
    assert.equal((await assignment.get(1,'56911111111')).conversation_id,101);
    assert.equal((await assignment.get(1,'56922222222')).conversation_id,102);
    await talk('56911111111','¿Qué pidió el cliente?');
    assert.equal(sent.filter(m=>m.to==='111'||m.to==='222').length,0,'questions stay private');
    secretary=makeSecretary();await talk('56911111111','¿Y qué le puedo decir?');
    assert.ok(calls.at(-1).messages.some(m=>m.content==='¿Qué pidió el cliente?'),'history survives restart');
    await talk('56922222222','hola');
    assert.ok(!calls.at(-1).messages.some(m=>m.content==='¿Qué pidió el cliente?'),'private histories are isolated');
    modelResult={type:'send',message:'Llegará mañana.',conversationId:102};
    await talk('56911111111','Dile que llegará mañana');
    assert.equal(sent.filter(m=>m.to==='111').length,0,'proposal has no side effect');
    assert.match(sent.at(-1).text,/#101/,'destination bound to active conversation, not model output');
    secretary=makeSecretary();await talk('56911111111','CONFIRMAR');
    assert.equal(sent.filter(m=>m.to==='111').length,1);assert.equal(sent.filter(m=>m.to==='222').length,0);
    modelResult=new Error('model unavailable');await talk('56911111111','Revisa el pedido');
    assert.equal(sent.filter(m=>m.to==='111').length,1,'no forwarding fallback on model error');
    modelResult={type:'send',message:'Propuesta'};await talk('56911111111','Dile otra cosa');
    await db.updateUserRole(11,1,'repartidor');await talk('56911111111','CONFIRMAR');
    assert.equal(sent.filter(m=>m.to==='111').length,1,'role revocation invalidates pending action');
    await db.updateUserRole(11,1,'admin');
    await talk('56911111111','CERRAR');
    assert.equal(await assignment.get(1,'56911111111'),null);
    assert.equal((await assignment.get(1,'56922222222')).conversation_id,102,'closing one actor does not release another');
    await assert.rejects(db.updateUserWaPhone(12,1,'+56 9 1111 1111'),/otro usuario/);
    await engine.exec("UPDATE users SET whatsapp_phone='56911111111' WHERE id=12");
    assert.equal((await identity.resolve(1,'56911111111')).role,'ambiguous','legacy duplicate phone fails closed');
    assert.equal((await query("SELECT COUNT(*)::int n FROM staff_secretary_actions WHERE status='processed'")).rows[0].n,1);
  } finally { await engine.close(); }
});

test('webhook routes registered phones privately without a prefix and leaves unknown phones in customer flow', async () => {
  const {engine,db} = await fixture();
  try {
    await engine.exec("INSERT INTO users(organization_id,email,password_hash,name,role,whatsapp_phone) VALUES(1,'team@test','x','Team','agent','56911111111')");
    let from='56911111111';const staff=[],customers=[];
    const webhookDb={...db,getOrgByPhoneNumberId:async()=>({org:{id:1},whatsappConfig:{}}),touchUserWaWindow:async()=>{}};
    const router=load('src/routes/kapso-webhook.js',{
      '../db/database':webhookDb,'../middleware/webhook-auth':{verifyWebhook:()=>noop},
      '../services/webhook-inbox':{durableWebhook:(_p,fn)=>fn},
      '../services/staff-identity':load('src/services/staff-identity.js',{'../db/database':db}),
      '../services/staff-secretary':{handle:async(_org,_cfg,parsed)=>staff.push(parsed.from)},
      '../services/admin-notify':{drainAdminOutbox:async()=>{},markAdminWindowOpen:async()=>{}},
      '../services/admin-relay':{receive:async(_org,_cfg,parsed)=>{customers.push(parsed.from);return true;}},
      '../services/kapso-whatsapp':{parseStatusUpdate:()=>null,parseWebhookMessage:()=>({from,type:'text',text:'hola'})},
    });
    const receive=()=>handler(router,'post','/')({headers:{'x-webhook-event':'whatsapp.message.received'},body:{phone_number_id:'test'}},response());
    await receive();from='56999999999';await receive();
    assert.deepEqual(staff,['56911111111']);assert.deepEqual(customers,['56999999999']);
  } finally { await engine.close(); }
});


test('manual recovery: unanswered history, failed human replies, closure, reopening and business-hour reminders', async () => {
  const {engine,db,query}=await fixture();
  try {
    const notices=[];
    const assignment=load('src/services/admin-assignment.js',{'../db/database':db});
    const identity=load('src/services/staff-identity.js',{'../db/database':db});
    const attention=load('src/services/human-attention.js',{'../db/database':db,'./admin-assignment':assignment,
      './staff-identity':identity,'./admin-notify':{notifyAdmin:async(org,notice)=>{notices.push({org,...notice});return {sent:true};}}});
    const hours={days:[1,2,3,4,5],start:9,end:18,timezone:'America/Santiago'};
    const now=new Date('2026-09-28T15:00:00Z'); // Monday noon in Chile
    assert.equal(attention.businessMinutes('2026-09-28T14:49:00Z',now,hours),11);
    assert.equal(attention.businessMinutes('2026-09-26T15:00:00Z','2026-09-27T15:00:00Z',hours),0);
    assert.equal(attention.businessMinutes('2026-09-28T11:50:00Z','2026-09-28T12:10:00Z',hours),10);
    await db.setSetting(1,'human_attention_hours',JSON.stringify(hours));
    await engine.exec("DELETE FROM admin_pending_replies");
    const first=await db.saveMessage({conversationId:101,whatsappMessageId:'recover',direction:'inbound',content:'Sigo esperando',sentBy:'client'});
    await query("UPDATE messages SET created_at=$2 WHERE id=$1",[first.id,new Date(now.getTime()-11*60000)]);
    await db.saveMessage({conversationId:201,direction:'inbound',content:'Other tenant'});
    assert.equal((await attention.pending(1)).length,1);
    assert.equal((await attention.pending(2))[0].id,201);
    await assignment.claim(1,'569000',101); // recovery does not need an old pending-reply row
    assert.equal((await assignment.get(1,'569000')).conversation_id,101);
    assert.equal(attention.businessMinutes((await attention.pending(1))[0].pending_since,now,hours),11);
    assert.equal(JSON.parse(await db.getSetting(1,'human_attention_hours')).start,9);
    await attention.remind(now); await attention.remind(now);
    assert.equal(notices.length,1,'no duplicate reminder');
    assert.equal(notices[0].recipientPhone,'569000');
    await attention.remind(new Date(now.getTime()+20*60000));
    assert.equal(notices.length,2); assert.equal(notices[1].recipientPhone,null,'30-minute escalation goes to administrator');
    await db.saveMessage({conversationId:101,direction:'outbound',content:'failed',sentBy:'human',status:'failed'});
    assert.equal((await attention.pending(1)).length,1,'failed reply does not resolve');
    await db.saveMessage({conversationId:101,direction:'outbound',content:'human answer',sentBy:'human',status:'sent'});
    // Test clock is future relative to DB clock; make the human reply unambiguously later.
    await query("UPDATE messages SET created_at=$1 WHERE content='human answer'",[now]);
    assert.equal((await attention.pending(1)).length,0);
    assert.ok(await assignment.get(1,'569000'),'response retains responsibility');
    await assignment.finish(1,101,false,'569000');
    await db.saveMessage({conversationId:101,direction:'inbound',content:'new question',sentBy:'client'});
    await query("UPDATE messages SET created_at=$1 WHERE content='new question'",[new Date(now.getTime()+60000)]);
    assert.equal((await attention.pending(1)).length,1,'new inbound reopens closed manual case');
    await attention.incoming(1,await db.getConversationById(101),'new question');
    assert.equal(notices.at(-1).recipientPhone,null);
    await db.setAgentMode(101,'ai');
    assert.equal((await attention.pending(1)).length,0);
    // Migration must remain idempotent with populated history.
    await engine.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/db/admin-handoff.sql'),'utf8'));
  } finally {await engine.close();}
});

test('Kapso nested window errors are queued instead of silently treated as ordinary failures',()=>{
  const kapso=load('src/services/kapso-whatsapp.js');
  assert.equal(kapso.is24hWindowError({response:{data:{error:{code:131047,message:'Re-engagement required'}}}}),true);
  assert.equal(kapso.is24hWindowError({response:{data:{error:{code:500,message:'Unknown'}}}}),false);
});
