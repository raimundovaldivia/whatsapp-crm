const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {load,handler,response,noop}=require('./helpers.cjs');
test('returns preserve orders, enforce assigned driver and quantities, and record cash once',async()=>{
 const engine=new PGlite();
 const query=async(sql,params)=>{const r=params?.length?await engine.query(sql,params):(await engine.exec(sql)).at(-1);return {...r,rowCount:r.affectedRows??r.rows?.length??0};};
 class Pool{query(...args){return query(...args)}async connect(){return {query,release(){}}}async end(){}}
 try{
  await load('src/db/setup.js',{pg:{Pool}}).setupDatabase();
  await load('src/db/setup.js',{pg:{Pool}}).setupDatabase();
  await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
   INSERT INTO users(id,organization_id,email,password_hash,name,role) VALUES(1,1,'a@a','x','Admin','admin'),(2,1,'b@a','x','Driver','repartidor'),(3,2,'c@a','x','Other','repartidor');
   INSERT INTO orders(id,organization_id,items,total_price,status,customer_name) VALUES(1,1,'[{"name":"Queso","quantity":2,"price":12000}]','24000','entregado','Ana');`);
  const router=load('src/routes/order-returns.js',{'../db/database':{getPool:()=>new Pool()},'../middleware/auth':{requireRole:()=>noop}});
  const request=async(method,path,body={},role='admin',orgId=1,userId=1)=>{const res=response();await handler(router,method,path)({body,role,orgId,userId,params:{id:'1'},query:{}},res);return res;};
  const original=(await engine.query('SELECT * FROM orders WHERE id=1')).rows[0];
  const body={source:'bot',orderId:'1',kind:'exchange',reason:'Producto dañado',replacementDescription:'1 queso',pickupRequired:true,items:[{index:0,quantity:1}],moneyDirection:'refund',moneyMethod:'efectivo',moneyAmount:1000,requestKey:'unique-request-111'};
  let r=await request('post','/',body);assert.equal(r.code,201,JSON.stringify(r.body));
  r=await request('post','/',body);assert.equal(r.body.case.id,1);
  r=await request('post','/',{...body,requestKey:'unique-request-222',items:[{index:0,quantity:2}]});assert.equal(r.code,400);
  r=await request('post','/1/actions',{action:'approve'},'repartidor',1,2);assert.equal(r.code,403);
  assert.equal((await request('post','/1/actions',{action:'approve'})).code,200);
  assert.equal((await request('post','/1/actions',{action:'schedule',date:'2026-10-07',driverId:3})).code,400);
  assert.equal((await request('post','/1/actions',{action:'schedule',date:'2026-10-07',driverId:2})).code,200);
  assert.equal((await request('post','/1/actions',{action:'start'},'repartidor',2,3)).code,404);
  r=await request('post','/1/actions',{action:'start'},'repartidor',1,2);assert.equal(r.code,200);
  assert.equal((await request('post','/1/actions',{action:'complete'},'repartidor',1,2)).code,400);
  assert.equal((await request('post','/1/actions',{action:'complete',pickedUp:true,replaced:true,moneyConfirmed:true},'repartidor',1,2)).code,200);
  r=await request('post','/1/actions',{action:'complete',pickedUp:true,replaced:true,moneyConfirmed:true},'repartidor',1,2);assert.equal(r.code,409);
  const movements=(await engine.query('SELECT * FROM return_money_movements')).rows;assert.equal(movements.length,1);assert.equal(movements[0].amount,-1000);
  const updated=(await engine.query('SELECT * FROM order_returns')).rows[0];assert.equal(updated.status,'resolved');assert.equal(updated.inventory_status,'pending_review');
  const {report}=require('../src/services/cash-register');const today=new Date().toLocaleDateString('sv-SE',{timeZone:'America/Santiago'});
  const cash=await report({query},1,today,today);assert.equal(cash.adjustments,-1000);
  assert.deepEqual((await engine.query('SELECT * FROM orders WHERE id=1')).rows[0],original);
  r=await request('get','/',{},'repartidor',2,3);assert.equal(r.body.cases.length,0);
  assert.equal((await request('post','/1/actions',{action:'inventory',disposition:'discarded',note:'Daño confirmado'})).code,200);
 }finally{await engine.close();}
});
