const { createHash } = require('node:crypto');
function fingerprint(draft) {
  return createHash('sha256').update(JSON.stringify({
    items: (draft.items || []).map(i => [i.product_id,i.variant_id,i.quantity,i.price]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    total:draft.total, discount:draft.discount_pct || 0, name:draft.customer_name,
    phone:draft.customer_phone, address:draft.address, city:draft.city,
    notes:draft.notes, editing:draft.editing_order_id,
  })).digest('hex');
}
function matches(previous, current) {
  return !!previous.confirmation_fingerprint && previous.confirmation_fingerprint === fingerprint(current);
}
module.exports = { fingerprint, matches };
