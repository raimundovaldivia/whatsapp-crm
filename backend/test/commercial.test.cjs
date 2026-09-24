const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const { load, response } = require('./helpers.cjs');
const catalog = require('../src/services/solution-catalog');
async function fixture() {
  const engine = new PGlite();
  const query = async(sql,params) => {const r=params?.length?await engine.query(sql,params):(await engine.exec(sql)).at(-1);return {...r,rowCount:r.rows?.length || r.affectedRows || 0};};
  let tail=Promise.resolve();
  const pool={query,async connect(){let release;const previous=tail;tail=new Promise(r=>release=r);await previous;return {query,release};}};
  await engine.exec(`CREATE TABLE organizations(id SERIAL PRIMARY KEY,name TEXT,slug TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE users(id SERIAL PRIMARY KEY,organization_id INTEGER,email TEXT UNIQUE,password_hash TEXT,name TEXT,role TEXT);
    INSERT INTO organizations VALUES(1,'Existing shop','existing',NOW());
    INSERT INTO users VALUES(1,1,'operator@example.test','hash','Operator','owner');`);
  const migration=fs.readFileSync(path.join(__dirname,'../src/db/commercial.sql'),'utf8');
  await engine.exec(migration);
  await engine.exec("INSERT INTO organizations VALUES(2,'New shop','new',NOW()); INSERT INTO users VALUES(2,2,'tenant@example.test','hash','Tenant','owner'); SELECT setval('users_id_seq',2);");
  await engine.exec(migration);
  const db={getPool:()=>pool,getSetting:async()=>null,getOrgById:async id=>(await query('SELECT * FROM organizations WHERE id=$1',[id])).rows[0]};
  const service=load('src/services/commercial.js',{'../db/database':db,'./solution-catalog':catalog},{process:{env:{PLATFORM_ADMIN_USER_IDS:'1'}}});
  return {engine,query,pool,db,service};
}
const contract = overrides => ({status:'active',modules:['orders','sales_ai'],limits:{bot_turns:2,seats:2},expires_at:null,revision:0,reason:'Contrato de prueba acordado',...overrides});
test('migration preserves existing access exactly once; new shops fail closed and UI preferences cannot grant modules',async()=>{
 const f=await fixture();try {
  assert.equal(await f.service.permitted(1,'sales_ai'),true);
  assert.equal(await f.service.permitted(2,'sales_ai'),false);
  assert.equal(await f.service.permitted(1,'unknown'),false);
  const flags=await f.service.effectiveFlags(2);assert.equal(flags.orders,false);assert.equal(flags.clientes,true);
  await f.service.updateContract(2,1,contract());
  assert.equal(await f.service.permitted(2,'sales_ai'),true);
  assert.equal(await f.service.permitted(2,'payments'),false);
  await f.query("UPDATE commercial_contracts SET expires_at=NOW()-INTERVAL '1 second' WHERE organization_id=2");
  assert.equal(await f.service.permitted(2,'orders'),false);
  assert.equal((await f.service.effectiveFlags(2)).orders,false);
 }finally{await f.engine.close();}
});
test('contract validation, optimistic concurrency, request approval and audit are atomic',async()=>{
 const f=await fixture();try {
  await assert.rejects(()=>f.service.updateContract(2,1,contract({modules:['sales_ai']})),/requiere/);
  await assert.rejects(()=>f.service.updateContract(2,1,contract({status:'trial'})),/vencimiento/);
  await assert.rejects(()=>f.service.updateContract(2,1,contract({limits:{bot_turns:-1,seats:2}})),/Límites/);
  await f.query("INSERT INTO commercial_requests(organization_id,module_key,requested_by) VALUES(2,'sales_ai',2),(2,'payments',2)");
  const active=await f.service.updateContract(2,1,contract());assert.equal(active.revision,1);
  const requests=(await f.query('SELECT module_key,status FROM commercial_requests ORDER BY id')).rows;
  assert.equal(requests[0].status,'approved');assert.equal(requests[1].status,'pending');
  await assert.rejects(()=>f.service.updateContract(2,1,contract()),/Recarga/);
  assert.equal((await f.query('SELECT * FROM commercial_audit')).rows.length,1);
  await f.service.updateContract(2,1,contract({status:'suspended',revision:1}));
  assert.equal(await f.service.permitted(2,'orders'),false);
  assert.equal((await f.query('SELECT * FROM commercial_audit')).rows.length,2);
 }finally{await f.engine.close();}
});
test('concurrent bot turns and seat creation respect quotas and tenant boundaries',async()=>{
 const f=await fixture();try {
  await f.service.updateContract(2,1,contract());
  const attempts=await Promise.allSettled(Array.from({length:6},()=>f.service.consumeBotTurn(2)));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,2);
  assert.equal((await f.service.summary(2)).usage.bot_turns,2);
  await f.service.consumeBotTurn(1);assert.equal((await f.service.summary(1)).usage.bot_turns,1);
  const users=await Promise.allSettled([1,2].map(n=>f.service.createUserWithinLimit({organizationId:2,email:`new${n}@test.local`,passwordHash:'hash',name:'Staff',role:'agent'})));
  assert.equal(users.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await f.service.summary(2)).usage.seats,2);
 }finally{await f.engine.close();}
});
test('HTTP access: tenant admin cannot alter contracts, spoof tenant, or call unpaid modules; operator approvals succeed',async()=>{
 const f=await fixture();let server;
 try {
  const auth={requireAuth(req,res,next){const id=Number(req.headers['x-test-user']);if(![1,2].includes(id))return res.status(401).json({error:'auth'});req.userId=id;req.orgId=id;req.role='owner';next();},requireRole:()=>((_q,_r,n)=>n())};
  const deps={'../db/database':f.db,'../services/commercial':f.service,'../services/solution-catalog':catalog,'../middleware/auth':auth,'./auth':auth};
  const router=load('src/routes/commercial.js',deps);
  const gate=load('src/middleware/commercial-access.js',deps);
  const app=express();app.use(express.json());app.use('/api/commercial',router);app.use('/api',gate.commercialAccess);app.get('/api/orders',(_q,r)=>r.json({ok:true}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  async function call(url,user=2,body,method=body?'POST':'GET'){const r=await fetch(base+url,{method,headers:{'x-test-user':String(user),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
  assert.equal((await call('/api/commercial/catalog',0)).status,200);
  assert.equal((await call('/api/commercial/me',0)).status,401);
  assert.equal((await call('/api/commercial/admin/organizations',2)).status,403);
  assert.equal((await call('/api/commercial/admin/organizations/1/contract',2,contract(),'PUT')).status,403);
  assert.equal((await call('/api/orders',2)).status,403);
  await call('/api/commercial/requests',2,{module:'orders',organization_id:1});
  await call('/api/commercial/requests',2,{module:'orders'});
  const requests=(await f.query('SELECT * FROM commercial_requests')).rows;assert.equal(requests.length,1);assert.equal(requests[0].organization_id,2);
  assert.equal((await call('/api/commercial/admin/organizations/2/contract',1,contract(),'PUT')).status,200);
  assert.equal((await call('/api/orders',2)).status,200);
  assert.equal((await call('/api/commercial/me?organization_id=1',2)).data.contract.organization_id,2);
  assert.equal((await call('/api/commercial/me',2)).data.platformAdmin,false);
 }finally{if(server)await new Promise(r=>server.close(r));await f.engine.close();}
});
test('tenant settings cannot enable an uncontracted module; suspended pipeline does not call AI',async()=>{
 let wrote=false;
 const commercial={effectiveFlags:async()=>({orders:false}),permitted:async()=>false,consumeBotTurn:async()=>{throw Object.assign(Error('paused'),{status:403});}};
 const auth={requireAuth:(_q,_r,n)=>n(),requireRole:()=>((_q,_r,n)=>n())};
 const settings=load('src/routes/settings.js',{'../services/commercial':commercial,'../services/solution-catalog':catalog,'../middleware/auth':auth,'../db/database':{setSetting:async()=>{wrote=true;}}});
 const {handler}=require('./helpers.cjs');const res=response();await handler(settings,'put','/modules')({orgId:2,body:{modules:{orders:true}}},res);assert.equal(res.code,403);assert.equal(wrote,false);
 const pipeline=load('src/services/pipeline.js',{'./commercial':commercial});
 assert.equal((await pipeline.processMessage(2,1,'test')).skipped,true);
});
test('WhatsApp assistant never executes model-generated SQL or grants operators from tenant roles',async()=>{
 let query=false,sent='';
 class AI {messages={create:async()=>({content:[{text:JSON.stringify({action:'sql',query:'SELECT * FROM users'})}]})};}
 const commands=load('src/services/agent-commands.js',{'@anthropic-ai/sdk':AI,'../db/database':{getPool:()=>({query:async()=>{query=true;}})},'./commercial':{permitted:async()=>true},'./kapso-whatsapp':{sendTextMessage:async(_phone,text)=>{sent=text;}}});
 await commands.handleAgentCommand({id:1},{},{role:'owner',whatsapp_phone:'test'},'query');assert.equal(query,false);assert.match(sent,/consultas libres/);
 sent='';await commands.handleAgentCommand({id:1},{},{role:'repartidor'},'query');assert.equal(sent,'');
 const service=load('src/services/commercial.js',{'./solution-catalog':catalog},{process:{env:{}}});assert.equal(service.isPlatformAdmin(1),false);
});
