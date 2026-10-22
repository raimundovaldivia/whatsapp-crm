const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response } = require('./helpers.cjs');
const { fixture } = require('./referral-fixture.cjs');
const rules = require('../src/services/referral-rules');

const OWNER_PHONE = '56911111111';
// Expectations are independent of the implementation's preset definitions.
const PROGRAMS = [
  { id:'doble', name:'Doble beneficio', milestones:[] },
  { id:'cinco', name:'Cinco amigos, una bandeja', milestones:[{ count:5, kind:'gift', amount:0, quantity:1 }] },
  { id:'escalera', name:'Premios por etapas', milestones:[
    { count:3, kind:'discount', amount:2000, quantity:1 }, { count:5, kind:'gift', amount:0, quantity:1 },
  ] },
];
const preset = id => rules.PRESETS.find(p => p.id === id).rules;
const rewards = async f => (await f.query('SELECT * FROM referral_rewards WHERE organization_id=1 ORDER BY id')).rows;
const row = async (f,table,id) => {
  assert.ok(['orders','referral_rewards','referrals'].includes(table));
  return (await f.query(`SELECT * FROM ${table} WHERE organization_id=1 AND id=$1`,[id])).rows[0];
};
async function qualify(f, n) {
  const ref = await f.addReferral(n);
  const order = await f.addOrder(ref.referred_phone);
  await f.engine.reconcile(1);
  return { ref,order };
}
function automation(f, sent = []) {
  return load('src/services/referral-automation.js',{
    '../db/database':f.db,'./referral-engine':f.engine,
    './outbound-policy':{isCustomerMessagingHour:()=>true},
    './delivery-notifications':{sendDeliveryNotification:async (org,target,message)=>{
      sent.push({org,target,message}); return {sent:true};
    }},
  });
}
function router(f) {
  const auth = load('src/middleware/auth.js', {'../db/database':f.db});
  return load('src/routes/referrals.js', {
    '../db/database':f.db,'../middleware/auth':auth,'../services/referrals':f.capture,
    '../services/referral-engine':f.engine,'../services/referral-rules':rules,
    '../services/referral-automation':automation(f),
  });
}
async function call(routes,method,url,body={},params={},orgId=1) {
  const res = response();
  await handler(routes,method,url)({orgId,userId:orgId,role:'admin',body,params,query:{}},res);
  return res;
}

test('la matriz cubre todos los programas ofrecidos y sus metas exactas',()=>{
  assert.deepEqual(rules.PRESETS.map(p=>p.id).sort(),PROGRAMS.map(p=>p.id).sort());
  for (const program of PROGRAMS) {
    assert.deepEqual(preset(program.id).milestones,program.milestones);
    assert.equal(preset(program.id).referrer_amount,2000);
    assert.equal(preset(program.id).referred_amount,2000);
  }
});

for (const program of PROGRAMS) {
  test(`${program.name}: inscripción, seis compradores, cada umbral y canje único de TODOS los beneficios`,async t=>{
    const f = await fixture(t,{rules:preset(program.id)});
    const routes = router(f);
    for (let n=1;n<=6;n++) {
      const phone = `5694444444${n}`;
      const {rows:[conversation]} = await f.query(`INSERT INTO conversations(organization_id,phone_number,contact_name)
        VALUES(1,$1,'Invitado') RETURNING id`,[phone]);
      const ref = await f.capture.captureInboundReferral(1,conversation.id,`Hola ${f.code.code}`);
      assert.ok(ref);
      assert.equal(await f.capture.captureInboundReferral(1,conversation.id,f.code.code),null);
      // Formatting or sending the invitation again cannot register a second identity.
      await f.query('UPDATE conversations SET phone_number=$2 WHERE id=$1',[conversation.id,`+56 9 4444 444${n}`]);
      assert.equal(await f.capture.captureInboundReferral(1,conversation.id,f.code.code),null);
      await f.engine.reconcile(1);
      const welcome = (await rewards(f)).find(r=>r.beneficiary_phone===phone);
      assert.equal(welcome.benefit_key,'welcome'); assert.equal(welcome.amount,2000);
      const order = await f.addOrder(phone,'draft');
      const params = {id:String(welcome.id)};
      for (let repeat=0;repeat<2;repeat++) {
        const preview = await call(routes,'post',`/rewards/${welcome.id}/preview`,{order_id:order.id},params);
        assert.equal(preview.code,200); assert.equal(preview.body.after,8000);
        assert.equal((await row(f,'referral_rewards',welcome.id)).status,'available');
        assert.equal((await row(f,'orders',order.id)).total_price,'10000');
      }
      const confirm = await call(routes,'post',`/rewards/${welcome.id}/redeem`,{order_id:order.id,expected_total:10000},params);
      assert.equal(confirm.code,200); assert.equal(confirm.body.after,8000);
      const repeated = await call(routes,'post',`/rewards/${welcome.id}/redeem`,{order_id:order.id,expected_total:10000},params);
      assert.equal(repeated.code,409);
      const alternative = await f.addOrder(phone,'draft');
      await assert.rejects(()=>f.engine.redeem(1,1,welcome.id,alternative.id),/usado/);
      await f.query("UPDATE orders SET status='paid',payment_marked_at=NOW(),delivered_at=NOW() WHERE id=$1",[order.id]);
      assert.equal((await f.engine.reconcile(1)).qualified,1);
      assert.equal((await f.engine.reconcile(1)).issued,0);
      const earned = await rewards(f);
      const reached = program.milestones.filter(m=>m.count<=n);
      assert.equal(earned.length,2*n+reached.length);
      assert.deepEqual(earned.filter(r=>r.benefit_key.startsWith('milestone:')).map(r=>({
        count:Number(r.benefit_key.split(':')[1]),kind:r.kind,amount:r.amount,quantity:r.quantity,
      })),reached);
      assert.equal(earned.filter(r=>r.benefit_key===`referral:${ref.id}` && r.amount===2000 && r.beneficiary_phone===OWNER_PHONE).length,1);
      // A second purchase by this buyer never advances a milestone.
      const repeatPurchase = await f.addOrder(phone);
      await f.query('UPDATE orders SET created_at=NOW(),payment_marked_at=NOW() WHERE id=$1',[repeatPurchase.id]);
      assert.equal((await f.engine.reconcile(1)).qualified,0);
      assert.equal((await rewards(f)).length,earned.length);
      assert.equal(await f.capture.captureInboundReferral(1,conversation.id,f.code.code),null);
    }
    const all = await rewards(f);
    assert.equal(new Set(all.map(r=>r.token)).size,all.length);
    assert.equal(new Set(all.map(r=>`${r.beneficiary_phone}:${r.benefit_key}`)).size,all.length);
    for (const reward of all.filter(r=>r.beneficiary_phone===OWNER_PHONE)) {
      const order = await f.addOrder(OWNER_PHONE,'draft');
      const alternative = await f.addOrder(OWNER_PHONE,'draft');
      const beforeStock = (await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock;
      const preview = await f.engine.redeem(1,1,reward.id,order.id,true);
      await f.engine.redeem(1,1,reward.id,order.id,false,preview.before);
      assert.equal((await row(f,'orders',order.id)).total_price,reward.kind==='discount'?'8000':'10000');
      assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,beforeStock-(reward.kind==='gift'?1:0));
      await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/usado/);
      await assert.rejects(()=>f.engine.redeem(1,1,reward.id,alternative.id),/usado/);
      await f.query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.id]);
      await assert.rejects(()=>f.engine.redeem(1,1,reward.id,alternative.id),/usado/);
      const final = await row(f,'referral_rewards',reward.id);
      assert.equal(final.status,'redeemed'); assert.equal(final.redeemed_order_id,order.id);
      assert.equal((await row(f,'orders',alternative.id)).total_price,'10000');
    }
    assert.ok((await rewards(f)).every(r=>r.status==='redeemed'));
    assert.equal((await f.query("SELECT * FROM referral_program_audit WHERE organization_id=1 AND action='reward_redeemed'")).rows.length,all.length);
    assert.equal((await f.query('SELECT * FROM referral_messages WHERE organization_id=1 AND reward_id IS NOT NULL')).rows.length,all.length);
    assert.equal((await f.engine.createCode(1,1,1)).id,f.code.id);
    assert.equal((await f.engine.prepareInvitations(1,1)).prepared,0);
    await f.engine.reconcile(1);
    assert.deepEqual((await rewards(f)).map(r=>r.token),all.map(r=>r.token));
    assert.equal((await f.query('SELECT * FROM referral_rewards WHERE organization_id=2')).rows.length,0);
  });

  test(`${program.name}: automatización y recordatorios no vuelven a emitir ni enviar bonos`,async t=>{
    const f = await fixture(t,{rules:{...preset(program.id),auto_send:true,auto_invite:true}});
    const sent = []; const worker = automation(f,sent);
    for (let n=1;n<=5;n++) await qualify(f,n);
    const original = await rewards(f);
    await worker.run(); await worker.run();
    assert.equal(sent.length,original.length); // The manually prepared invitation stays a draft.
    assert.equal((await f.query("SELECT status FROM referral_messages WHERE dedupe_key LIKE 'invite:%'")).rows[0].status,'draft');
    await f.query("UPDATE referral_messages SET sent_at=NOW()-INTERVAL '8 days' WHERE reward_id IS NOT NULL");
    await worker.reminders(1); await worker.reminders(1);
    assert.equal((await f.query("SELECT * FROM referral_messages WHERE dedupe_key LIKE 'reminder:%'")).rows.length,original.length);
    const consumed = original.find(r=>r.beneficiary_phone===OWNER_PHONE && r.kind==='discount');
    const order = await f.addOrder(OWNER_PHONE,'draft');
    await f.engine.redeem(1,1,consumed.id,order.id);
    const expired = original.find(r=>r.benefit_key==='welcome');
    await f.query("UPDATE referral_rewards SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[expired.id]);
    const gift = original.find(r=>r.kind==='gift');
    if (gift) await f.engine.redeem(1,1,gift.id,order.id);
    await worker.sendPending(1); await worker.run();
    assert.equal(sent.length,2*original.length-2-(gift?1:0));
    const reminders = (await f.query("SELECT * FROM referral_messages WHERE dedupe_key LIKE 'reminder:%'")).rows;
    assert.equal(reminders.filter(m=>m.status==='cancelled').length,2+(gift?1:0));
    for (const reward of original) {
      const texts = sent.filter(s=>s.message.text.includes(reward.token));
      assert.ok(texts.length===1 || texts.length===2);
      assert.equal(texts.filter(s=>!s.message.text.startsWith('Te recordamos')).length,1);
    }
    assert.deepEqual((await rewards(f)).map(r=>r.token),original.map(r=>r.token));
  });

  test(`${program.name}: lenguaje natural previsualiza sin aplicar y conserva los beneficios prometidos`,async t=>{
    const f = await fixture(t); const routes = router(f);
    const before = (await f.engine.settings(f.pool,1)).rules;
    const message = `usar ${program.id}`;
    const preview = await call(routes,'post','/command',{message});
    assert.equal(preview.code,200); assert.deepEqual(preview.body.preview.rules.milestones,program.milestones);
    assert.deepEqual((await f.engine.settings(f.pool,1)).rules,before);
    const applied = await call(routes,'post','/command',{message,execute:true,preview:{action:'configure',rules:{referrer_amount:99999}}});
    assert.equal(applied.code,200);
    const configured = (await f.engine.settings(f.pool,1)).rules;
    assert.deepEqual(configured.milestones,program.milestones); assert.equal(configured.referrer_amount,2000);
    assert.deepEqual((await f.engine.createCode(1,1,1)).rules_snapshot,before);
    assert.equal((await call(routes,'post','/command',{message:'Duplica todos los bonos',execute:true})).code,400);
    assert.deepEqual((await f.engine.settings(f.pool,1)).rules,configured);
  });
}

test('etapas: perder y recuperar los umbrales, pausar o cambiar reglas no reactiva premios anulados',async t=>{
  const f = await fixture(t,{rules:preset('escalera')}); const sourceOrders=[];
  for (let n=1;n<=5;n++) sourceOrders.push((await qualify(f,n)).order);
  const initial = await rewards(f);
  for (const order of sourceOrders.slice(0,3)) await f.query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.id]);
  await f.engine.reconcile(1);
  const milestones = (await rewards(f)).filter(r=>r.benefit_key.startsWith('milestone:'));
  assert.equal(milestones.length,2); assert.ok(milestones.every(r=>r.status==='void'));
  for (const reward of milestones) {
    const order = await f.addOrder(OWNER_PHONE,'draft');
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/anulado/);
  }
  for (const enabled of [false,true]) await f.engine.saveSettings(1,1,{enabled,rules:{...preset('doble'),gift_product_id:1}});
  for (let n=6;n<=8;n++) await qualify(f,n);
  for (const order of sourceOrders.slice(0,3)) await f.query("UPDATE orders SET status='paid' WHERE id=$1",[order.id]);
  await f.engine.reconcile(1); await f.engine.reconcile(1);
  assert.deepEqual((await rewards(f)).filter(r=>r.benefit_key.startsWith('milestone:')),milestones);
  assert.equal((await rewards(f)).length,initial.length+6);
  assert.equal((await f.query("SELECT * FROM referrals WHERE status='rejected'")).rows.length,3);
});

test('todos los tipos de bono: solicitudes simultáneas con conexiones serializadas solo permiten un canje',async t=>{
  const f = await fixture(t,{rules:preset('escalera')});
  for (let n=1;n<=5;n++) await qualify(f,n);
  const pending = await f.addReferral(6); await f.engine.reconcile(1);
  const available = await rewards(f);
  const candidates = [
    available.find(r=>r.beneficiary_phone===pending.referred_phone),
    available.find(r=>r.benefit_key.startsWith('referral:')),
    available.find(r=>r.benefit_key==='milestone:3'),
    available.find(r=>r.benefit_key==='milestone:5'),
  ];
  for (const reward of candidates) {
    const orders = [await f.addOrder(reward.beneficiary_phone,'draft'),await f.addOrder(reward.beneficiary_phone,'draft')];
    const results = await Promise.allSettled(orders.map(o=>f.engine.redeem(1,1,reward.id,o.id,false,10000)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const rejected = results.find(r=>r.status==='rejected');
    assert.equal(rejected.reason.status,409); assert.match(rejected.reason.message,/usado/);
    const saved = await row(f,'referral_rewards',reward.id);
    assert.ok(orders.some(o=>o.id===saved.redeemed_order_id));
    const items = (await f.query('SELECT items FROM orders WHERE id=ANY($1::int[])',[orders.map(o=>o.id)])).rows.flatMap(o=>JSON.parse(o.items));
    assert.equal(items.filter(i=>i.referral_reward_id===String(reward.id)).length,1);
    assert.equal((await f.query("SELECT * FROM referral_program_audit WHERE action='reward_redeemed' AND details->>'reward_id'=$1",[String(reward.id)])).rows.length,1);
  }
  assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,9);
  assert.ok(f.locks.length>0); assert.ok(f.locks.every(args=>args[0]===1));
});

test('restricciones SQL rechazan tokens, derechos y compras duplicados, incluso con bonos anulados o vencidos',async t=>{
  const f = await fixture(t,{rules:preset('escalera')});
  for (let n=1;n<=5;n++) await qualify(f,n);
  const all = await rewards(f);
  const candidates = [all.find(r=>r.benefit_key==='welcome'),all.find(r=>r.benefit_key.startsWith('referral:')),
    all.find(r=>r.benefit_key==='milestone:3'),all.find(r=>r.benefit_key==='milestone:5')];
  const clone = (reward,token,key,org=1) => f.query(`INSERT INTO referral_rewards
    (organization_id,referral_code_id,referral_id,beneficiary_phone,benefit_key,token,kind,amount,product_id,quantity,expires_at)
    SELECT $4,referral_code_id,referral_id,beneficiary_phone,$3,$2,kind,amount,product_id,quantity,expires_at
    FROM referral_rewards WHERE organization_id=1 AND id=$1`,[reward.id,token,key,org]);
  for (const reward of candidates) {
    await assert.rejects(()=>clone(reward,reward.token,`other:${reward.id}`),{code:'23505'});
    for (const status of ['available','void']) {
      await f.query("UPDATE referral_rewards SET status=$2,expires_at=NOW()-INTERVAL '1 day' WHERE id=$1",[reward.id,status]);
      await assert.rejects(()=>clone(reward,'BONO-FFFFFFFFFFFFFFFF',reward.benefit_key),{code:'23505'});
      await assert.rejects(()=>clone(reward,'BONO-EEEEEEEEEEEEEEEE','other',2),{code:'23503'});
    }
  }
  const first = (await f.query('SELECT * FROM referrals ORDER BY id LIMIT 1')).rows[0];
  await assert.rejects(()=>f.query(`INSERT INTO referrals(organization_id,referral_code_id,referred_phone)
    VALUES(1,$1,$2)`,[f.code.id,first.referred_phone]),{code:'23505'});
  await assert.rejects(()=>f.query(`INSERT INTO referrals(organization_id,referral_code_id,referred_phone,qualifying_source,qualifying_order_id)
    VALUES(1,$1,'56977777777',$2,$3)`,[f.code.id,first.qualifying_source,first.qualifying_order_id]),{code:'23505'});
  assert.equal((await rewards(f)).length,all.length);
});

test('fallo durante el canje revierte bono, pedido y stock juntos; reintentar permite exactamente un uso',async t=>{
  let fail = true;
  const f = await fixture(t,{rules:preset('escalera'),syncRoutes:async()=>{if(fail)throw new Error('Simulated route write failure');}});
  for (let n=1;n<=5;n++) await qualify(f,n);
  for (const key of ['milestone:3','milestone:5']) {
    const reward = (await rewards(f)).find(r=>r.benefit_key===key);
    const order = await f.addOrder(OWNER_PHONE,'draft'); const before = await row(f,'orders',order.id);
    fail = true;
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/Simulated route/);
    assert.equal((await row(f,'referral_rewards',reward.id)).status,'available');
    assert.deepEqual(await row(f,'orders',order.id),before);
    assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,10);
    fail = false; await f.engine.redeem(1,1,reward.id,order.id);
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/usado/);
  }
  assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,9);
  assert.equal((await f.query("SELECT * FROM referral_program_audit WHERE action='reward_redeemed'")).rows.length,2);
});

test('todas las rutas del programa aplican roles backend y lecturas aisladas por empresa',async t=>{
  const f = await fixture(t,{rules:preset('escalera')}); await qualify(f,1);
  const routes = router(f);
  for (const layer of routes.stack.filter(l=>l.route)) {
    const read = !!layer.route.methods.get;
    for (const role of ['owner','admin','supervisor','agent','coordinador','repartidor']) {
      let allowed = false; const res = response();
      layer.route.stack[0].handle({role},res,()=>{allowed=true;});
      assert.equal(allowed,['owner','admin',...(read?['supervisor']:[])].includes(role),`${layer.route.path}: ${role}`);
      if (!allowed) assert.equal(res.code,403);
    }
  }
  for (const url of ['/','/program']) {
    const other = await call(routes,'get',url,{}, {},2);
    assert.equal(other.code,200);
    for (const key of url==='/'?['data','codes']:['rewards','messages','audit','orders']) assert.equal(other.body[key].length,0,key);
  }
  const reward = (await rewards(f)).find(r=>r.beneficiary_phone===OWNER_PHONE);
  const order = await f.addOrder(OWNER_PHONE,'draft',2);
  await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/Pedido no encontrado/);
  await assert.rejects(()=>f.engine.redeem(2,2,reward.id,order.id),/Bono no encontrado/);
});

test('metas personalizadas: cinco etapas, cantidades de bandejas y un solo bono de cada tipo por pedido',async t=>{
  const milestones = [
    {count:1,kind:'discount',amount:500,quantity:1},
    {count:2,kind:'gift',amount:0,quantity:2},
    {count:3,kind:'discount',amount:2000,quantity:1},
    {count:4,kind:'gift',amount:0,quantity:3},
    {count:5,kind:'gift',amount:0,quantity:1},
  ];
  const f = await fixture(t,{rules:{...preset('escalera'),milestones}});
  for (let n=1;n<=5;n++) {
    await qualify(f,n);
    const reached = (await rewards(f)).filter(r=>r.benefit_key.startsWith('milestone:'));
    assert.equal(reached.length,n);
    assert.equal(reached.at(-1).quantity,milestones[n-1].quantity);
  }
  const stageRewards = (await rewards(f)).filter(r=>r.benefit_key.startsWith('milestone:'));
  const first = await f.addOrder(OWNER_PHONE,'draft');
  await f.engine.redeem(1,1,stageRewards[0].id,first.id);
  await f.engine.redeem(1,1,stageRewards[1].id,first.id); // A discount and a gift may coexist.
  for (const reward of stageRewards.slice(2)) {
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,first.id),/ya tiene un bono/);
    await assert.rejects(()=>f.query("UPDATE referral_rewards SET status='redeemed',redeemed_order_id=$2 WHERE id=$1",[reward.id,first.id]),{code:'23505'});
    assert.equal((await row(f,'referral_rewards',reward.id)).status,'available');
    const next = await f.addOrder(OWNER_PHONE,'draft');
    await f.engine.redeem(1,1,reward.id,next.id);
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,next.id),/usado/);
  }
  assert.equal((await row(f,'orders',first.id)).total_price,'9500');
  assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,4);
  const saved = await row(f,'orders',first.id);
  const items = JSON.parse(saved.items);
  for (const replacement of [items.slice(0,-1),[...items,items.at(-1)],items.map(i=>i.referral_reward_id?{...i,quantity:10}:i)]) {
    await assert.rejects(()=>f.query('UPDATE orders SET items=$2 WHERE id=$1',[first.id,JSON.stringify(replacement)]),{code:'23514'});
  }
  assert.deepEqual(await row(f,'orders',first.id),saved);
  await f.engine.reconcile(1);
  assert.equal((await rewards(f)).length,15);
});

test('cada clase de bono vencido permanece única y nunca descuenta dinero ni inventario',async t=>{
  const f = await fixture(t,{rules:preset('escalera')});
  for (let n=1;n<=5;n++) await qualify(f,n);
  const pending = await f.addReferral(6); await f.engine.reconcile(1);
  const all = await rewards(f);
  const selected = [all.find(r=>r.beneficiary_phone===pending.referred_phone),
    all.find(r=>r.benefit_key.startsWith('referral:')),all.find(r=>r.benefit_key==='milestone:3'),all.find(r=>r.benefit_key==='milestone:5')];
  for (const reward of selected) {
    await f.query("UPDATE referral_rewards SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[reward.id]);
    const order = await f.addOrder(reward.beneficiary_phone,'draft');
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id,true),/venció/);
    await assert.rejects(()=>f.engine.redeem(1,1,reward.id,order.id),/venció/);
    assert.equal((await row(f,'orders',order.id)).total_price,'10000');
    assert.equal(JSON.parse((await row(f,'orders',order.id)).items).length,1);
  }
  await f.engine.reconcile(1); await f.engine.reconcile(1);
  assert.deepEqual((await rewards(f)).map(r=>r.token),all.map(r=>r.token));
  assert.equal((await f.query('SELECT stock FROM products WHERE id=1')).rows[0].stock,10);
  assert.equal((await f.query("SELECT * FROM referral_program_audit WHERE action='reward_redeemed'")).rows.length,0);
});

test('identidad única entre códigos, teléfonos formateados, captura WhatsApp y registro manual',async t=>{
  const f = await fixture(t,{rules:preset('escalera')}); const routes = router(f);
  const {rows:[duplicate]} = await f.query("INSERT INTO contacts(organization_id,phone,name) VALUES(1,'+56 9 1111 1111','Ana duplicada') RETURNING id");
  assert.equal((await f.engine.createCode(1,1,duplicate.id)).id,f.code.id);
  const {rows:[second]} = await f.query("INSERT INTO contacts(organization_id,phone,name) VALUES(1,'56988888888','Otro comprador') RETURNING id");
  await f.addOrder('56988888888');
  const otherCode = await f.engine.createCode(1,1,second.id);
  const claimed = await call(routes,'post','/claims',{code:f.code.code,referred_phone:'+56 9 7777 7777'});
  assert.equal(claimed.code,201);
  assert.equal((await call(routes,'post','/claims',{code:otherCode.code,referred_phone:'977777777'})).code,409);
  assert.equal((await call(routes,'post','/claims',{code:f.code.code,referred_phone:OWNER_PHONE})).code,400);
  assert.equal((await call(routes,'post','/claims',{code:f.code.code,referred_phone:'56988888888'})).code,409);
  const {rows:[conv]} = await f.query("INSERT INTO conversations(organization_id,phone_number) VALUES(1,'977777777') RETURNING id");
  assert.equal(await f.capture.captureInboundReferral(1,conv.id,otherCode.code),null);
  await f.engine.reconcile(1);
  const {referral} = claimed.body; const params={id:String(referral.id)};
  assert.equal((await call(routes,'patch',`/${referral.id}/status`,{status:'rejected',note:'Duplicado detectado'},params)).code,200);
  assert.equal((await call(routes,'patch',`/${referral.id}/status`,{status:'pending'},params)).code,409);
  assert.equal((await call(routes,'post','/claims',{code:otherCode.code,referred_phone:'56977777777'})).code,409);
  await f.engine.reconcile(1);
  const only = await rewards(f);
  assert.equal(only.length,1); assert.equal(only[0].status,'void');
  assert.equal((await f.query('SELECT * FROM referrals WHERE organization_id=1')).rows.length,1);
});

test('revisiones y capturas simultáneas serializadas no duplican conversiones, metas ni avisos',async t=>{
  const f = await fixture(t,{rules:preset('escalera')});
  for (let n=1;n<=5;n++) { const ref=await f.addReferral(n); await f.addOrder(ref.referred_phone); }
  const result = await Promise.all([f.engine.reconcile(1),f.engine.reconcile(1),f.engine.reconcile(1)]);
  assert.equal(result.reduce((sum,r)=>sum+r.qualified,0),5);
  assert.equal(result.reduce((sum,r)=>sum+r.issued,0),12);
  assert.equal((await rewards(f)).length,12);
  assert.equal((await f.query('SELECT * FROM referral_messages WHERE reward_id IS NOT NULL')).rows.length,12);
  const {rows:[conv]} = await f.query("INSERT INTO conversations(organization_id,phone_number) VALUES(1,'56966666666') RETURNING id");
  const captures = await Promise.all([f.capture.captureInboundReferral(1,conv.id,f.code.code),f.capture.captureInboundReferral(1,conv.id,f.code.code)]);
  assert.equal(captures.filter(Boolean).length,1);
  const ref = captures.find(Boolean);
  assert.equal((await f.query("SELECT * FROM referral_events WHERE referral_id=$1 AND event_type='created'",[ref.id])).rows.length,1);
});

test('compras Shopify independientes alcanzan etapas una vez; reembolsos invalidan premios pendientes',async t=>{
  const f = await fixture(t,{rules:preset('escalera')});
  for (let n=1;n<=5;n++) {
    const ref = await f.addReferral(n);
    await f.query(`INSERT INTO shopify_orders(organization_id,shopify_order_id,customer_phone,total_price,financial_status,shopify_created_at,delivered_at)
      VALUES(1,$1,$2,10000,'PAID',NOW()-INTERVAL '1 day',NOW())`,[`shop-${n}`,ref.referred_phone]);
  }
  assert.equal((await f.engine.reconcile(1)).qualified,5);
  assert.equal((await rewards(f)).length,12);
  assert.equal((await f.engine.reconcile(1)).issued,0);
  await f.query("UPDATE shopify_orders SET financial_status='PARTIALLY_REFUNDED' WHERE shopify_order_id IN ('shop-1','shop-2','shop-3')");
  await f.engine.reconcile(1);
  const milestones = (await rewards(f)).filter(r=>r.benefit_key.startsWith('milestone:'));
  assert.equal(milestones.length,2); assert.ok(milestones.every(r=>r.status==='void'));
  assert.equal((await f.query("SELECT * FROM referrals WHERE status='rejected'")).rows.length,3);
  await f.query("UPDATE shopify_orders SET financial_status='PAID'");
  await f.engine.reconcile(1);
  assert.deepEqual((await rewards(f)).filter(r=>r.benefit_key.startsWith('milestone:')),milestones);
});
