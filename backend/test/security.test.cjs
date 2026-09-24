const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { load, handler, response, noop } = require('./helpers.cjs');
const authStub = { requireAuth:noop, requireRole:()=>noop };

test('JWT requires a configured strong secret',()=>{
  assert.throws(()=>load('src/middleware/auth.js',{}, {process:{env:{}}}), /JWT_SECRET/);
});
test('deleted users, changed roles and revoked versions reject old tokens',async()=>{
  let user = { id:1, organization_id:2, role:'admin', auth_version:0 };
  const auth=load('src/middleware/auth.js',{'../db/database':{getUserById:async()=>user}});
  const token=auth.generateToken(user);
  assert.equal((await auth.authenticateToken(token)).id,1);
  user={...user,auth_version:1}; await assert.rejects(()=>auth.authenticateToken(token));
  user={...user,auth_version:0,role:'agent'}; await assert.rejects(()=>auth.authenticateToken(token));
  user=null; await assert.rejects(()=>auth.authenticateToken(token));
});
test('coordinator can use warehouse but not adjacent settings paths',async()=>{
  const user={id:1,organization_id:1,role:'coordinador'};
  const auth=load('src/middleware/auth.js',{'../db/database':{getUserById:async()=>user}});
  const token=auth.generateToken(user);
  for(const [url,allowed] of [['/api/settings/warehouse',true],['/api/settings/warehouse-credentials',false]]) {
    const req={headers:{authorization:'Bearer '+token},query:{},originalUrl:url,path:'/warehouse',method:'GET'},res=response();let pass=false;
    await auth.requireAuth(req,res,()=>{pass=true}); assert.equal(pass,allowed);
    if(pass){const router=load('src/routes/settings.js',{'../middleware/auth':auth});let rolePass=false;router.stack[1].handle(req,res,()=>{rolePass=true});assert.ok(rolePass);}
  }
});
test('socket derives tenant from authenticated user and rejects anonymous/driver',async()=>{
  let middleware,onConnect,joined;
  const service=load('src/services/socket-auth.js',{'../middleware/auth':{authenticateToken:async token=>{
    if(!token)throw Error();return {id:1,organization_id:2,role:token==='driver'?'repartidor':'admin'};
  }}});
  service.configureSocketAuth({use:fn=>{middleware=fn},on:(name,fn)=>{onConnect=fn}});
  for(const token of [undefined,'driver','admin']) {
    const socket={handshake:{auth:{token,orgId:999}},data:{},join:room=>{joined=room},on(){}};let error;
    await middleware(socket,e=>{error=e});assert.equal(!!error,token!=='admin');
    if(!error){onConnect(socket);assert.equal(joined,'org_2');}
  }
});
test('HMAC verifies exact bytes and fails closed for malformed/missing signatures',()=>{
  const {validHmac}=load('src/middleware/webhook-auth.js');
  const raw=Buffer.from('{ "text": "hola" }'),secret='secret';
  const sig=crypto.createHmac('sha256',secret).update(raw).digest('hex');
  assert.ok(validHmac(raw,sig,secret));
  assert.ok(!validHmac(Buffer.from('{"text":"hola"}'),sig,secret));
  for(const bad of ['',null,'x',{},'f'.repeat(64)])assert.ok(!validHmac(raw,bad,secret));
  assert.ok(!validHmac(raw,sig,''));
});
test('Kapso missing or incorrect signature cannot reach processing',async()=>{
  const config={provider:'kapso',webhook_secret:'secret'};
  const module=load('src/middleware/webhook-auth.js',{'../db/database':{getOrgByPhoneNumberId:async()=>({org:{id:1},whatsappConfig:config})}});
  const raw=Buffer.from('{"phone_number_id":"1"}');
  for(const signature of ['', 'invalid',crypto.createHmac('sha256','secret').update(raw).digest('hex')]){
    const req={body:JSON.parse(raw),rawBody:raw,headers:{'x-webhook-signature':signature}},res=response();let processed=false;
    await module.verifyWebhook('kapso')(req,res,()=>{processed=true});assert.equal(processed,signature.length===64);
  }
});
test('media blocks private IPs and strips credential on untrusted/redirect targets',async()=>{
  const calls=[];let privateIp=false;
  const service=load('src/services/safe-media.js',{
    'node:dns':{promises:{lookup:async()=>[{address:privateIp?'127.0.0.1':'8.8.8.8',family:4}]}},
    axios:{get:async(url,opts)=>{calls.push({url,opts});return {status:200,data:Buffer.from('test'),headers:{'content-type':'image/png'}}}},
  });
  await service.downloadMedia('https://audit.invalid/?tag=kapso.ai',{kapso_api_key:'fake'});
  assert.equal(calls[0].opts.headers['X-API-Key'],undefined);
  await service.downloadMedia('https://api.kapso.ai/image',{kapso_api_key:'fake'});
  assert.equal(calls[1].opts.headers['X-API-Key'],'fake');
  assert.equal(calls[1].opts.maxRedirects,0);assert.equal(calls[1].opts.maxContentLength,10485760);
  privateIp=true;await assert.rejects(()=>service.downloadMedia('https://localhost/image'),/no público/);
  assert.equal(calls.length,2);
});
test('media proxy rejects foreign reference before lookup, cache or transport',async()=>{
  let accessed=false;
  const db={getWhatsappConfig:async()=>({kapso_api_key:'fake'}),getPool:()=>({query:async()=>({rows:[]})})};
  const router=load('src/routes/conversations.js',{'../db/database':db,'../middleware/auth':authStub,
    '../services/media-cache':{get(){accessed=true}},'../services/kapso-whatsapp':{getMediaUrl(){accessed=true}}});
  const res=response();await handler(router,'get','/media/ref')({orgId:1,params:{mediaRef:'123'}},res);
  assert.equal(res.code,404);assert.equal(accessed,false);
});
test('store rejects negative, fractional, zero and oversized quantities before writes',async()=>{
  let writes=0;
  const db={getPool:()=>({query:async()=>({rows:[{id:1}]})}),getProducts:async()=>[{id:1,price:100}],upsertConversation:async()=>{writes++;return {id:1}},createOrder:async()=>({id:1}),upsertContact:async()=>{},getWhatsappConfig:async()=>null,getSetting:async()=>null};
  const router=load('src/routes/store.js',{'../db/database':db});
  for(const quantity of [-2,0,1.5,1001,'2']){
    const res=response();await handler(router,'post','/test/orders')({params:{slug:'test'},body:{name:'Test',phone:'56912345678',address:'Test',items:[{productId:1,quantity}]}},res);assert.equal(res.code,400);
  }
  assert.equal(writes,0);
  const res=response();await handler(router,'post','/test/orders')({params:{slug:'test'},body:{name:'Test',phone:'56912345678',address:'Test',items:[{productId:1,quantity:2}]}},res);assert.equal(res.code,201);assert.equal(res.body.total,200);
});
test('order-items reaches the literal route, numeric IDs still work',()=>{
  const router=load('src/routes/orders.js',{'../middleware/auth':authStub});
  assert.equal(router.stack.find(l=>l.route?.methods.get && l.match('/order-items')).route.path,'/order-items');
  assert.equal(router.stack.find(l=>l.route?.methods.get && l.match('/123')).route.path,'/:id(\\d+)');
});
test('malformed OAuth HMAC returns a controlled redirect',async()=>{
  const router=load('src/routes/shopify-oauth.js',{'../middleware/auth':authStub});const res=response();
  await handler(router,'get','/callback')({query:{code:'fake',shop:'audit.myshopify.com',hmac:'x',state:'fake'}},res);
  assert.match(res.location,/invalid_hmac/);
});

test('durable inbox rejects delivery when PostgreSQL persistence fails',async()=>{
  const inbox=load('src/services/webhook-inbox.js',{'../db/database':{getPool:()=>({query:async()=>{throw Error('offline')}})}});
  let called=false;const receive=inbox.durableWebhook('test',async()=>{called=true});const res=response();
  await receive({webhookOrg:{id:1},params:{},headers:{},rawBody:Buffer.from('{}'),body:{}},res);
  assert.equal(res.code,503);assert.equal(called,false);
});
