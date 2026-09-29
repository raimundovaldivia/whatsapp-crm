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
    (1,1,'Own','sent',10,'[{"source":"bot","id":1}]'),
    (2,1,'Other','sent',11,'[{"source":"bot","id":2}]'),
    (3,1,'Shopify','sent',10,'[{"source":"shopify","id":"gid://shopify/Order/42"}]');`);
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
test('delivery outcomes cancel, reschedule or close a stop without changing the order',async()=>{
  const f=await fixture();
  try {
    const router=load('src/routes/delivery.js',{'../db/database':f.db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop}});
    const call=async(body)=>{const res=response();await handler(router,'patch','/routes/1/stops')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{stopKey:'bot_1',...body}},res);return res;};
    const reset=()=>f.engine.exec("UPDATE delivery_routes SET status='sent', completed_at=NULL, stop_statuses='{}', stop_notes='{}' WHERE id=1; UPDATE orders SET status='sent', delivery_date=NULL, delivery_note=NULL, last_attempt_at=NULL, last_attempt_status=NULL WHERE id=1;");

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
    assert.equal(order.status,'sent');
    assert.equal(order.delivery_date,null);
    assert.equal(order.delivery_note,null);
    assert.equal(order.last_attempt_status,null);
    assert.equal((await f.query('SELECT status FROM delivery_routes WHERE id=1')).rows[0].status,'completed');
    assert.equal((await f.query("SELECT stop_notes->>'bot_1' note FROM delivery_routes WHERE id=1")).rows[0].note,'Cliente no responde');
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
    res=response();await routeItems({...request,method:'GET',query:{source:'bot',id:1}},res);assert.equal(res.body.items[0].quantity,2);
  } finally {await f.engine.close();}
});
test('driver route shows cash balance, persists load checklist and keeps order history details',async()=>{
  const f=await fixture();
  try {
    const stop={source:'bot',id:1,stopNumber:1,customerName:'Cliente prueba',orderName:'#1',totalPrice:100,items:[{name:'Huevos XL',quantity:2}]};
    await f.query('UPDATE orders SET items=$1,total_price=100 WHERE id=1',[JSON.stringify(stop.items)]);
    await f.query(`UPDATE delivery_routes
      SET optimized_route=$1, stop_statuses='{"bot_1":"entregado"}', stop_payments='{"bot_1":"efectivo"}'
      WHERE id=1`,[JSON.stringify([stop])]);
    await f.query("INSERT INTO delivery_expenses(organization_id,route_id,driver_user_id,amount,category) VALUES(1,1,10,30,'Peaje')");
    const router=load('src/routes/delivery.js',{
      '../db/database':f.db,
      '../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/push':{},
    });
    const getRes=response();
    await handler(router,'get','/routes/1')({orgId:1,userId:10,role:'repartidor',params:{id:'1'}},getRes);
    assert.equal(getRes.code,200);
    assert.deepEqual(JSON.parse(JSON.stringify(getRes.body.route.financial_summary)),{
      routeValue:100,deliveredValue:100,cashCollected:100,transferCollected:0,
      otherCollected:0,expenseCount:1,expensesTotal:30,netCash:70,
    });

    const checkRes=response();
    await handler(router,'patch','/routes/1/load-checklist')({orgId:1,userId:10,role:'repartidor',params:{id:'1'},body:{itemName:'Huevos XL',checked:true}},checkRes);
    assert.equal(checkRes.code,200);
    assert.equal(checkRes.body.loadChecklist['Huevos XL'],true);
    assert.equal((await f.query("SELECT load_checklist->>'Huevos XL' checked FROM delivery_routes WHERE id=1")).rows[0].checked,'true');

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
test('dispatch excludes future bot and Shopify deliveries and rechecks stale routes', async () => {
  const f = await fixture();
  try {
    await f.engine.exec(`
      UPDATE orders SET status='sent', delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date + 1 WHERE id=1;
      UPDATE orders SET status='sent', delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date WHERE id=2;
      INSERT INTO orders(id,organization_id,items,total_price,status,delivery_date) VALUES
        (3,1,'[]',100,'sent',NULL),
        (4,1,'[]',100,'sent',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date - 1);
      UPDATE shopify_orders SET delivery_date=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date + 4;
      INSERT INTO shopify_orders(organization_id,shopify_order_id,delivery_date) VALUES
        (1,'today',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date),
        (1,'overdue',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date - 1),
        (1,'undated',NULL);
    `);
    const router = load('src/routes/delivery.js', {'../db/database': f.db, '../middleware/auth': {requireAuth: noop, requireRole: () => noop}});
    const call = async (method, path, body={}, params={}) => {
      const res=response();
      await handler(router,method,path)({orgId:1,role:'owner',body,params},res);
      return res;
    };
    const list=await call('get','/orders');
    assert.equal(list.code,200);
    assert.deepEqual(Array.from(list.body.orders,o=>`${o.source}_${o.id}`).sort(),
      ['bot_2','bot_3','bot_4','shopify_overdue','shopify_today','shopify_undated'].sort());
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

