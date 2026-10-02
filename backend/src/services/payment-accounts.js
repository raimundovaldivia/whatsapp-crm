const { getPool } = require('../db/database');

const OPENING_DATE = '2026-09-01';

function digits(value) { return String(value || '').replace(/\D/g, '').slice(-8); }
function asDate(value) { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
function monthBounds(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const month = match ? Number(match[2]) : now.getUTCMonth() + 1;
  if (month < 1 || month > 12) throw Object.assign(new Error('Mes inválido'), { status: 400 });
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { key: `${year}-${String(month).padStart(2, '0')}`, start, end };
}

function inRange(date, start, end) { return date && date >= start && date < end; }

async function getAccounts(orgId, month) {
  const pool = getPool();
  const bounds = monthBounds(month);
  const baseline = new Date(`${OPENING_DATE}T00:00:00.000Z`);
  const [ordersResult, proofsResult, movementsResult] = await Promise.all([
    pool.query(
      `SELECT 'bot' AS source, o.id::text AS id, CONCAT('#BOT-', o.id) AS label,
              COALESCE(NULLIF(o.customer_name,''), c.contact_name, 'Cliente') AS customer_name,
              COALESCE(NULLIF(o.customer_phone,''), c.phone_number) AS phone,
              COALESCE(ct.client_type, 'personal') AS client_type,
              o.total_price::numeric AS total, o.status, o.payment_method,
              COALESCE(o.delivered_at, o.created_at) AS charge_date,
              o.payment_marked_at AS payment_date
         FROM orders o
         LEFT JOIN conversations c ON c.id=o.conversation_id
         LEFT JOIN LATERAL (
           SELECT client_type FROM contacts co
            WHERE co.organization_id=o.organization_id
              AND regexp_replace(co.phone,'[^0-9]','','g')=regexp_replace(COALESCE(NULLIF(o.customer_phone,''),c.phone_number,''),'[^0-9]','','g')
            ORDER BY co.updated_at DESC NULLS LAST LIMIT 1
         ) ct ON TRUE
        WHERE o.organization_id=$1 AND o.status NOT IN ('cancelled','cancelado')
          AND o.payment_method='transferencia'
          AND (o.delivered_at IS NOT NULL OR o.status IN ('entregado','paid'))
          AND COALESCE(o.delivered_at,o.created_at) >= $2::date
       UNION ALL
       SELECT 'shopify', s.shopify_order_id, COALESCE(NULLIF(s.shopify_name,''), '#' || s.shopify_order_id),
              COALESCE(NULLIF(s.customer_name,''), 'Cliente'), s.customer_phone,
              COALESCE(ct.client_type, 'personal'), s.total_price::numeric, s.financial_status,
              s.payment_method, COALESCE(s.delivered_at,s.shopify_created_at,s.synced_at), s.payment_marked_at
         FROM shopify_orders s
         LEFT JOIN LATERAL (
           SELECT client_type FROM contacts co
            WHERE co.organization_id=s.organization_id
              AND regexp_replace(co.phone,'[^0-9]','','g')=regexp_replace(COALESCE(s.customer_phone,''),'[^0-9]','','g')
            ORDER BY co.updated_at DESC NULLS LAST LIMIT 1
         ) ct ON TRUE
        WHERE s.organization_id=$1 AND COALESCE(s.crm_status,'') <> 'cancelled'
          AND s.payment_method='transferencia'
          AND (s.delivered_at IS NOT NULL OR s.crm_status='entregado' OR UPPER(COALESCE(s.financial_status,''))='PAID')
          AND COALESCE(s.delivered_at,s.shopify_created_at,s.synced_at) >= $2::date`,
      [orgId, OPENING_DATE]
    ),
    pool.query(
      `SELECT id, order_id, status, created_at, bank_verified_at, bank_movement_id,
              reconciliation_score, reconciliation_confidence, verification_method, amount_matches
         FROM payment_proofs WHERE organization_id=$1
        ORDER BY CASE status WHEN 'verified' THEN 0 WHEN 'pre_verified' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
                 bank_movement_id DESC NULLS LAST, created_at DESC`, [orgId]
    ),
    pool.query(
      `SELECT id, amount, date, payer, doc_number, matched_orders, matched_at, match_method
         FROM bank_movements WHERE organization_id=$1 AND status='matched'`, [orgId]
    ),
  ]);

  const proofByOrder = new Map();
  for (const proof of proofsResult.rows) {
    if (proof.order_id != null && !proofByOrder.has(String(proof.order_id))) proofByOrder.set(String(proof.order_id), proof);
  }
  const bankByOrder = new Map();
  for (const movement of movementsResult.rows) {
    let matched = movement.matched_orders;
    if (typeof matched === 'string') { try { matched = JSON.parse(matched); } catch { matched = []; } }
    for (const order of Array.isArray(matched) ? matched : []) bankByOrder.set(`${order.source}:${order.id}`, movement);
  }

  const accounts = new Map();
  for (const row of ordersResult.rows) {
    const chargeDate = asDate(row.charge_date);
    if (!chargeDate || chargeDate < baseline || chargeDate >= bounds.end) continue;
    const proof = row.source === 'bot' ? proofByOrder.get(String(row.id)) : null;
    const bank = bankByOrder.get(`${row.source}:${row.id}`) || (proof?.bank_movement_id ? movementsResult.rows.find(m => Number(m.id) === Number(proof.bank_movement_id)) : null);
    const paid = row.source === 'bot'
      ? String(row.status).toLowerCase() === 'paid' || proof?.status === 'verified' || !!bank
      : String(row.status).toUpperCase() === 'PAID' || !!bank;
    const paymentDate = paid ? (asDate(bank?.matched_at) || asDate(proof?.bank_verified_at) || asDate(row.payment_date) || asDate(proof?.created_at) || chargeDate) : null;
    const amount = Math.round(Number(row.total) || 0);
    const phone = digits(row.phone);
    const normalizedName = String(row.customer_name || '').toLowerCase().trim();
    // Sin teléfono, un nombre genérico no identifica a una cuenta real. Mantener
    // esos pedidos separados evita mezclar deudas de clientes distintos.
    const key = phone || (/^(cliente|sin nombre)?$/.test(normalizedName)
      ? `order:${row.source}:${row.id}`
      : `name:${normalizedName}`);
    if (!accounts.has(key)) accounts.set(key, {
      key, customer_name: row.customer_name || 'Cliente', customer_phone: row.phone || null,
      client_type: row.client_type === 'empresa' ? 'empresa' : 'personal', orders: [],
    });
    accounts.get(key).orders.push({
      source: row.source, id: row.id, label: row.label, amount, status: row.status,
      charge_date: chargeDate, payment_date: paymentDate, paid,
      evidence: {
        voucher_id: proof?.id || null, voucher_status: proof?.status || null,
        bank_movement_id: bank?.id || null, bank_payer: bank?.payer || null,
        bank_date: bank?.date || null, bank_reference: bank?.doc_number || null,
        verification_method: proof?.verification_method || bank?.match_method || null,
        score: proof?.reconciliation_score == null ? null : Number(proof.reconciliation_score),
        confidence: proof?.reconciliation_confidence || null,
      },
    });
  }

  const result = [];
  for (const account of accounts.values()) {
    let opening = 0, charges = 0, payments = 0;
    const entries = [];
    for (const order of account.orders) {
      if (order.charge_date < bounds.start) opening += order.amount;
      else if (inRange(order.charge_date, bounds.start, bounds.end)) {
        charges += order.amount;
        entries.push({ type: 'charge', date: order.charge_date, amount: order.amount, order });
      }
      if (order.paid && order.payment_date) {
        if (order.payment_date < bounds.start) opening -= order.amount;
        else if (inRange(order.payment_date, bounds.start, bounds.end)) {
          payments += order.amount;
          entries.push({ type: 'payment', date: order.payment_date, amount: order.amount, order });
        }
      }
    }
    const closing = opening + charges - payments;
    if (!entries.length && closing === 0) continue;
    result.push({
      ...account, opening_balance: opening, charges, payments, closing_balance: closing,
      entries: entries.sort((a, b) => a.date - b.date).map(e => ({ ...e, date: e.date.toISOString() })),
      orders: account.orders.map(o => ({ ...o, charge_date: o.charge_date?.toISOString(), payment_date: o.payment_date?.toISOString() })),
    });
  }
  result.sort((a, b) => b.closing_balance - a.closing_balance || a.customer_name.localeCompare(b.customer_name));
  return {
    month: bounds.key, openingDate: OPENING_DATE, accounts: result,
    summary: {
      customers: result.length,
      debtors: result.filter(a => a.closing_balance > 0).length,
      receivable: result.reduce((sum, a) => sum + Math.max(0, a.closing_balance), 0),
      charges: result.reduce((sum, a) => sum + a.charges, 0),
      payments: result.reduce((sum, a) => sum + a.payments, 0),
    },
  };
}

module.exports = { OPENING_DATE, monthBounds, getAccounts };
