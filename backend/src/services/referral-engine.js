'use strict';

const crypto = require('node:crypto');
const db = require('../db/database');
const { DEFAULT_RULES, validateRules, invitation, money, fail } = require('./referral-rules');

// Both commerce sources, scoped before any join. A mirrored Shopify order is
// represented by the CRM order only. Refunded/returned purchases cannot qualify.
const PURCHASES = `WITH purchases AS (
  SELECT 'bot'::text AS source, o.id::text AS order_id, o.customer_phone AS phone,
    o.created_at AT TIME ZONE 'UTC' AS created_at, o.delivered_at AT TIME ZONE 'UTC' AS delivered_at,
    COALESCE(o.payment_marked_at,o.created_at) AT TIME ZONE 'UTC' AS purchased_at,
    (o.status='paid' OR o.delivered_at IS NOT NULL) AS purchased,
    CASE WHEN o.total_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN o.total_price::numeric ELSE 0 END AS total,
    COALESCE((SELECT SUM(r.amount) FROM referral_rewards r WHERE r.organization_id=$1 AND r.redeemed_order_id=o.id
      AND r.kind='discount' AND r.status='redeemed'),0) AS referral_discount,
    o.status = 'paid' AND o.delivered_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM shopify_orders mirror WHERE mirror.organization_id=$1
        AND mirror.shopify_order_id=o.shopify_order_id
        AND (LOWER(COALESCE(mirror.financial_status,'')) IN ('refunded','partially_refunded','voided') OR mirror.crm_status='cancelled'))
      AND NOT EXISTS (SELECT 1 FROM order_returns rt WHERE rt.organization_id = $1
        AND ((rt.source = 'bot' AND rt.order_id = o.id::text)
          OR (rt.source = 'shopify' AND rt.order_id = o.shopify_order_id)) AND rt.status <> 'cancelled') AS valid
  FROM orders o WHERE o.organization_id = $1
  UNION ALL
  SELECT 'shopify', s.shopify_order_id, s.customer_phone,
    COALESCE(s.shopify_created_at, s.synced_at) AT TIME ZONE 'UTC', s.delivered_at AT TIME ZONE 'UTC',
    COALESCE(s.payment_marked_at,s.shopify_created_at,s.synced_at) AT TIME ZONE 'UTC',
    (LOWER(COALESCE(s.financial_status,'')) IN ('paid','refunded','partially_refunded') OR s.delivered_at IS NOT NULL),s.total_price,0,
    LOWER(COALESCE(s.financial_status,'')) = 'paid' AND s.delivered_at IS NOT NULL
      AND COALESCE(s.crm_status,'') <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM order_returns rt WHERE rt.organization_id = $1
        AND rt.source = 'shopify' AND rt.order_id = s.shopify_order_id AND rt.status <> 'cancelled')
  FROM shopify_orders s WHERE s.organization_id = $1
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.organization_id = $1 AND o.shopify_order_id = s.shopify_order_id)
)`;
const phoneSql = col => `(CASE WHEN regexp_replace(COALESCE(${col},''),'[^0-9]','','g') ~ '^9[0-9]{8}$'
  THEN '56' || regexp_replace(${col},'[^0-9]','','g') ELSE regexp_replace(COALESCE(${col},''),'[^0-9]','','g') END)`;
function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail('Identificador inválido');
  return id;
}
function conflict(message) { throw Object.assign(new Error(message), { status: 409 }); }
async function transaction(orgId, work, pool = db.getPool()) {
  positiveId(orgId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize reward issuance, settings and redemption for one tenant only.
    await client.query('SELECT pg_advisory_xact_lock(72519, $1::int)', [orgId]);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function audit(client, orgId, actorId, action, details = {}) {
  await client.query('INSERT INTO referral_program_audit(organization_id,actor_id,action,details) VALUES($1,$2,$3,$4::jsonb)',
    [orgId, actorId || null, action, JSON.stringify(details)]);
}
async function settings(client, orgId) {
  const { rows: [s] } = await client.query('SELECT * FROM referral_program_settings WHERE organization_id = $1', [orgId]);
  return { ...s, enabled: s?.enabled === true, configured: !!s?.rules, rules: validateRules(s?.rules || DEFAULT_RULES) };
}
async function saveSettings(orgId, actorId, input) {
  if (typeof input?.enabled !== 'boolean') fail('Indica si el programa está activo');
  const rules = validateRules(input.rules || DEFAULT_RULES);
  return transaction(orgId, async client => {
    if (rules.gift_product_id) {
      const { rows } = await client.query('SELECT id FROM products WHERE organization_id = $1 AND id = $2 AND active = TRUE', [orgId, rules.gift_product_id]);
      if (!rows.length) fail('Selecciona un producto de regalo activo de esta empresa');
    }
    if (input.enabled && rules.milestones.some(m => m.kind === 'gift') && !rules.gift_product_id) fail('Selecciona qué bandeja se entregará antes de activar el programa');
    const { rows: [s] } = await client.query(`INSERT INTO referral_program_settings
      (organization_id,enabled,rules,reward_referrer,reward_referred,terms,updated_by)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT(organization_id) DO UPDATE SET
      enabled=EXCLUDED.enabled, rules=EXCLUDED.rules, reward_referrer=EXCLUDED.reward_referrer,
      reward_referred=EXCLUDED.reward_referred, terms=EXCLUDED.terms, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING *`,
      [orgId,input.enabled,JSON.stringify(rules),money(rules.referrer_amount),money(rules.referred_amount),String(input.terms || '').slice(0,1500),actorId || null]);
    await audit(client,orgId,actorId,'settings_saved',{ enabled: s.enabled, rules });
    return s;
  });
}
async function purchases(client, orgId, phone) {
  const { rows } = await client.query(`${PURCHASES} SELECT * FROM purchases WHERE ${phoneSql('phone')} = $2 ORDER BY created_at,source,order_id`, [orgId,db.normalizePhone(phone)]);
  return rows;
}
async function queueMessage(client, orgId, codeId, phone, name, body, key, auto, rewardId = null, due = null) {
  const { rows: [m] } = await client.query(`INSERT INTO referral_messages
    (organization_id,referral_code_id,reward_id,phone,customer_name,body,dedupe_key,status,due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,NOW()))
    ON CONFLICT(organization_id,dedupe_key) DO NOTHING RETURNING *`,
    [orgId,codeId,rewardId,db.normalizePhone(phone),name || '',body,key,auto ? 'queued' : 'draft',due]);
  return m;
}
async function issueReward(client, orgId, code, referral, phone, key, reward, rules, auto) {
  const { rows: [r] } = await client.query(`INSERT INTO referral_rewards
    (organization_id,referral_code_id,referral_id,beneficiary_phone,benefit_key,token,kind,amount,product_id,quantity,minimum_purchase,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
      ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date + $12::int + 1)::timestamp AT TIME ZONE 'America/Santiago')
    ON CONFLICT(organization_id,beneficiary_phone,benefit_key) DO NOTHING RETURNING *`,
    [orgId,code.id,referral?.id || null,db.normalizePhone(phone),key,`BONO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      reward.kind,reward.amount || 0,reward.kind === 'gift' ? rules.gift_product_id : null,reward.quantity || 1,rules.minimum_purchase,rules.validity_days]);
  if (!r) return null;
  const expiry = new Intl.DateTimeFormat('en-CA',{ timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(new Date(r.expires_at).getTime()-1));
  const body = `Tienes ${r.kind === 'gift' ? `${r.quantity} bandeja(s) gratis para tu próximo pedido` : `${money(r.amount)} de descuento para tu próxima compra`}. Tu bono personal es ${r.token}. Úsalo hasta el ${expiry}. Compra mínima ${money(r.minimum_purchase)}. Un solo uso, no transferible ni acumulable con otro bono del mismo tipo. Si no quieres estos avisos, responde SALIR.`;
  await queueMessage(client,orgId,code.id,phone,'',body,`reward:${r.id}`,auto,r.id);
  await audit(client,orgId,null,'reward_issued',{ reward_id:r.id, benefit_key:key });
  return r;
}
async function createCode(orgId, actorId, contactId, auto = false) {
  positiveId(contactId);
  return transaction(orgId, async client => {
    const s = await settings(client,orgId);
    if (!s.enabled) conflict('Activa y guarda el programa antes de crear invitaciones');
    if (!s.configured) conflict('Guarda las reglas y selecciona la bandeja antes de preparar invitaciones');
    const { rows: [contact] } = await client.query('SELECT id,name,phone,opt_out FROM contacts WHERE organization_id=$1 AND id=$2', [orgId,contactId]);
    if (!contact) throw Object.assign(new Error('Cliente no encontrado'), { status:404 });
    if (contact.opt_out) conflict('Este cliente pidió no recibir mensajes');
    const phone = db.normalizePhone(contact.phone);
    if (!/^\d{8,15}$/.test(phone)) fail('El cliente no tiene un teléfono válido');
    const history = await purchases(client,orgId,phone);
    if (!history.some(p => p.valid && Number(p.total) > 0)) conflict('El cliente necesita una compra pagada y entregada');
    // Legacy duplicate contact records for one canonical phone share one code.
    const { rows: [existing] } = await client.query(`SELECT rc.* FROM referral_codes rc JOIN contacts c
      ON c.organization_id=rc.organization_id AND c.id=rc.referrer_contact_id
      WHERE rc.organization_id=$1 AND ${phoneSql('c.phone')}=$2 ORDER BY rc.id LIMIT 1`, [orgId,phone]);
    let code = existing;
    if (!code) {
      for (let attempt=0;attempt<4 && !code;attempt++) {
        const { rows: [created] } = await client.query(`INSERT INTO referral_codes(organization_id,referrer_contact_id,code,created_by,rules_snapshot,rules_adopted_at)
          VALUES($1,$2,$3,$4,$5::jsonb,NOW()) ON CONFLICT(organization_id,code) DO NOTHING RETURNING *`,
          [orgId,contactId,`REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,actorId || null,JSON.stringify(s.rules)]);
        code = created;
      }
      if (!code) conflict('No se pudo generar un código único; vuelve a intentarlo');
    }
    if (!code.active) conflict('El código del cliente está pausado; actívalo desde el panel');
    if (!code.rules_snapshot || !code.rules_adopted_at) {
      code.rules_snapshot = code.rules_snapshot || s.rules;
      await client.query('UPDATE referral_codes SET rules_snapshot=$3::jsonb,rules_adopted_at=NOW() WHERE organization_id=$1 AND id=$2',[orgId,code.id,JSON.stringify(code.rules_snapshot)]);
    }
    await queueMessage(client,orgId,code.id,phone,contact.name,invitation(contact.name,code.code,code.rules_snapshot),`invite:${phone}`,auto);
    await audit(client,orgId,actorId,'invitation_prepared',{ code_id:code.id });
    return { ...code, referrer_name:contact.name, referrer_phone:phone };
  });
}
async function prepareInvitations(orgId, actorId, automatic = false) {
  const pool = db.getPool();
  const s = await settings(pool,orgId);
  if (!s.enabled) conflict('Activa el programa primero');
  const { rows } = await pool.query(`${PURCHASES} SELECT DISTINCT ON (${phoneSql('c.phone')}) c.id
    FROM contacts c WHERE c.organization_id=$1 AND COALESCE(c.opt_out,FALSE)=FALSE
    AND EXISTS(SELECT 1 FROM purchases p WHERE p.valid AND p.total>0 AND ${phoneSql('p.phone')}=${phoneSql('c.phone')}
      AND p.delivered_at <= NOW() - ($2::int * INTERVAL '1 hour'))
    AND NOT EXISTS(SELECT 1 FROM referral_messages m WHERE m.organization_id=$1 AND m.dedupe_key='invite:' || ${phoneSql('c.phone')})
    ORDER BY ${phoneSql('c.phone')},c.id LIMIT 100`, [orgId,automatic ? s.rules.invite_delay_hours : 0]);
  let prepared = 0;
  for (const c of rows) {
    try { await createCode(orgId,actorId,c.id,automatic && s.rules.auto_send); prepared++; }
    catch (error) { if (![400,409].includes(error.status)) throw error; }
  }
  return { prepared };
}
async function rejectReferral(client, orgId, r, reason) {
  await client.query(`UPDATE referrals SET status='rejected',notes=$3,rejected_at=NOW(),updated_at=NOW() WHERE organization_id=$1 AND id=$2`,[orgId,r.id,reason]);
  await client.query(`UPDATE referral_rewards SET status='void' WHERE organization_id=$1 AND referral_id=$2 AND status='available'`,[orgId,r.id]);
  await client.query(`INSERT INTO referral_events(organization_id,referral_id,event_type,from_status,to_status,note)
    VALUES($1,$2,'status_changed',$3,'rejected',$4)`,[orgId,r.id,r.status,reason]);
  await audit(client,orgId,null,'referral_rejected',{ referral_id:r.id,reason });
}
async function reconcile(orgId) {
  return transaction(orgId, async client => {
    const s = await settings(client,orgId);

    const { rows: refs } = await client.query(`SELECT r.*,rc.rules_snapshot AS code_rules,rc.rules_adopted_at AS code_rules_adopted_at,rc.active,
      rc.referrer_contact_id,c.phone AS referrer_phone FROM referrals r
      JOIN referral_codes rc ON rc.organization_id=r.organization_id AND rc.id=r.referral_code_id
      JOIN contacts c ON c.organization_id=rc.organization_id AND c.id=rc.referrer_contact_id
      WHERE r.organization_id=$1 AND r.status IN ('pending','qualified','rewarded') ORDER BY r.id FOR UPDATE OF r`,[orgId]);
    const stats = { qualified:0,issued:0 };
    for (const r of refs) {
      // Old manual records are kept for audit; no retroactive monetary rewards.
      if (!r.code_rules) continue;
      if (!r.rules_snapshot && (!r.code_rules_adopted_at || new Date(r.created_at)<new Date(r.code_rules_adopted_at))) continue;
      const rules = validateRules(r.rules_snapshot || r.code_rules);
      const code = { id:r.referral_code_id };
      const history = await purchases(client,orgId,r.referred_phone);
      const registered = new Date(r.created_at).getTime();
      const prior = history.some(p => p.purchased && new Date(p.purchased_at).getTime() < registered);
      if (db.normalizePhone(r.referred_phone) === db.normalizePhone(r.referrer_phone) || prior) {
        await rejectReferral(client,orgId,r,'Autorreferencia o comprador con pedidos anteriores al código'); continue;
      }
      if (r.qualifying_order_id) {
        const original = history.find(p => p.source === r.qualifying_source && p.order_id === r.qualifying_order_id);
        if (!original?.valid || Number(original.total)<=0 || Number(original.total)+Number(original.referral_discount)<rules.minimum_purchase) await rejectReferral(client,orgId,r,'La compra dejó de ser válida: cancelación, devolución, monto insuficiente o pago revertido');
        continue;
      }
      if (!s.enabled || !r.active || r.status !== 'pending') continue;
      if (!r.rules_snapshot) await client.query('UPDATE referrals SET rules_snapshot=$3::jsonb WHERE organization_id=$1 AND id=$2',[orgId,r.id,JSON.stringify(rules)]);
      const invitee = await issueReward(client,orgId,code,r,r.referred_phone,'welcome',{ kind:'discount',amount:rules.referred_amount },rules,s.rules.auto_send);
      if (invitee) stats.issued++;
      const valid = history.find(p => p.valid && Number(p.total)>0 && Number(p.total)+Number(p.referral_discount)>=rules.minimum_purchase && new Date(p.purchased_at).getTime()>=registered);
      if (!valid) continue;
      await client.query(`UPDATE referrals SET status='qualified',qualifying_source=$3,qualifying_order_id=$4,qualified_at=NOW(),updated_at=NOW() WHERE organization_id=$1 AND id=$2`,[orgId,r.id,valid.source,valid.order_id]);
      await client.query(`INSERT INTO referral_events(organization_id,referral_id,event_type,from_status,to_status,note)
        VALUES($1,$2,'status_changed','pending','qualified',$3)`,[orgId,r.id,`Compra pagada y entregada ${valid.source}:${valid.order_id}`]);
      const earned = await issueReward(client,orgId,code,r,r.referrer_phone,`referral:${r.id}`,{kind:'discount',amount:rules.referrer_amount},rules,s.rules.auto_send);
      stats.qualified++; if (earned) stats.issued++;
    }
    const { rows: codes } = await client.query(`SELECT rc.*,c.phone FROM referral_codes rc JOIN contacts c
      ON c.organization_id=rc.organization_id AND c.id=rc.referrer_contact_id WHERE rc.organization_id=$1 AND rc.rules_snapshot IS NOT NULL`,[orgId]);
    for (const code of codes) {
      const { rows:[count] } = await client.query(`SELECT COUNT(*)::int AS n FROM referrals WHERE organization_id=$1 AND referral_code_id=$2
        AND status IN ('qualified','rewarded') AND qualifying_order_id IS NOT NULL`,[orgId,code.id]);
      const rules = validateRules(code.rules_snapshot);
      for (const m of rules.milestones) {
        const key = `milestone:${m.count}`;
        if (count.n >= m.count && s.enabled) {
          const reward = await issueReward(client,orgId,code,null,code.phone,key,m,rules,s.rules.auto_send);
          if (reward) stats.issued++;
        } else if (count.n < m.count) {
          await client.query(`UPDATE referral_rewards SET status='void' WHERE organization_id=$1 AND referral_code_id=$2 AND benefit_key=$3 AND status='available'`,[orgId,code.id,key]);
        }
      }
    }
    return stats;
  });
}
async function redeem(orgId, actorId, rewardId, orderId, preview = false, expectedTotal = null) {
  positiveId(rewardId); positiveId(orderId);
  // Revalidate source purchases immediately, even if the scheduler has not run.
  await reconcile(orgId);
  return transaction(orgId, async client => {
    const { rows:[r] } = await client.query('SELECT *,expires_at>NOW() AS unexpired FROM referral_rewards WHERE organization_id=$1 AND id=$2 FOR UPDATE',[orgId,rewardId]);
    if (!r) throw Object.assign(new Error('Bono no encontrado'),{status:404});
    if (r.status !== 'available' || !r.unexpired) conflict('Este bono ya fue usado, anulado o venció');
    const { rows:[order] } = await client.query('SELECT * FROM orders WHERE organization_id=$1 AND id=$2 FOR UPDATE',[orgId,orderId]);
    if (!order) throw Object.assign(new Error('Pedido no encontrado'),{status:404});
    if (db.normalizePhone(order.customer_phone) !== r.beneficiary_phone) conflict('El bono es personal y pertenece a otro cliente');
    if (!['draft','nuevo','confirmed','sent','por_despachar','asignado_ruta'].includes(order.status) || order.delivered_at || order.payment_marked_at) conflict('Aplica el bono antes del pago y la entrega');
    if (order.shopify_order_id || order.shopify_draft_id || order.invoice_url) conflict('Este pedido tiene cobro externo. Usa un pedido independiente del CRM para canjear el bono');
    const { rows: route } = await client.query(`SELECT id FROM delivery_routes WHERE organization_id=$1 AND status NOT IN ('draft','cancelled')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(orders::jsonb) x WHERE x->>'source'='bot' AND x->>'id'=$2) LIMIT 1`,[orgId,String(orderId)]);
    if (route.length) conflict('Canjea el beneficio antes de enviar el pedido a reparto');
    const { rows: used } = await client.query(`SELECT id FROM referral_rewards WHERE organization_id=$1 AND redeemed_order_id=$2 AND kind=$3 AND status='redeemed'`,[orgId,orderId,r.kind]);
    if (used.length) conflict('El pedido ya tiene un bono de este tipo');
    const total = Number(order.total_price);
    if (!preview && expectedTotal !== null && expectedTotal !== total) conflict('El pedido cambió. Revisa nuevamente el canje');
    if (!Number.isSafeInteger(total) || total<=0 || total<r.minimum_purchase) conflict('El pedido no alcanza la compra mínima');
    if (r.kind === 'discount' && total<=r.amount) conflict('El total debe superar el descuento; el bono no genera saldo ni efectivo');
    if (r.benefit_key === 'welcome') {
      const history = await purchases(client,orgId,r.beneficiary_phone);
      if (history.some(p => !(p.source==='bot' && p.order_id===String(orderId)) && p.purchased)) conflict('El descuento de bienvenida es solo para la primera compra');
    }
    let items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    if (!Array.isArray(items)) conflict('Revisa los productos del pedido');
    let product;
    if (r.kind === 'gift') {
      const { rows:[p] } = await client.query('SELECT * FROM products WHERE organization_id=$1 AND id=$2 AND active=TRUE FOR UPDATE',[orgId,r.product_id]);
      if (!p) conflict('La bandeja de regalo ya no está disponible');
      if (Number(p.stock)>=0 && Number(p.stock)<r.quantity) conflict('No hay stock suficiente para el regalo');
      product = p;
    }
    const newTotal = r.kind==='discount' ? total-r.amount : total;
    const result = { reward_id:r.id,order_id:order.id,customer_name:order.customer_name,before:total,after:newTotal,
      benefit:r.kind==='discount' ? money(r.amount) : `${r.quantity} × ${product.title}` };
    if (preview) return result;
    items = [...items,{ id:product?.id || `referral-${r.id}`,title:product?.title || 'Descuento por referido',quantity:r.kind==='gift' ? r.quantity : 1,
      price:r.kind==='discount' ? -r.amount : 0,referral_reward_id:String(r.id),loadItem:r.kind==='gift' }];
    if (product) await client.query('UPDATE products SET stock=CASE WHEN stock>=0 THEN stock-$3 ELSE stock END,updated_at=NOW() WHERE organization_id=$1 AND id=$2',[orgId,product.id,r.quantity]);
    await client.query('UPDATE orders SET items=$3,total_price=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2',[orgId,orderId,JSON.stringify(items),String(newTotal)]);
    await require('./delivery-items').syncOrderIntoUnstartedRoutes(client,orgId,'bot',orderId,items,newTotal);
    await client.query(`UPDATE referral_rewards SET status='redeemed',redeemed_order_id=$3,redeemed_at=NOW(),redeemed_by=$4 WHERE organization_id=$1 AND id=$2`,[orgId,r.id,orderId,actorId]);
    if (r.referral_id && r.benefit_key === `referral:${r.referral_id}`) {
      const { rows: awarded } = await client.query(`UPDATE referrals SET status='rewarded',rewarded_at=NOW(),updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 AND status='qualified' RETURNING id`,[orgId,r.referral_id]);
      if (awarded.length) await client.query(`INSERT INTO referral_events(organization_id,referral_id,actor_id,event_type,from_status,to_status,note)
        VALUES($1,$2,$3,'status_changed','qualified','rewarded',$4)`,[orgId,r.referral_id,actorId,`Bono canjeado en pedido CRM ${orderId}`]);
    }
    await audit(client,orgId,actorId,'reward_redeemed',result);
    return result;
  });
}
module.exports = { PURCHASES,phoneSql,positiveId,transaction,audit,settings,saveSettings,purchases,queueMessage,issueReward,createCode,prepareInvitations,reconcile,redeem };
