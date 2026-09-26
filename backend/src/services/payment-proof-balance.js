const db = require('../db/database');

function positiveAmount(value) {
  // Database decimals and Vision's numeric JSON; never guess locale separators.
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value))) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function summarizeProofs(proofs, total) {
  const seen = new Set();
  let cents = 0, count = 0, duplicates = 0, unreadable = 0;
  for (const proof of proofs) {
    if (proof.status === 'rejected') continue;
    const amount = positiveAmount(proof.extracted_amount);
    if (amount === null || (proof.extracted_currency && proof.extracted_currency !== 'CLP')) {
      unreadable++;
      continue;
    }
    const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    const reference = normalize(proof.extracted_reference);
    const keys = [
      proof.media_id && `media:${proof.media_id}`,
      proof.image_sha256 && `image:${proof.image_sha256}`,
      reference && `ref:${normalize(proof.extracted_bank)}:${reference}`,
      // If the operation cannot be identified, do not assume two similar receipts are two transfers.
      !reference && `uncertain:${amount}:${normalize(proof.extracted_date)}:${normalize(proof.extracted_bank)}`,
    ].filter(Boolean);
    const duplicate = keys.some(key => seen.has(key));
    keys.forEach(key => seen.add(key));
    if (duplicate) { duplicates++; continue; }
    cents += amount;
    count++;
  }
  const target = positiveAmount(total);
  return { total: target === null ? null : target / 100, received: cents / 100, count, duplicates, unreadable,
    remaining: target === null ? null : Math.max(0, target - cents) / 100,
    excess: target === null ? null : Math.max(0, cents - target) / 100 };
}

async function getOrderProofBalance(orgId, orderId, total) {
  const { rows } = await db.getPool().query(
    `SELECT pp.* FROM payment_proofs pp
     JOIN orders o ON o.id = pp.order_id AND o.organization_id = pp.organization_id
     WHERE pp.organization_id = $1 AND pp.order_id = $2
     ORDER BY pp.created_at, pp.id`, [orgId, orderId]);
  return summarizeProofs(rows, total);
}

const money = value => `$${Number(value).toLocaleString('es-CL')}`;
function balanceText(balance) {
  if (!balance.count || balance.total === null) return 'El equipo revisará el monto del comprobante.';
  const start = `Los comprobantes registrados suman ${money(balance.received)} de ${money(balance.total)}`;
  const detail = balance.remaining > 0 ? `; queda un saldo de ${money(balance.remaining)} por respaldar.`
    : balance.excess > 0 ? `; hay ${money(balance.excess)} por sobre el total para revisar.`
    : '. Con estos abonos se completa el total del pedido.';
  const caveat = balance.duplicates || balance.unreadable
    ? ' Hay comprobantes repetidos, posiblemente repetidos o con datos por revisar que no sumamos nuevamente.' : '';
  return `${start}${detail}${caveat} El equipo confirmará la recepción bancaria.`;
}

module.exports = { positiveAmount, summarizeProofs, getOrderProofBalance, balanceText };
