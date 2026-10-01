const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {load}=require('./helpers.cjs');
test('template acceptance is pending, failure details survive reload and stale receipts cannot hide failure',async()=>{
 const engine=new PGlite();
 const query=async(sql,params)=>{const r=params?.length?await engine.query(sql,params):(await engine.exec(sql)).at(-1);return {...r,rowCount:r.affectedRows??r.rows?.length??0};};
 class Pool{query(...args){return query(...args)} async connect(){return {query,release(){}}} async end(){}}
 try{
 const setup=load('src/db/setup.js',{pg:{Pool}});await setup.setupDatabase();await setup.setupDatabase();
 await engine.exec("INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b'); INSERT INTO conversations(id,organization_id,phone_number) VALUES(1,1,'111');");
 const db=load('src/db/database.js',{pg:{Pool}});
 const m=await db.saveMessage({conversationId:1,whatsappMessageId:'wamid.test',direction:'outbound',content:'[Template: test]',sentBy:'human'});
 assert.equal(m.status,'pending');
 assert.equal(await db.updateMessageStatus('wamid.test','failed',[{code:131042}],2),null);
 const failure=await db.updateMessageStatus('wamid.test','failed',[{code:131042,error_data:{details:'Business eligibility payment issue'}}],1);
 assert.equal(failure.status,'failed');assert.equal(failure.delivery_error.code,131042);
 assert.equal(await db.updateMessageStatus('wamid.test','sent',null,1),null);
 assert.equal((await db.getMessagesByConversation(1))[0].delivery_error.message,'Business eligibility payment issue');
 await db.saveMessage({conversationId:1,whatsappMessageId:'wamid.ok',direction:'outbound',content:'[Template: ok]'});
 assert.equal((await db.updateMessageStatus('wamid.ok','delivered',null,1)).status,'delivered');
 assert.equal(await db.updateMessageStatus('wamid.ok','sent',null,1),null);
 assert.equal((await db.updateMessageStatus('wamid.ok','read',null,1)).status,'read');
 await engine.exec(`INSERT INTO messages(conversation_id,whatsapp_message_id,direction,content,agent_type,status,created_at) VALUES
   (1,'historic-fail','outbound','charge','cobranza','failed',NOW()-INTERVAL '1 day');
   INSERT INTO orders(id,organization_id,conversation_id,customer_phone,items,total_price,status,payment_method,charge_requested_at) VALUES
   (1,1,1,'111','[]',100,'entregado','transferencia',NOW()-INTERVAL '1 day'+INTERVAL '1 second'),
   (2,1,1,'111','[]',100,'entregado','transferencia',NOW()-INTERVAL '1 day'+INTERVAL '1 second');`);
 await setup.setupDatabase();
 assert.ok((await query('SELECT charge_message_id FROM orders')).rows.every(o=>o.charge_message_id===null),'ambiguous history must not be linked');
 await query("UPDATE orders SET charge_requested_at=NOW()-INTERVAL '2 days' WHERE id=2");
 await setup.setupDatabase();
 assert.equal((await query('SELECT charge_message_id FROM orders WHERE id=1')).rows[0].charge_message_id,'historic-fail');
 const collection=load('src/services/payment-collection.js',{'../db/database':db});
 const charges=await collection.getPendingCharges(1);
 assert.equal(charges.find(o=>o.id==='1').charge_status,'failed');
 assert.equal(charges.find(o=>o.id==='2').charge_status,null);
 assert.equal(charges.find(o=>o.id==='1').conversation_id,'1');
 assert.ok(Array.isArray(charges.find(o=>o.id==='1').items));
 assert.equal(charges.find(o=>o.id==='1').client_type,'personal');
 assert.equal(charges.find(o=>o.id==='1').tax_document_type,'boleta');
 await query("INSERT INTO orders(id,organization_id,conversation_id,customer_phone,items,total_price,status,payment_method) VALUES (3,1,1,'111','[]',0,'entregado','transferencia')");
 assert.equal((await collection.getPendingCharges(1)).some(o=>o.id==='3'),false,'zero-value orders are not debt');
 await query("INSERT INTO payment_proofs(id,organization_id,conversation_id,order_id,media_id,status) VALUES (100,1,1,1,'voucher-pending','pending')");
 const waitingProof=(await collection.getPendingCharges(1)).find(o=>o.id==='1');
 assert.equal(waitingProof.proof_id,100);
 assert.equal(waitingProof.proof_status,'pending');
 assert.equal(waitingProof.proofs_pending,1);
 assert.equal(await collection.getOrderForCharge(1,'bot','1'),null,'a debt with a voucher under review cannot be charged again');
 await query("INSERT INTO orders(id,organization_id,conversation_id,customer_phone,items,total_price,status,payment_method) VALUES (4,1,1,'111','[]',100,'entregado','transferencia'); INSERT INTO payment_proofs(id,organization_id,conversation_id,order_id,media_id,status) VALUES (101,1,1,4,'voucher-approved','verified')");
 assert.equal((await collection.getPendingCharges(1)).some(o=>o.id==='4'),false,'an approved voucher closes the debt');
 await query("INSERT INTO messages(conversation_id,whatsapp_message_id,direction,content,agent_type,status,created_at) SELECT 1,'historic-unknown','outbound','charge','cobranza','sent',charge_requested_at-INTERVAL '1 second' FROM orders WHERE id=2");
 let reads=0;
 const reconcile=load('src/services/payment-collection.js',{'../db/database':{...db,getWhatsappConfig:async()=>({provider:'kapso'})},'./commercial':{permitted:async()=>true},'./kapso-whatsapp':{getMessageStatus:async id=>{reads++;return {messageId:id,status:'failed',error:[{code:131042}]}}}});
 const recovered=await reconcile.reconcileCharges(1,[{source:'bot',id:'2'},{source:'bot',id:'999'}]);
 assert.equal(reads,1);assert.equal(recovered[0].status,'failed');assert.equal(recovered[1].status,'unknown');
 assert.equal((await collection.getPendingCharges(1)).find(o=>o.id==='2').charge_status,'failed');


 }finally{await engine.close()}
});
test('Kapso and Meta preserve provider errors; templates reject missing acceptance and expose immediate billing errors',async()=>{
 const kapso=load('src/services/kapso-whatsapp.js',{axios:{post:async()=>({data:{messages:[{id:'wamid.ok'}]}})}});
 const e=kapso.parseStatusUpdate({message:{id:'x',kapso:{statuses:[{status:'sent'},{status:'failed',errors:[{code:131042}]}]}}},'whatsapp.message.failed');
 assert.equal(e.status,'failed');assert.equal(e.error[0].code,131042);
 const meta=load('src/services/whatsapp.js');
 assert.equal(meta.parseStatusUpdate({entry:[{changes:[{value:{statuses:[{id:'x',status:'failed',errors:[{code:131042}]}]}}]}]}).error[0].code,131042);
 const config={phone_number_id:'test',kapso_api_key:'fake'};
 assert.equal((await kapso.sendTemplate('111','test','es',[],config)).messages[0].id,'wamid.ok');
 const invalid=load('src/services/kapso-whatsapp.js',{axios:{post:async()=>({data:{}})}});
 await assert.rejects(()=>invalid.sendTemplate('111','test','es',[],config),/no confirmó/);
 const denied=load('src/services/kapso-whatsapp.js',{axios:{post:async()=>{const e=new Error('HTTP 400');e.response={data:{error:{code:131042,message:'Business eligibility payment issue'}}};throw e;}}});
 await assert.rejects(()=>denied.sendTemplate('111','test','es',[],config),/131042.*facturación/);
});
test('Kapso webhook registration includes every delivery state',async()=>{
 let request;
 const platform=load('src/services/kapso-platform.js',{axios:{create:()=>({post:async(url,body)=>{request={url,body};return {data:{data:{id:'hook'}}}}})}},{process:{env:{KAPSO_API_KEY:'test'}}});
 await platform.registerNumberWebhook('phone-1','https://example.test/kapso-webhook','secret');
 assert.equal(request.url,'/whatsapp/phone_numbers/phone-1/webhooks');
 assert.deepEqual(Array.from(request.body.whatsapp_webhook.events),[
  'whatsapp.message.received','whatsapp.message.sent','whatsapp.message.delivered','whatsapp.message.read','whatsapp.message.failed'
 ]);
});
test('pending Kapso templates recover their provider status without guessing failures',async()=>{
 const updates=[];let reads=0;
 const recovery=load('src/services/message-status-recovery.js',{
  '../db/database':{updateMessageStatus:async(...args)=>{updates.push(args);return {whatsapp_message_id:args[0],status:args[1]}}},
  './kapso-whatsapp':{getMessageStatus:async id=>{reads++;return id.endsWith('failed')?{status:'failed',error:[{code:131042}]}:null}},
 });
 const old=new Date(Date.now()-60000).toISOString();
 const messages=[
  {direction:'outbound',status:'pending',whatsapp_message_id:'wamid.failed',created_at:old},
  {direction:'outbound',status:'pending',whatsapp_message_id:'reeng_local',created_at:old},
  {direction:'outbound',status:'pending',whatsapp_message_id:'wamid.unknown',created_at:old},
  {direction:'outbound',status:'pending',whatsapp_message_id:'wamid.too-new',created_at:new Date().toISOString()},
 ];
 const recovered=await recovery.reconcilePendingMessages(7,messages,{provider:'kapso'});
 assert.equal(reads,2);
 assert.equal(updates.length,1);
 assert.deepEqual(Array.from(updates[0]).slice(0,2),['wamid.failed','failed']);
 assert.equal(updates[0][3],7);
 assert.equal(recovered[0].status,'failed');
 assert.equal(await recovery.reconcilePendingMessages(7,messages,{provider:'meta'}).then(x=>x.length),0);
});
test('collection retries confirmed failures and blocks pending, unknown and concurrent sends',async()=>{
 let current={source:'bot',id:'1',customer_phone:'111',total_price:100,order_label:'#1',charge_requested_at:new Date(),charge_status:'pending'};
 let sends=0,saved,registered,locked=true;
 const pool={connect:async()=>({query:async()=>({rows:[{locked}]}),release(){}}),query:async(sql,args)=>{
 if(sql.includes('UNION ALL'))return {rows:[current]};
 if(sql.includes('UPDATE orders')){registered=args;current={...current,charge_status:'pending'};return {rows:[]}};
 throw Error('Unexpected query');}};
 const db={getPool:()=>pool,getWhatsappConfig:async()=>({provider:'kapso'}),getSetting:async()=>null,upsertConversation:async()=>({id:1}),saveMessage:async m=>{saved=m;return m},updateConversationLastMessage:async()=>{}};
 const service=load('src/services/payment-collection.js',{'../db/database':db,'./commercial':{permitted:async()=>true},'./kapso-whatsapp':{sendTextMessage:async()=>{sends++;return {messages:[{id:'wamid.charge'}]}}}});
 assert.equal((await service.sendChargeRequest(1,current,{force:true})).reason,'envio_pendiente');
 current={...current,charge_status:null};assert.equal((await service.sendChargeRequest(1,current,{force:true})).reason,'envio_sin_verificar');
 current={...current,charge_status:'failed'};const stale=current;
 assert.equal((await service.sendChargeRequest(1,current)).status,'pending');
 assert.equal(saved.status,'pending');assert.equal(registered[2],'wamid.charge');assert.equal(sends,1);
 assert.equal((await service.sendChargeRequest(1,stale)).reason,'envio_pendiente');assert.equal(sends,1);
 locked=false;assert.equal((await service.sendChargeRequest(1,current)).reason,'envio_en_curso');
});
