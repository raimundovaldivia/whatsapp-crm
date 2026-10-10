const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');
async function fixture() {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const r = params?.length ? await engine.query(sql,params) : (await engine.exec(sql)).at(-1);
    return {...r,rowCount:r.affectedRows ?? r.rows?.length ?? 0};
  };
  let tail=Promise.resolve();
  class Pool {
    query(...args){return query(...args)}
    async connect(){let release;const prev=tail;tail=new Promise(r=>{release=r});await prev;return {query,release};}
    async end(){}
  }
  const pool=new Pool();
  await load('src/db/setup.js',{pg:{Pool}}).setupDatabase();
  await load('src/db/setup.js',{pg:{Pool}}).setupDatabase();
  await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
    INSERT INTO users(id,organization_id,email,password_hash,role) VALUES(10,1,'driver','test','repartidor'),(11,1,'other','test','repartidor');
    INSERT INTO conversations(id,organization_id,phone_number) VALUES(1,1,'111'),(2,1,'222'),(3,2,'333');
    INSERT INTO orders(id,organization_id,conversation_id,items,total_price,status) VALUES(1,1,1,'[]','100','sent'),(2,1,2,'[]','200','sent');
    INSERT INTO shopify_orders(organization_id,shopify_order_id) VALUES(1,'gid://shopify/Order/42');
    INSERT INTO delivery_routes(id,organization_id,name,status,driver_user_id,orders) VALUES
    (1,1,'Own','in_progress',10,'[{"source":"bot","id":1}]'),
    (2,1,'Other','sent',11,'[{"source":"bot","id":2}]'),
    (3,1,'Shopify','in_progress',10,'[{"source":"shopify","id":"gid://shopify/Order/42"}]');`);
  const db={getPool:()=>pool};
  return {engine,query,pool,db};
}
test('delivery: member and assignment checks, missing/completed orders, rollback and Shopify payment',async()=>{
  const f=await fixture();
  try {
    const router=load('src/routes/delivery.js',{'../db/database':f.db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});
    const call=async(routeId,stopKey,extra={})=>{const res=response();await handler(router,'patch','/routes/1/stops')({orgId:1,userId:10,role:'repartidor',params:{id:String(routeId)},body:{stopKey,status:'entregado',paymentMethod:'efectivo',...extra}},res);return res;};
    assert.equal((await call(1,'bot_2')).code,404);
    assert.equal((await call(2,'bot_2')).code,404);
    assert.equal((await f.query('SELECT status FROM orders WHERE id=2')).rows[0].status,'sent');
    await f.query("UPDATE delivery_routes SET orders='[{\"source\":\"bot\",\"id\":999}]' WHERE id=1");
    assert.equal((await call(1,'bot_999')).code,404);
    await f.query("UPDATE delivery_routes SET orders='[{\"source\":\"bot\",\"id\":1}]' WHERE id=1");
    await f.engine.exec(`CREATE FUNCTION audit_reject_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER audit_reject BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION audit_reject_order();`);
    assert.equal((await call(1,'bot_1')).code,500);
    assert.deepEqual((await f.query('SELECT stop_statuses FROM delivery_routes WHERE id=1')).rows[0].stop_statuses,{});
    await f.engine.exec('DROP TRIGGER audit_reject ON orders');
    assert.equal((await call(1,'bot_1')).code,200);
    assert.equal((await f.query('SELECT status FROM orders WHERE id=1')).rows[0].status,'paid');
    assert.equal((await call(1,'bot_1')).code,409);
    assert.equal((await call(3,'shopify_gid://shopify/Order/42')).code,200);
    assert.equal((await f.query('SELECT financial_status FROM shopify_orders')).rows[0].financial_status,'paid');
  } finally {await f.engine.close();}
});
test('driver can persist a manual route order without adding or losing stops',async()=>{
  const f=await fixture();
  try {
    await f.query(`UPDATE delivery_routes
      SET orders=$1, optimized_route=$2
      WHERE id=1`,[
      JSON.stringify([{source:'bot',id:1,customerName:'Uno'},{source:'bot',id:2,customerName:'Dos'}]),
      JSON.stringify([{source:'bot',id:1,customerName:'Uno',stopNumber:1},{source:'bot',id:2,customerName:'Dos',stopNumber:2}]),
    ]);
    const router=load('src/routes/delivery.js',{'../db/database':f.db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});

    const reordered=response();
    await handler(router,'patch','/routes/1/reorder')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKeys:['bot_2','bot_1']}},reordered);
    assert.equal(reordered.code,200);
    assert.deepEqual(reordered.body.optimizedRoute.map(stop=>[stop.id,stop.stopNumber]),[[2,1],[1,2]]);
    let stored=(await f.query('SELECT orders,optimized_route FROM delivery_routes WHERE id=1')).rows[0];
    assert.deepEqual(stored.orders.map(stop=>stop.id),[2,1]);
    assert.deepEqual(stored.optimized_route.map(stop=>stop.stopNumber),[1,2]);

    const stale=response();
    await handler(router,'patch','/routes/1/reorder')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKeys:['bot_1']}},stale);
    assert.equal(stale.code,409);
    stored=(await f.query('SELECT orders FROM delivery_routes WHERE id=1')).rows[0];
    assert.deepEqual(stored.orders.map(stop=>stop.id),[2,1]);

    const duplicated=response();
    await handler(router,'patch','/routes/1/reorder')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKeys:['bot_1','bot_1']}},duplicated);
    assert.equal(duplicated.code,400);

    const anotherDriver=response();
    await handler(router,'patch','/routes/2/reorder')({orgId:1,userId:10,role:'repartidor',params:{id:'2'},body:{stopKeys:['bot_2']}},anotherDriver);
    assert.equal(anotherDriver.code,404);

    await f.query("UPDATE delivery_routes SET status='completed' WHERE id=1");
    const completed=response();
    await handler(router,'patch','/routes/1/reorder')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKeys:['bot_2','bot_1']}},completed);
    assert.equal(completed.code,409);
  } finally {await f.engine.close();}
});
test('admin can append a stop to an active route and invalidates the load checklist',async()=>{
  const f=await fixture();const sent=[];
  try {
    await f.engine.exec(`
      INSERT INTO orders(id,organization_id,conversation_id,items,total_price,status)
      VALUES(5,1,1,'[{"name":"Huevos XL","quantity":2}]',12000,'por_despachar');
      UPDATE delivery_routes
         SET optimized_route='[{"source":"bot","id":1,"stopNumber":1,"customerName":"Primero"}]',
             load_checklist='{"Producto anterior":true}'
       WHERE id=1;
    `);
    const router=load('src/routes/delivery.js',{
      '../db/database':f.db,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/push':{pushUser:async(...args)=>{sent.push(args);}},
    });
    const res=response();
    await handler(router,'post','/routes/1/orders')({
      orgId:1,userId:1,role:'owner',params:{id:'1'},
      body:{orders:[{source:'bot',id:5,customerName:'Parada nueva',items:[{name:'Huevos XL',quantity:2}]}]},
    },res);
    assert.equal(res.code,200,JSON.stringify(res.body));
    assert.equal(res.body.added,1);
    assert.equal(res.body.checklistInvalidated,true);
    const stored=(await f.query('SELECT orders,optimized_route,load_checklist FROM delivery_routes WHERE id=1')).rows[0];
    assert.deepEqual(stored.orders.map(order=>order.id),[1,5]);
    assert.deepEqual(stored.optimized_route.map(stop=>[stop.id,stop.stopNumber]),[[1,1],[5,2]]);
    assert.equal(stored.load_checklist.__invalidated,true);
    assert.equal(stored.load_checklist['Producto anterior'],undefined);
    const added=(await f.query('SELECT status,dispatch_count FROM orders WHERE id=5')).rows[0];
    assert.equal(added.status,'en_camino');
    assert.equal(added.dispatch_count,1);
    assert.equal(sent.length,1);
  } finally {await f.engine.close();}
});
test('delivery outcomes cancel, reschedule or mark a visible delivery incident',async()=>{
  const f=await fixture();
  try {
    const router=load('src/routes/delivery.js',{'../db/database':f.db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});
    const call=async(body)=>{const res=response();await handler(router,'patch','/routes/1/stops')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKey:'bot_1',...body}},res);return res;};
    const reset=()=>f.engine.exec("UPDATE delivery_routes SET status='in_progress', completed_at=NULL, stop_statuses='{}', stop_notes='{}' WHERE id=1; UPDATE orders SET status='sent', delivery_date=NULL, delivery_note=NULL, last_attempt_at=NULL, last_attempt_status=NULL WHERE id=1;");

    assert.equal((await call({status:'cancelled'})).code,400);
    assert.equal((await f.query('SELECT status FROM orders WHERE id=1')).rows[0].status,'sent');

    await f.query("INSERT INTO scheduled_orders(organization_id,conversation_id,phone,desired_date,status) VALUES(1,1,'111',CURRENT_DATE,'pending')");
    await f.query("UPDATE conversations SET pipeline_state='scheduled' WHERE id=1");
    assert.equal((await call({status:'cancelled',note:'Cliente ya no necesita el pedido'})).code,200);
    let order=(await f.query('SELECT status,delivery_note,last_attempt_status FROM orders WHERE id=1')).rows[0];
    assert.equal(order.status,'cancelled');
    assert.equal(order.delivery_note,'Cliente ya no necesita el pedido');
    assert.equal(order.last_attempt_status,'cancelado_definitivo');
    assert.equal((await f.query('SELECT status FROM scheduled_orders WHERE conversation_id=1')).rows[0].status,'cancelled');
    assert.equal((await f.query('SELECT pipeline_state FROM conversations WHERE id=1')).rows[0].pipeline_state,'exploring');

    await reset();
    assert.equal((await call({status:'postponed',deliverAfter:'2030-02-03',note:'Después de las 18'})).code,200);
    order=(await f.query("SELECT status,to_char(delivery_date,'YYYY-MM-DD') delivery_date,last_attempt_status FROM orders WHERE id=1")).rows[0];
    assert.equal(order.status,'por_despachar');
    assert.equal(order.delivery_date,'2030-02-03');
    assert.equal(order.last_attempt_status,'reprogramado');

    await reset();
    assert.equal((await call({status:'not_delivered',note:'Cliente no responde'})).code,200);
    order=(await f.query('SELECT status,delivery_date,delivery_note,last_attempt_status FROM orders WHERE id=1')).rows[0];
    assert.equal(order.status,'no_entregado');
    assert.equal(order.delivery_date,null);
    assert.equal(order.delivery_note,'Cliente no responde');
    assert.equal(order.last_attempt_status,'no_entregado');
    assert.equal((await f.query('SELECT status FROM delivery_routes WHERE id=1')).rows[0].status,'completed');
    assert.equal((await f.query("SELECT stop_notes->>'bot_1' note FROM delivery_routes WHERE id=1")).rows[0].note,'Cliente no responde');
  } finally {await f.engine.close();}
});
test('purchase history records manual bot and Shopify payments with method and audit source',async()=>{
  const f=await fixture();
  try {
    await f.query("UPDATE shopify_orders SET total_price=200,financial_status='pending' WHERE shopify_order_id='gid://shopify/Order/42'");
    const router=load('src/routes/orders.js',{
      '../db/database':f.db,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/shopify-api':{},
      '../services/payment-collection':{},
      '../services/delivery-notifications':{},
    });
    const bot=response();
    await handler(router,'patch','/history-payment')({orgId:1,userId:10,body:{source:'bot',id:1,paymentMethod:'transferencia'}},bot);
    assert.equal(bot.code,200);assert.equal(bot.body.alreadyPaid,false);
    const paidBot=(await f.query('SELECT status,payment_method,payment_cash_amount,payment_transfer_amount,payment_marked_by,payment_record_source FROM orders WHERE id=1')).rows[0];
    assert.equal(paidBot.status,'paid');assert.equal(paidBot.payment_method,'transferencia');
    assert.equal(Number(paidBot.payment_cash_amount),0);assert.equal(Number(paidBot.payment_transfer_amount),100);
    assert.equal(paidBot.payment_marked_by,10);assert.equal(paidBot.payment_record_source,'manual_history');

    const shopify=response();
    await handler(router,'patch','/history-payment')({orgId:1,userId:10,body:{source:'shopify',id:'gid://shopify/Order/42',paymentMethod:'efectivo'}},shopify);
    assert.equal(shopify.code,200);
    const paidShopify=(await f.query("SELECT financial_status,payment_method,payment_cash_amount,payment_record_source FROM shopify_orders WHERE shopify_order_id='gid://shopify/Order/42'")).rows[0];
    assert.equal(paidShopify.financial_status,'paid');assert.equal(paidShopify.payment_method,'efectivo');
    assert.equal(Number(paidShopify.payment_cash_amount),200);assert.equal(paidShopify.payment_record_source,'manual_history');
  } finally {await f.engine.close();}
});
test('stale in-transit routes become auditable delivery incidents the next day',async()=>{
  const f=await fixture();
  try {
    await f.query("UPDATE orders SET status='en_camino' WHERE id=1");
    await f.query("UPDATE delivery_routes SET status='in_progress', started_at=TIMESTAMPTZ '2026-09-29 15:00:00-03', stop_statuses='{}', stop_notes='{}', stop_times='{}' WHERE id=1");
    const recovery=load('src/services/delivery-recovery.js',{'../db/database':f.db});
    const result=await recovery.reconcileStaleDeliveryRoutes(1,new Date('2026-09-30T13:00:00Z'));
    assert.equal(result.recovered,1);
    const order=(await f.query('SELECT status,last_attempt_status,delivery_note FROM orders WHERE id=1')).rows[0];
    assert.equal(order.status,'no_entregado');
    assert.equal(order.last_attempt_status,'sin_resolver');
    assert.match(order.delivery_note,/sin que el repartidor registrara/);
    const route=(await f.query("SELECT status,stop_statuses->>'bot_1' stop_status,stop_notes->>'bot_1' note FROM delivery_routes WHERE id=1")).rows[0];
    assert.equal(route.status,'completed');
    assert.equal(route.stop_status,'not_delivered');
    assert.match(route.note,/sin que el repartidor registrara/);
  } finally {await f.engine.close();}
});
test('admin reschedule keeps the old route as history and exposes it to the next route',async()=>{
  const f=await fixture();
  try {
    await f.query("UPDATE orders SET status='en_camino' WHERE id=1");
    const ordersRouter=load('src/routes/orders.js',{
      '../db/database':f.db,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/shopify-api':{},
      '../services/payment-collection':{},
    });
    const changed=response();
    await handler(ordersRouter,'patch','/reschedule')({orgId:1,role:'owner',body:{source:'bot',id:1,date:'2030-02-03',note:'Cliente pidió otro día'}},changed);
    assert.equal(changed.code,200);
    assert.equal(changed.body.historicalRoutes.length,1);
    assert.equal(changed.body.historicalRoutes[0],1);
    const old=(await f.query("SELECT status,orders,stop_statuses,stop_notes FROM delivery_routes WHERE id=1")).rows[0];
    assert.equal(old.status,'completed');
    assert.equal(old.orders[0].id,1);
    assert.equal(old.stop_statuses.bot_1,'postponed');
    assert.match(old.stop_notes.bot_1,/Cliente pidió otro día/);
    const order=(await f.query("SELECT status,to_char(delivery_date,'YYYY-MM-DD') delivery_date,last_attempt_status FROM orders WHERE id=1")).rows[0];
    assert.equal(order.status,'por_despachar');
    assert.equal(order.delivery_date,'2030-02-03');
    assert.equal(order.last_attempt_status,'reprogramado');

    await f.query(`INSERT INTO delivery_routes(id,organization_id,name,status,driver_user_id,orders,optimized_route,created_at)
      VALUES(4,1,'Ruta nueva','draft',10,'[{"source":"bot","id":1,"customerName":"Cliente prueba"}]','[{"source":"bot","id":1,"customerName":"Cliente prueba","stopNumber":1}]',NOW()+INTERVAL '1 second')`);
    const deliveryRouter=load('src/routes/delivery.js',{'../db/database':f.db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});
    const detail=response();
    await handler(deliveryRouter,'get','/routes/4')({orgId:1,userId:10,role:'repartidor',params:{id:'4'}},detail);
    assert.equal(detail.code,200);
    assert.equal(detail.body.route.optimized_route[0].attemptHistory[0].routeName,'Own');
    assert.equal(detail.body.route.optimized_route[0].attemptHistory[0].status,'postponed');
  } finally {await f.engine.close();}
});
test('merge preserves linked business records, rejects another tenant and rolls back deletion failure',async()=>{
  const f=await fixture();
  try {
    await f.engine.exec(`INSERT INTO payment_proofs(id,organization_id,conversation_id,order_id,media_id) VALUES(2,1,2,2,'m');
      INSERT INTO scheduled_orders(organization_id,conversation_id,phone,desired_date) VALUES(1,2,'222',CURRENT_DATE);
      INSERT INTO admin_pending_replies(org_id,conversation_id,customer_phone) VALUES(1,2,'222');
      INSERT INTO escalation_feedback(organization_id,conversation_id,message_content,feedback) VALUES(1,2,'test','correct');
      INSERT INTO messages(conversation_id,direction,content) VALUES(2,'inbound','test');`);
    const {mergeConversations}=load('src/services/merge-conversations.js',{'../db/database':f.db});
    await assert.rejects(()=>mergeConversations(1,1,3),e=>e.status===404);
    await f.engine.exec(`CREATE FUNCTION audit_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER audit_delete BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION audit_reject_delete();`);
    await assert.rejects(()=>mergeConversations(1,1,2));
    assert.equal((await f.query('SELECT conversation_id FROM orders WHERE id=2')).rows[0].conversation_id,2);
    await f.engine.exec('DROP TRIGGER audit_delete ON conversations');
    await mergeConversations(1,1,2);
    for(const table of ['payment_proofs','scheduled_orders','admin_pending_replies','escalation_feedback','messages']) assert.equal((await f.query(`SELECT conversation_id FROM ${table}`)).rows[0].conversation_id,1);
    assert.equal((await f.query('SELECT conversation_id FROM orders WHERE id=2')).rows[0].conversation_id,1);
    assert.equal((await f.query('SELECT order_id FROM payment_proofs')).rows[0].order_id,2);
    assert.equal((await f.query('SELECT * FROM conversations WHERE id=2')).rows.length,0);
  } finally {await f.engine.close();}
});
test('modules readable by all roles; mutations and conversation merges keep role restrictions',async()=>{
  for(const role of ['owner','admin','supervisor','agent','coordinador','repartidor']) {
    const user={id:1,organization_id:1,role};
    const auth=load('src/middleware/auth.js',{'../db/database':{getUserById:async()=>user}});
    const req={headers:{authorization:'Bearer '+auth.generateToken(user)},query:{},method:'GET',path:'/modules',originalUrl:'/api/settings/modules'};
    const res=response();let passed=false;
    await auth.requireAuth(req,res,()=>{passed=true});assert.ok(passed,role);
    const settings=load('src/routes/settings.js',{'../middleware/auth':auth});passed=false;
    settings.stack[1].handle(req,res,()=>{passed=true});assert.ok(passed);
    req.method='PUT';passed=false;settings.stack[1].handle(req,res,()=>{passed=true});assert.equal(passed,['owner','admin'].includes(role));
    const conv=load('src/routes/conversations.js',{'../middleware/auth':auth});
    const merge=conv.stack.find(l=>l.route?.path==='/merge-into/:targetId');passed=false;
    merge.route.stack[0].handle(req,res,()=>{passed=true});assert.equal(passed,['owner','admin','supervisor'].includes(role));
    const delivery=load('src/routes/delivery.js',{'../middleware/auth':auth});
    const stop=delivery.stack.find(l=>l.route?.path==='/routes/:id/stops');passed=false;
    stop.route.stack[0].handle(req,res,()=>{passed=true});assert.equal(passed,role!=='agent');
  }
});
test('mobile item editor enforces module flag and route membership',async()=>{
  const f=await fixture();let enabled=false;
  try {
    const {routeItems}=load('src/services/delivery-items.js',{'../db/database':{...f.db,getSetting:async()=>JSON.stringify({edit_delivered_items:enabled})}});
    const request={orgId:1,userId:10,role:'repartidor',params:{id:'1'},method:'PATCH',body:{source:'bot',id:1,items:[{name:'Eggs',price:100,quantity:2}]}};
    let res=response();await routeItems(request,res);assert.equal(res.code,403);
    enabled=true;res=response();await routeItems({...request,body:{...request.body,id:2}},res);assert.equal(res.code,404);
    res=response();await routeItems(request,res);assert.equal(res.code,200);assert.equal(res.body.total,200);
    const syncedRoute=(await f.query('SELECT orders FROM delivery_routes WHERE id=1')).rows[0];
    assert.equal(syncedRoute.orders[0].items[0].name,'Eggs');
    assert.equal(syncedRoute.orders[0].items[0].quantity,2);
    res=response();await routeItems({...request,method:'GET',query:{source:'bot',id:1}},res);assert.equal(res.body.items[0].quantity,2);
  } finally {await f.engine.close();}
});
test('driver route shows cash balance, persists load checklist and keeps order history details',async()=>{
  const f=await fixture();
  try {
    const orderItems=[{name:'Huevos XL',quantity:2}];
    // Reproduce una ruta ya creada cuya parada perdió la copia de productos.
    const stop={source:'bot',id:1,stopNumber:1,customerName:'Cliente prueba',orderName:'#1',totalPrice:100};
    await f.query('UPDATE orders SET items=$1,total_price=100 WHERE id=1',[JSON.stringify(orderItems)]);
    await f.query(`UPDATE delivery_routes
      SET status='sent', optimized_route=$1, load_checklist='{}', stop_statuses='{"bot_1":"entregado"}', stop_payments='{"bot_1":"efectivo"}'
      WHERE id=1`,[JSON.stringify([stop])]);
    await f.query("INSERT INTO delivery_expenses(organization_id,route_id,driver_user_id,amount,category) VALUES(1,1,10,30,'Peaje')");
    const router=load('src/routes/delivery.js',{
      '../db/database':f.db,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/push':{},
    });
    const routeListRes=response();
    await handler(router,'get','/routes')({orgId:1,userId:1,role:'owner',query:{}},routeListRes);
    assert.equal(routeListRes.code,200);
    const listedRoute=routeListRes.body.routes.find(route=>route.id===1);
    assert.equal(listedRoute.optimized_route[0].items[0].name,'Huevos XL');
    assert.deepEqual(listedRoute.load_checklist,{});
    const getRes=response();
    await handler(router,'get','/routes/1')({orgId:1,userId:10,role:'repartidor',params:{id:'1'}},getRes);
    assert.equal(getRes.code,200);
    assert.deepEqual(JSON.parse(JSON.stringify(getRes.body.route.optimized_route[0].items)),orderItems);
    assert.deepEqual(JSON.parse(JSON.stringify(getRes.body.route.financial_summary)),{
      routeValue:100,deliveredValue:100,cashCollected:100,transferCollected:0,
      otherCollected:0,expenseCount:1,expensesTotal:30,netCash:70,
    });

    const blockedStop=response();
    await handler(router,'patch','/routes/1/stops')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKey:'bot_1',status:'pending'}},blockedStop);
    assert.equal(blockedStop.code,409);
    await f.query("UPDATE delivery_routes SET stop_statuses='{}' WHERE id=1");
    const incompleteStart=response();
    await handler(router,'patch','/routes/1/start')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{}},incompleteStart);
    assert.equal(incompleteStart.code,409);
    assert.equal(incompleteStart.body.missingItems[0].name,'Huevos XL');

    const checkRes=response();
    await handler(router,'patch','/routes/1/load-checklist')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{itemName:'Huevos XL',checked:true}},checkRes);
    assert.equal(checkRes.code,200);
    assert.equal(checkRes.body.loadChecklist['Huevos XL'],true);
    assert.equal((await f.query("SELECT load_checklist->>'Huevos XL' checked FROM delivery_routes WHERE id=1")).rows[0].checked,'true');

    const startRes=response();
    await handler(router,'patch','/routes/1/start')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{}},startRes);
    assert.equal(startRes.code,200);
    assert.equal(startRes.body.route.status,'in_progress');
    assert.ok(startRes.body.route.started_at);
    let startedOrder=(await f.query('SELECT status,dispatch_count FROM orders WHERE id=1')).rows[0];
    assert.equal(startedOrder.status,'en_camino');
    assert.equal(startedOrder.dispatch_count,1);

    const startAgain=response();
    await handler(router,'patch','/routes/1/start')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{}},startAgain);
    assert.equal(startAgain.code,200);
    startedOrder=(await f.query('SELECT dispatch_count FROM orders WHERE id=1')).rows[0];
    assert.equal(startedOrder.dispatch_count,1);

    const lateCheck=response();
    await handler(router,'patch','/routes/1/load-checklist')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{itemName:'Huevos XL',checked:false}},lateCheck);
    assert.equal(lateCheck.code,409);

    await f.query("UPDATE delivery_routes SET status='completed',completed_at=NOW() WHERE id=1");
    const historyRes=response();
    await handler(router,'get','/routes/history')({orgId:1,userId:10,role:'repartidor',query:{}},historyRes);
    assert.equal(historyRes.code,200);
    assert.equal(historyRes.body.routes[0].stop_payments.bot_1,'efectivo');
    assert.equal(historyRes.body.routes[0].optimized_route[0].customerName,'Cliente prueba');
  } finally {await f.engine.close();}
});
test('assigning an active route sends the driver a push notification with route context',async()=>{
  const f=await fixture();const sent=[];
  try {
    const router=load('src/routes/delivery.js',{
      '../db/database':f.db,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/push':{pushUser:async(...args)=>{sent.push(args);}},
    });
    const res=response();
    await handler(router,'patch','/routes/1')({orgId:1,userId:10,role:'owner',params:{id:'1'},body:{driverUserId:10}},res);
    assert.equal(res.code,200);
    assert.equal(sent.length,1);
    assert.equal(sent[0][1],10);
    assert.equal(sent[0][2].data.routeId,'1');
    assert.equal(sent[0][2].data.routeName,'Own');
  } finally {await f.engine.close();}
});
test('durable streams batch messages, isolate workers and survive new arrivals during processing',async()=>{
  const f=await fixture();
  try {
    const worker=load('src/services/webhook-inbox.js',{'../db/database':f.db});
    const otherWorker=load('src/services/webhook-inbox.js',{'../db/database':f.db});
    let release, entered;const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
    const ingested=[],replies=[];
    const fn=async req=>{const m=req.body.message;ingested.push(m.id);worker.defer(m.from,async()=>{replies.push(m.id);if(m.id==='2'){entered();await gate;}});};
    const receive=worker.durableWebhook('kapso',fn);
    otherWorker.durableWebhook('kapso',async req=>{replies.push(req.body.message.id)});
    const send=async(id,from,orgId=1)=>{const body={message:{id,from,type:'text',text:{body:'test'}},phone_number_id:'phone'};const res=response();await receive({webhookOrg:{id:orgId},body,params:{},rawBody:Buffer.from(JSON.stringify(body)),headers:{'x-webhook-event':'whatsapp.message.received'}},res);assert.equal(res.code,200);};
    await send('1','111');await send('2','111');await send('2','111');
    assert.equal((await f.query('SELECT COUNT(*)::int n FROM webhook_inbox')).rows[0].n,2);
    await worker.processNext();assert.equal(ingested.length,0,'quiet window is persisted');
    await f.query("UPDATE webhook_streams SET available_at=NOW()-INTERVAL '1 second'");
    const running=worker.processNext();await started;
    assert.deepEqual(ingested,['1','2']);assert.deepEqual(replies,['2']);
    await send('3','111');await send('4','444',2);
    await f.query("UPDATE webhook_streams SET available_at=NOW()-INTERVAL '1 second'");
    await otherWorker.processNext();assert.deepEqual(replies,['2','4'],'other organization runs while first is blocked');
    await otherWorker.processNext();assert.deepEqual(replies,['2','4'],'same stream cannot overlap across workers');
    release();await running;await worker.processNext();assert.deepEqual(replies,['2','4','3']);
    assert.equal((await f.query("SELECT COUNT(*)::int n FROM webhook_inbox WHERE status='completed'")).rows[0].n,4);
  } finally {await f.engine.close();}
});
test('Meta signature checks whole batch and persists every message/status under the correct tenant',async()=>{
  const f=await fixture();
  try {
    const payload={object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'a'},messages:[{id:'m1',from:'111',type:'text',text:{body:'one'}},{id:'m2',from:'111',type:'text',text:{body:'two'}}],statuses:[{id:'out',recipient_id:'111',status:'read'}]}}]},{changes:[{value:{metadata:{phone_number_id:'b'},messages:[{id:'m3',from:'333',type:'text',text:{body:'three'}}]}}]}]};
    const raw=Buffer.from(JSON.stringify(payload)),secret='meta-test';
    const auth=load('src/middleware/webhook-auth.js',{'../db/database':{getOrgByPhoneNumberId:async id=>({org:{id:id==='a'?1:2},whatsappConfig:{provider:'meta'}})}},{process:{env:{META_APP_SECRET:secret}}});
    const req={body:payload,rawBody:raw,headers:{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex')},params:{}};
    let passed=false;await auth.verifyWebhook('meta')(req,response(),()=>{passed=true});assert.ok(passed);assert.equal(req.webhookDeliveries.length,4);
    const worker=load('src/services/webhook-inbox.js',{'../db/database':f.db});const seen=[];
    const wa=load('src/services/whatsapp.js');
    const router=load('src/routes/webhook.js',{
      '../services/webhook-inbox':worker,'../middleware/webhook-auth':{verifyWebhook:()=>noop},
      '../services/whatsapp':{...wa,markAsRead:async()=>{}},
      '../services/notifications':{notifyAdminHumanPendingReply:async()=>{}},
      '../db/database':{
        getOrgByPhoneNumberId:async id=>({org:{id:id==='a'?1:2,name:id},whatsappConfig:{provider:'meta'}}),
        updateMessageStatus:async id=>{seen.push(id)},upsertConversation:async(org)=>({id:org}),
        saveMessage:async data=>{seen.push(data.whatsappMessageId);return {id:1}},
        updateConversationLastMessage:async()=>{},getConversationById:async()=>({agent_mode:'human'}),minutesSinceLastHumanReply:async()=>0,
      },
    });
    const receive=handler(router,'post','/');
    await receive(req,response());await receive(req,response());
    assert.equal((await f.query('SELECT COUNT(*)::int n FROM webhook_inbox')).rows[0].n,4);
    await worker.processNext();await worker.processNext();assert.deepEqual(seen.sort(),['m1','m2','m3','out']);
    const bad=response();await auth.verifyWebhook('meta')({...req,rawBody:Buffer.from('{}')},bad,()=>assert.fail('invalid signature'));assert.equal(bad.code,401);
  } finally {await f.engine.close();}
});
test('dispatch includes active bot orders, due Shopify orders and retries while rechecking stale routes', async () => {
  const f = await fixture();
  try {
    await f.engine.exec(`
      UPDATE orders SET status='sent', delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date + 1 WHERE id=1;
      UPDATE orders SET status='sent', delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date WHERE id=2;
      INSERT INTO orders(id,organization_id,items,total_price,status,delivery_date) VALUES
        (3,1,'[]',100,'sent',NULL),
        (4,1,'[]',100,'sent',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date - 1),
        (5,1,'[]',100,'nuevo',NULL),
        (6,1,'[]',100,'no_entregado',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date + 4);
      UPDATE orders SET dispatch_count=1,last_attempt_status='no_entregado' WHERE id=6;
      UPDATE shopify_orders SET delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date + 4;
      INSERT INTO shopify_orders(organization_id,shopify_order_id,delivery_date) VALUES
        (1,'today',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date),
        (1,'overdue',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date - 1),
        (1,'undated',NULL);
    `);
    const router = load('src/routes/delivery.js', {
      '../db/database': {...f.db, getSetting: async () => null},
      '../middleware/auth': {requireAuth: noop, requireRole: () => noop},
    });
    const call = async (method, path, body={}, params={}) => {
      const res=response();
      await handler(router,method,path)({orgId:1,role:'owner',body,params},res);
      return res;
    };
    const list=await call('get','/orders');
    assert.equal(list.code,200);
    assert.deepEqual(Array.from(list.body.orders,o=>`${o.source}_${o.id}`).sort(),
      ['bot_2','bot_3','bot_4','bot_5','bot_6','shopify_overdue','shopify_today'].sort());
    // Una pestaña que conservó una selección antigua tampoco puede volver a
    // introducirla al optimizar: el servidor arma la ruta solo con lo vigente.
    const optimized=await call('post','/optimize',{orders:[
      {source:'bot',id:1,customerName:'Programado a futuro'},
      {source:'bot',id:2,customerName:'Hoy'},
      {source:'bot',id:6,customerName:'Reintento programado'},
    ],vehicles:1});
    assert.equal(optimized.code,200,JSON.stringify(optimized.body));
    assert.deepEqual(Array.from(optimized.body.routes[0].stops,o=>`${o.source}_${o.id}`),['bot_6','bot_2']);
    assert.deepEqual(Array.from(optimized.body.skipped,o=>`${o.source}_${o.id}`),['bot_1']);
    // Ignore stale or forged dates from the browser; use the database date.
    const future=[{source:'bot',id:1,deliveryDate:'2000-01-01'},{source:'shopify',id:'gid://shopify/Order/42'}];
    assert.equal((await call('post','/routes',{orders:future,send:true})).code,400);
    await f.query("UPDATE delivery_routes SET status='draft' WHERE id=1");
    assert.equal((await call('patch','/routes/1',{status:'sent'},{id:'1'})).code,400);
    assert.equal((await call('post','/routes/2/orders',{orders:future},{id:'2'})).code,400);
    assert.equal((await f.query('SELECT status FROM orders WHERE id=1')).rows[0].status,'sent');
    // It becomes eligible automatically on its scheduled day.
    await f.query("UPDATE orders SET delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date,customer_phone='56912345678' WHERE id=1");
    // El mismo teléfono puede existir en formatos históricos distintos. El JOIN
    // de contactos no debe multiplicar el pedido en la pantalla de reparto.
    await f.engine.exec(`INSERT INTO contacts(organization_id,phone,name,address) VALUES
      (1,'56912345678','Exacto','Calle 1'),
      (1,'912345678','Formato antiguo','Calle 2'),
      (1,'+56912345678','Con signo','Calle 3');`);
    const todayList=(await call('get','/orders')).body.orders;
    assert.equal(todayList.filter(o=>o.source==='bot' && String(o.id)==='1').length,1);

    // Aunque un cliente viejo envíe el mismo pedido repetido, se guarda una
    // sola parada en la ruta y con numeración estable.
    const botOne=todayList.find(o=>o.source==='bot' && String(o.id)==='1');
    await f.query("SELECT setval(pg_get_serial_sequence('delivery_routes','id'),(SELECT MAX(id) FROM delivery_routes))");
    const draft=await call('post','/routes',{name:'Sin duplicados',orders:[botOne,botOne],optimizedRoute:[botOne,botOne],send:false});
    assert.equal(draft.code,200);
    assert.equal(draft.body.route.orders.length,1);
    assert.equal(draft.body.route.optimized_route.length,1);
  } finally { await f.engine.close(); }
});

test('sending a route reserves its orders and cancelling releases them', async () => {
  const f = await fixture();
  try {
    await f.engine.exec(`
      INSERT INTO orders(id,organization_id,items,total_price,status)
      VALUES(5,1,'[{"name":"Producto","quantity":1}]',100,'por_despachar');
      INSERT INTO shopify_orders(organization_id,shopify_order_id,items,crm_status)
      VALUES(1,'reserve-shopify','[{"name":"Producto","quantity":1}]','por_despachar');
      SELECT setval(pg_get_serial_sequence('delivery_routes','id'),(SELECT MAX(id) FROM delivery_routes));
    `);
    const router = load('src/routes/delivery.js', {
      '../db/database': f.db,
      '../middleware/auth': {requireAuth: noop, requireRole: () => noop},
      '../services/push': {pushUser: async () => {}},
    });
    const call = async (method, path, body = {}, params = {}) => {
      const res = response();
      await handler(router, method, path)({orgId: 1, role: 'owner', body, params}, res);
      return res;
    };
    const orders = [
      {source:'bot', id:5, customerName:'Bot'},
      {source:'shopify', id:'reserve-shopify', customerName:'Shopify'},
    ];
    const sent = await call('post', '/routes', {name:'Ruta reservada', orders, optimizedRoute:orders, send:true});
    assert.equal(sent.code, 200, JSON.stringify(sent.body));
    assert.equal((await f.query('SELECT status FROM orders WHERE id=5')).rows[0].status, 'asignado_ruta');
    assert.equal((await f.query("SELECT crm_status FROM shopify_orders WHERE shopify_order_id='reserve-shopify'")).rows[0].crm_status, 'asignado_ruta');

    const selectable = await call('get', '/orders');
    const keys = new Set(selectable.body.orders.map(order => `${order.source}_${order.id}`));
    assert.equal(keys.has('bot_5'), false);
    assert.equal(keys.has('shopify_reserve-shopify'), false);

    const duplicate = await call('post', '/routes', {name:'Duplicada', orders, optimizedRoute:orders, send:true});
    assert.equal(duplicate.code, 400);

    const cancelled = await call('patch', '/routes/:id', {status:'cancelled'}, {id:String(sent.body.route.id)});
    assert.equal(cancelled.code, 200, JSON.stringify(cancelled.body));
    assert.equal((await f.query('SELECT status FROM orders WHERE id=5')).rows[0].status, 'por_despachar');
    assert.equal((await f.query("SELECT crm_status FROM shopify_orders WHERE shopify_order_id='reserve-shopify'")).rows[0].crm_status, 'por_despachar');
  } finally { await f.engine.close(); }
});

test('delivery retries are placed first and remain explicit in the saved route', async () => {
  const f = await fixture();
  try {
    await f.query("UPDATE orders SET status='por_despachar' WHERE id=1");
    await f.query("UPDATE orders SET dispatch_count=2,last_attempt_status='no_entregado',delivery_note='Cliente no estaba' WHERE id=2");
    const database = { ...f.db, getSetting: async () => null };
    const router = load('src/routes/delivery.js', {
      '../db/database': database,
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    });
    const call = async (method, path, body = {}, params = {}) => {
      const res = response();
      await handler(router, method, path)({ orgId: 1, role: 'owner', body, params }, res);
      return res;
    };

    const normal = { source: 'bot', id: 1, customerName: 'Nuevo', fullAddress: 'Calle 1' };
    const retry = { source: 'bot', id: 2, customerName: 'Pendiente', fullAddress: 'Calle 2', dispatchCount: 2, lastAttemptStatus: 'no_entregado', deliveryNote: 'Cliente no estaba' };
    const optimized = await call('post', '/optimize', { orders: [normal, retry], vehicles: 1 });
    assert.equal(optimized.code, 200);
    assert.deepEqual(Array.from(optimized.body.routes[0].stops, stop => stop.id), [2, 1]);
    assert.equal(optimized.body.routes[0].stops[0].deliveryPriority, 'retry');
    assert.equal(optimized.body.routes[0].stops[0].priorityReason, 'Cliente no estaba');

    await f.query("SELECT setval(pg_get_serial_sequence('delivery_routes','id'),(SELECT MAX(id) FROM delivery_routes))");
    const staleRetry = { source: 'bot', id: 2, customerName: 'Pendiente', fullAddress: 'Calle 2' };
    const saved = await call('post', '/routes', {
      name: 'Prioridad de reintentos',
      orders: [normal, staleRetry],
      optimizedRoute: [normal, staleRetry],
      send: false,
    });
    assert.equal(saved.code, 200, JSON.stringify(saved.body));
    assert.deepEqual(Array.from(saved.body.route.optimized_route, stop => stop.id), [1, 2]);

    // Al enviarla, el servidor no confía en la copia antigua del navegador:
    // vuelve a consultar el pedido y aplica la prioridad real de la base.
    const sent = await call('patch', '/routes/:id', { status: 'sent' }, { id: String(saved.body.route.id) });
    assert.equal(sent.code, 200, JSON.stringify(sent.body));
    assert.deepEqual(Array.from(sent.body.route.optimized_route, stop => stop.id), [2, 1]);
    assert.equal(sent.body.route.orders[0].isRetry, true);
    assert.equal(sent.body.route.orders[0].previousAttempts, 2);
  } finally { await f.engine.close(); }
});



test('schedule delivery preserves payments and attempts, validates dates and isolates organizations', async () => {
  const f = await fixture();
  try {
    await f.query("UPDATE orders SET status='paid',last_attempt_status='no_entregado' WHERE id=1");
    let notified = false;
    const router = load('src/routes/orders.js', {
      '../db/database': f.db,
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../services/delivery-notifications': { sendOrderEditNotification: async () => { notified = true; } },
    });
    const call = async (body, orgId=1) => {
      const res = response();
      await handler(router, 'patch', '/schedule-delivery')({ orgId, body }, res);
      return res;
    };
    assert.equal((await call({source:'bot',id:1,date:'2030-02-30'})).code,400);
    assert.equal((await call({source:'bot',id:1,date:'2000-01-01'})).code,400);
    assert.equal((await call({source:'bot',id:1,date:'2030-02-03'},2)).code,404);
    assert.equal((await call({source:'bot',id:1,date:'2030-02-03'})).code,200);
    const order = (await f.query("SELECT status,last_attempt_status,to_char(delivery_date,'YYYY-MM-DD') date FROM orders WHERE id=1")).rows[0];
    assert.equal(order.status,'paid');
    assert.equal(order.last_attempt_status,'no_entregado');
    assert.equal(order.date,'2030-02-03');
    assert.equal(notified,false);
    assert.equal((await f.query('SELECT stop_statuses FROM delivery_routes WHERE id=1')).rows[0].stop_statuses.bot_1,'postponed');
    await f.query("UPDATE orders SET status='entregado' WHERE id=2");
    assert.equal((await call({source:'bot',id:2,date:'2030-02-03'})).code,409);
    assert.equal((await call({source:'shopify',id:'gid://shopify/Order/42',date:'2030-02-03'})).code,200);
  } finally { await f.engine.close(); }
});
