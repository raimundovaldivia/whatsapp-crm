const test = require('node:test');
const assert = require('node:assert/strict');
const { load,handler,response,noop } = require('./helpers.cjs');
const rules = require('../src/services/referral-rules');
const { fixture } = require('./referral-fixture.cjs');

test('reglas en pesos, metas únicas, validación estricta y lenguaje natural sin mutaciones implícitas',()=>{
  assert.equal(rules.DEFAULT_RULES.referrer_amount,2000);
  assert.equal(rules.DEFAULT_RULES.referred_amount,2000);
  assert.equal(rules.parseCommand('Da 2000 para ambos y una bandeja a los 5 compradores').rules.milestones[0].count,5);
  assert.equal(rules.parseCommand('Prepara códigos para mis compradores').action,'prepare');
  assert.equal(rules.parseCommand('Pausa referidos').action,'pause');
  assert.throws(()=>rules.parseCommand('Da 2000 para ambos y envía a todos ahora'),/No entendí/);
  for(const value of [-1,0,1.5,Infinity,'2000']) assert.throws(()=>rules.validateRules({referrer_amount:value}));
  assert.throws(()=>rules.validateRules({auto_send:'true'}));
  assert.throws(()=>rules.validateRules({milestones:[{count:5,kind:'gift',quantity:1},{count:5,kind:'gift',quantity:1}]}));
  assert.match(rules.invitation('Ana','REF-12345678',rules.DEFAULT_RULES),/una bandeja gratis/);
});

test('cinco personas distintas producen diez bonos y una sola bandeja; los reintentos no duplican',async t=>{
  const f=await fixture(t);
  for(let i=1;i<=5;i++){const r=await f.addReferral(i);await f.addOrder(r.referred_phone);}
  assert.equal((await f.engine.reconcile(1)).qualified,5);
  assert.equal((await f.query('SELECT * FROM referral_rewards WHERE organization_id=1')).rows.length,11);
  assert.equal((await f.query("SELECT * FROM referral_rewards WHERE organization_id=1 AND kind='gift'")).rows.length,1);
  assert.equal((await f.engine.reconcile(1)).issued,0);
  await f.addOrder('56933333331');
  assert.equal((await f.engine.reconcile(1)).qualified,0);
  assert.equal((await f.query('SELECT * FROM referral_rewards WHERE organization_id=2')).rows.length,0);
});

test('canje personal único descuenta el pedido y rechaza repetición, otro cliente y otra empresa',async t=>{
  const f=await fixture(t);const ref=await f.addReferral();await f.engine.reconcile(1);
  const {rows:[reward]}=await f.query('SELECT * FROM referral_rewards WHERE organization_id=1');
  const order=await f.addOrder(ref.referred_phone,'draft');
  const other=await f.addOrder('56999999999','draft');
  await assert.rejects(()=>f.engine.redeem(1,1,reward.id,other.id),/personal/);
  await assert.rejects(()=>f.engine.redeem(2,2,reward.id,order.id),/no encontrado/);
  const quote=await f.engine.redeem(1,1,reward.id,order.id,true);
  assert.equal(quote.before,10000);assert.equal(quote.after,8000);
  await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id,false,12000),/cambió/);
  await f.engine.redeem(1,1,reward.id,order.id,false,10000);
  assert.equal((await f.query('SELECT total_price FROM orders WHERE id=$1',[order.id])).rows[0].total_price,'8000');
  assert.equal(JSON.parse((await f.query('SELECT items FROM orders WHERE id=$1',[order.id])).rows[0].items).at(-1).loadItem,false);
  await assert.rejects(()=>f.query("UPDATE orders SET items='[]' WHERE id=$1",[order.id]),/Conserva el bono/);
  await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/usado/);
  await f.query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.id]);
  const again=await f.addOrder(ref.referred_phone,'draft');
  await assert.rejects(()=>f.engine.redeem(1,1,reward.id,again.id),/usado/);
  assert.equal((await f.query('SELECT * FROM referral_program_audit WHERE action=$1',[ 'reward_redeemed' ])).rows.length,1);
});

test('regalo se agrega al pedido y descuenta stock una vez; pedidos pagados y stock insuficiente bloquean',async t=>{
  const f=await fixture(t);
  for(let i=1;i<=5;i++){const r=await f.addReferral(i);await f.addOrder(r.referred_phone);}
  await f.engine.reconcile(1);
  const {rows:[gift]}=await f.query("SELECT * FROM referral_rewards WHERE kind='gift'");
  const order=await f.addOrder('56911111111','draft');
  await f.query('UPDATE products SET stock=0 WHERE id=1');
  await assert.rejects(()=>f.engine.redeem(1,1,gift.id,order.id),/stock/);
  assert.equal((await f.query('SELECT status FROM referral_rewards WHERE id=$1',[gift.id])).rows[0].status,'available');
  await f.query('UPDATE products SET stock=2 WHERE id=1');
  await f.engine.redeem(1,1,gift.id,order.id);
  assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,1);
  const saved=(await f.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0];
  assert.equal(saved.total_price,'10000');assert.equal(JSON.parse(saved.items).at(-1).price,0);
  await assert.rejects(()=>f.engine.redeem(1,1,gift.id,order.id),/usado/);
});

test('compras sin pago/entrega, devolución y duplicado Shopify no generan conversiones dobles',async t=>{
  const f=await fixture(t);const ref=await f.addReferral();const order=await f.addOrder(ref.referred_phone,'draft');
  assert.equal((await f.engine.reconcile(1)).qualified,0);
  await f.query("UPDATE orders SET status='paid' WHERE id=$1",[order.id]);
  assert.equal((await f.engine.reconcile(1)).qualified,0);
  await f.query("UPDATE orders SET delivered_at=NOW(),shopify_order_id='shop-1' WHERE id=$1",[order.id]);
  await f.query("INSERT INTO shopify_orders(organization_id,shopify_order_id,customer_phone,total_price,financial_status,shopify_created_at,delivered_at) VALUES(1,'shop-1',$1,10000,'paid',NOW()-INTERVAL '1 day',NOW())",[ref.referred_phone]);
  assert.equal((await f.engine.reconcile(1)).qualified,1);
  await f.query("INSERT INTO order_returns VALUES(1,'bot',$1,'requested')",[String(order.id)]);
  await f.engine.reconcile(1);
  assert.equal((await f.query('SELECT status FROM referrals WHERE id=$1',[ref.id])).rows[0].status,'rejected');
  assert.equal((await f.query("SELECT COUNT(*)::int AS n FROM referral_rewards WHERE status='available'")).rows[0].n,0);
});

test('alta de códigos requiere compra y consentimiento, mantiene reglas prometidas y separa empresas',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.engine.createCode(1,1,2),/no encontrado/);
  await f.query("INSERT INTO contacts(id,organization_id,phone,name) VALUES(3,1,'56944444444','Nuevo')");
  await assert.rejects(()=>f.engine.createCode(1,1,3),/compra/);
  await f.query('UPDATE contacts SET opt_out=TRUE WHERE id=1');
  await assert.rejects(()=>f.engine.createCode(1,1,1),/no recibir/);
  await f.query('UPDATE contacts SET opt_out=FALSE WHERE id=1');
  await f.engine.saveSettings(1,1,{enabled:true,rules:{...rules.DEFAULT_RULES,referrer_amount:3000,gift_product_id:1}});
  const same=await f.engine.createCode(1,1,1);
  assert.equal(same.id,f.code.id);assert.equal(same.rules_snapshot.referrer_amount,2000);
  assert.equal((await f.query('SELECT * FROM referral_messages')).rows.length,1);
  await assert.rejects(()=>f.engine.saveSettings(1,1,{enabled:true,rules:{...rules.DEFAULT_RULES,gift_product_id:2}}),/esta empresa/);
});

test('mensajes en borrador requieren aprobación; opt-out y envío incierto no se reintentan',async t=>{
  const f=await fixture(t);let calls=0;
  const automation=load('src/services/referral-automation.js',{
    '../db/database':f.db,'./referral-engine':f.engine,'./outbound-policy':{isCustomerMessagingHour:()=>true},
    './delivery-notifications':{sendDeliveryNotification:async()=>{calls++;throw new Error('timeout');}},
  });
  assert.equal((await automation.sendPending(1)).sent,0);assert.equal(calls,0);
  const {rows:[msg]}=await f.query('SELECT * FROM referral_messages');
  await assert.rejects(()=>automation.approve(2,2,[Number(msg.id)]),/pausado/);
  await automation.approve(1,1,[Number(msg.id)]);await automation.sendPending(1);await automation.sendPending(1);
  assert.equal(calls,1);
  assert.equal((await f.query('SELECT status FROM referral_messages')).rows[0].status,'uncertain');
  assert.equal((await automation.approve(1,1,[Number(msg.id)])).queued,0);
});

test('rutas administrativas aplican roles y no aceptan calificación manual ni canje sin vista previa',async()=>{
  const requested=[];
  const router=load('src/routes/referrals.js',{
    '../db/database':{normalizeName:x=>x},'../services/referrals':{},'../services/referral-rules':rules,
    '../middleware/auth':{requireAuth:noop,requireRole:(...roles)=>{requested.push(roles);return (req,res,next)=>roles.includes(req.role)?next():res.status(403).json({error:'Sin permisos'});}},
  });
  for(const [method,url,req] of [['post','/rewards/1/redeem',{params:{id:'1'},body:{order_id:1}}],['patch','/1/status',{params:{id:'1'},body:{status:'qualified'}}]]){
    const res=response();await handler(router,method,url)({orgId:1,...req},res);assert.ok([400,409].includes(res.code));
    const layer=router.stack.find(l=>l.route?.methods[method]&&l.match(url));const denied=response();let passed=false;
    layer.route.stack[0].handle({role:'agent'},denied,()=>{passed=true;});assert.equal(denied.code,403);assert.equal(passed,false);
  }
  assert.ok(requested.some(r=>r.join(',')==='owner,admin'));
});

test('descuento de bienvenida respeta el mínimo antes del bono y un carrito previo no es una compra previa',async t=>{
  const f=await fixture(t);const ref=await f.addReferral();
  const order=await f.addOrder(ref.referred_phone,'draft');
  await f.query("UPDATE orders SET created_at=NOW()-INTERVAL '3 days' WHERE id=$1",[order.id]);
  await f.query('UPDATE referral_codes SET rules_snapshot=$2::jsonb WHERE id=$1',[f.code.id,JSON.stringify({...rules.DEFAULT_RULES,minimum_purchase:10000,gift_product_id:1})]);
  await f.engine.reconcile(1);
  const {rows:[welcome]}=await f.query("SELECT * FROM referral_rewards WHERE benefit_key='welcome'");
  await f.engine.redeem(1,1,welcome.id,order.id);
  await f.query("UPDATE orders SET status='paid',payment_marked_at=NOW(),delivered_at=NOW() WHERE id=$1",[order.id]);
  assert.equal((await f.engine.reconcile(1)).qualified,1);
  assert.equal((await f.query("SELECT * FROM referral_rewards WHERE benefit_key=$1",[`referral:${ref.id}`])).rows.length,1);
});

test('pausar no borra bonos, pero revalida devoluciones y una meta no se vuelve a emitir',async t=>{
  const f=await fixture(t);const orders=[];
  for(let i=1;i<=5;i++){const r=await f.addReferral(i);orders.push(await f.addOrder(r.referred_phone));}
  await f.engine.reconcile(1);
  await f.engine.saveSettings(1,1,{enabled:false,rules:{...rules.DEFAULT_RULES,gift_product_id:1}});
  assert.equal((await f.query("SELECT * FROM referral_rewards WHERE status='available'")).rows.length,11);
  await f.query("UPDATE orders SET status='cancelled' WHERE id=$1",[orders[0].id]);
  await f.engine.reconcile(1);
  assert.equal((await f.query("SELECT status FROM referral_rewards WHERE kind='gift'")).rows[0].status,'void');
  await f.engine.saveSettings(1,1,{enabled:true,rules:{...rules.DEFAULT_RULES,gift_product_id:1}});
  const sixth=await f.addReferral(6);await f.addOrder(sixth.referred_phone);await f.engine.reconcile(1);
  const gifts=(await f.query("SELECT * FROM referral_rewards WHERE kind='gift'")).rows;
  assert.equal(gifts.length,1);assert.equal(gifts[0].status,'void');
});

test('bonos vencidos, pagos, doble descuento y pedidos de Shopify no se pueden canjear',async t=>{
  const f=await fixture(t);const ref=await f.addReferral();await f.engine.reconcile(1);
  const {rows:[r]}=await f.query("SELECT * FROM referral_rewards WHERE benefit_key='welcome'");
  const order=await f.addOrder(ref.referred_phone,'draft');
  await f.query("UPDATE orders SET shopify_draft_id='external' WHERE id=$1",[order.id]);
  await assert.rejects(()=>f.engine.redeem(1,1,r.id,order.id),/externo/);
  await f.query("UPDATE orders SET shopify_draft_id=NULL,payment_marked_at=NOW() WHERE id=$1",[order.id]);
  await assert.rejects(()=>f.engine.redeem(1,1,r.id,order.id),/antes del pago/);
  await f.query('UPDATE orders SET payment_marked_at=NULL WHERE id=$1',[order.id]);
  await f.query("UPDATE referral_rewards SET expires_at=NOW()-INTERVAL '1 day' WHERE id=$1",[r.id]);
  await assert.rejects(()=>f.engine.redeem(1,1,r.id,order.id),/venció/);
  for (const n of [2,3]) {const other=await f.addReferral(n);await f.addOrder(other.referred_phone);}
  await f.engine.reconcile(1);
  const bonuses=(await f.query("SELECT * FROM referral_rewards WHERE beneficiary_phone='56911111111' AND kind='discount' ORDER BY id")).rows;
  const next=await f.addOrder('56911111111','por_despachar');
  await f.engine.redeem(1,1,bonuses[0].id,next.id);
  assert.equal((await f.query('SELECT status FROM referrals WHERE id=$1',[bonuses[0].referral_id])).rows[0].status,'rewarded');
  await assert.rejects(()=>f.engine.redeem(1,1,bonuses[1].id,next.id),/ya tiene un bono/);
});

test('exclusión de mensajes y horario se revisan antes de contactar al proveedor',async t=>{
  const f=await fixture(t);let sends=0;
  const deps={'../db/database':f.db,'./referral-engine':f.engine,
    './delivery-notifications':{sendDeliveryNotification:async()=>{sends++;return {sent:true};}}};
  const outside=load('src/services/referral-automation.js',{...deps,'./outbound-policy':{isCustomerMessagingHour:()=>false}});
  const inside=load('src/services/referral-automation.js',{...deps,'./outbound-policy':{isCustomerMessagingHour:()=>true}});
  const {rows:[m]}=await f.query('SELECT * FROM referral_messages');await inside.approve(1,1,[Number(m.id)]);
  await outside.sendPending(1);assert.equal(sends,0);
  await f.query('UPDATE contacts SET opt_out=TRUE WHERE id=1');await inside.sendPending(1);assert.equal(sends,0);
  assert.equal((await f.query('SELECT status FROM referral_messages')).rows[0].status,'cancelled');
  await f.query('UPDATE contacts SET opt_out=FALSE WHERE id=1');
  const fresh=await f.engine.queueMessage(f.pool,1,f.code.id,'56911111111','Ana','Invitación de prueba','test:positive',false);
  await inside.approve(1,1,[Number(fresh.id)]);await inside.sendPending(1);await inside.sendPending(1);
  assert.equal(sends,1);
  assert.equal((await f.query('SELECT status FROM referral_messages WHERE id=$1',[fresh.id])).rows[0].status,'sent');
});

test('la invitación de referidos nunca se convierte en una promoción reusable del bot',()=>{
  const promotion=require('../src/services/promotion-context');
  assert.equal(promotion.parseTemplate({content:'[Template: premio]\nCon REF-12345678 obtienes una bandeja gratis en compras sobre $10000'}),null);
  assert.equal(promotion.parseTemplate({agent_type:'referral',content:'[Template: premio]\nBandeja gratis en compras sobre $10000'}),null);
});

test('activar reglas en un código antiguo no entrega beneficios por referidos anteriores',async t=>{
  const f=await fixture(t);const old=await f.addReferral();await f.addOrder(old.referred_phone);
  await f.query('UPDATE referral_codes SET rules_snapshot=NULL,rules_adopted_at=NULL WHERE id=$1',[f.code.id]);
  await f.engine.createCode(1,1,1);
  assert.equal((await f.engine.reconcile(1)).issued,0);
  assert.equal((await f.query('SELECT status FROM referrals WHERE id=$1',[old.id])).rows[0].status,'pending');
});
