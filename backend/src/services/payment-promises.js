const db = require('../db/database');
const { getPool } = require('../db/database');
const { resolveExplicitDeliveryDate, todayISOChile, formatDateEs } = require('./business-date');
const { isCustomerMessagingHour } = require('./outbound-policy');

const PAYMENT_VERB = /\b(?:te|les|le)?\s*(?:pago|pagare|pagar[eé]|deposito|depositare|depositar[eé]|transfiero|transferire|transferir[eé])\b|\b(?:hago|hare|har[eé])\s+(?:el\s+)?(?:pago|dep[oó]sito|transferencia)\b/iu;
const TEMPORARY_ACCESS_ISSUE = /(?:se\s+me\s+)?(?:bloque[oó]|bloqueada?|venci[oó]|olvid[eé]).{0,45}(?:clave|contrase[ñn]a|banco|bancaria|app)|(?:no\s+puedo|no\s+me\s+deja).{0,45}(?:entrar|ingresar|transferir|depositar|pagar)/iu;

function detectPaymentPromise(message, today = todayISOChile()) {
  const text = String(message || '').trim();
  if (!text || text.length > 300 || !PAYMENT_VERB.test(text)) return null;
  const resolved = resolveExplicitDeliveryDate(text, today);
  if (!resolved.explicit || resolved.conflict || !resolved.date || resolved.date < today) return null;
  return { date: resolved.date, label: formatDateEs(resolved.date) };
}

function isTemporaryPaymentAccessIssue(message) {
  const text = String(message || '').trim();
  return text.length > 0 && text.length <= 300 && TEMPORARY_ACCESS_ISSUE.test(text);
}

async function recordPaymentPromise(orgId, order, promise, note = '') {
  if (!Number.isInteger(Number(orgId)) || !['bot', 'shopify'].includes(order?.source) || !promise?.date) {
    throw Object.assign(new Error('Compromiso de pago inválido'), { status: 400 });
  }
  const table = order.source === 'bot' ? 'orders' : 'shopify_orders';
  const key = order.source === 'bot' ? 'id' : 'shopify_order_id';
  const id = order.source === 'bot' ? Number(order.id) : String(order.id);
  const { rows: [saved] } = await getPool().query(
    `UPDATE ${table}
        SET payment_promised_for = $1::date,
            payment_promise_note = $2,
            payment_promise_recorded_at = NOW(),
            payment_promise_followed_up_at = NULL
      WHERE organization_id = $3 AND ${key} = $4
      RETURNING ${key} AS id, payment_promised_for`,
    [promise.date, String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300), orgId, id]
  );
  if (!saved) throw Object.assign(new Error('Pedido no encontrado en esta organización'), { status: 404 });
  return saved;
}

async function duePromises() {
  const { rows } = await getPool().query(`
    SELECT 'bot' AS source, id::text AS id, organization_id
      FROM orders
     WHERE payment_promised_for IS NOT NULL
       AND payment_promised_for <= (NOW() AT TIME ZONE 'America/Santiago')::date
       AND payment_promise_followed_up_at IS NULL
       AND status = 'entregado'
       AND payment_method IN ('transferencia', 'mixto')
    UNION ALL
    SELECT 'shopify', shopify_order_id, organization_id
      FROM shopify_orders
     WHERE payment_promised_for IS NOT NULL
       AND payment_promised_for <= (NOW() AT TIME ZONE 'America/Santiago')::date
       AND payment_promise_followed_up_at IS NULL
       AND crm_status = 'entregado'
       AND financial_status IS DISTINCT FROM 'paid'
       AND payment_method IN ('transferencia', 'mixto')
    ORDER BY organization_id, id
    LIMIT 100`);
  return rows;
}

async function markFollowedUp(orgId, source, id) {
  const table = source === 'bot' ? 'orders' : 'shopify_orders';
  const key = source === 'bot' ? 'id' : 'shopify_order_id';
  await getPool().query(
    `UPDATE ${table}
        SET payment_promise_followed_up_at = NOW()
      WHERE organization_id = $1 AND ${key} = $2
        AND payment_promise_followed_up_at IS NULL`,
    [orgId, source === 'bot' ? Number(id) : String(id)]
  );
}

async function runPaymentPromiseFollowUps(io = null, now = new Date()) {
  if (!isCustomerMessagingHour(now)) return { sent: 0, skipped: 0, reason: 'outside_customer_hours' };
  const collection = require('./payment-collection');
  let sent = 0;
  let skipped = 0;
  for (const due of await duePromises()) {
    try {
      const order = await collection.getOrderForCharge(due.organization_id, due.source, due.id);
      if (!order) {
        await markFollowedUp(due.organization_id, due.source, due.id);
        skipped++;
        continue;
      }
      const result = await collection.sendChargeRequest(due.organization_id, order, { io });
      if (result?.ok || ['envio_pendiente', 'envio_sin_verificar'].includes(result?.reason)) {
        await markFollowedUp(due.organization_id, due.source, due.id);
        result?.ok ? sent++ : skipped++;
      }
    } catch (error) {
      console.warn(`[PaymentPromise] No se pudo seguir ${due.source}_${due.id}:`, error.message);
    }
  }
  return { sent, skipped };
}

function startPaymentPromiseFollowUpJob(io = null) {
  const run = () => runPaymentPromiseFollowUps(io).catch(error => console.error('[PaymentPromise]', error.message));
  setTimeout(run, 2 * 60 * 1000);
  const timer = setInterval(run, 30 * 60 * 1000);
  timer.unref?.();
}

module.exports = {
  detectPaymentPromise,
  isTemporaryPaymentAccessIssue,
  recordPaymentPromise,
  runPaymentPromiseFollowUps,
  startPaymentPromiseFollowUpJob,
};
