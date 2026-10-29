const pricing = require('./order-pricing');
const { parseConfirmedSummary } = require('./order-quote');

const key = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Se usa antes del modelo y de cualquier cotización del historial. Un resumen
// anterior nunca puede volver disponible un producto retirado del catálogo.
function catalogIssue(priced, products) {
  for (const item of priced.items || []) {
    if (!item.matched) {
      return item.ambiguous
        ? `Para "${item.name}", ¿cuál prefieres: ${item.alternatives.join(' o ')}?`
        : `Necesito confirmar un producto: "${item.name}" no está disponible en el catálogo actual. El pedido todavía no está creado. ¿Quieres consultar otra opción?`;
    }
    if (!item.free_gift && (!Number.isFinite(Number(item.price)) || Number(item.price) <= 0)) {
      return `El precio de "${item.name}" está pendiente de revisión. Todavía no puedo confirmar el pedido.`;
    }
    const product = products.find(p => String(p.id) === String(item.product_id));
    if (!product) continue; // Promociones autorizadas pueden ser formatos compuestos.
    const variant = item.variant_id == null ? null : product.variants?.find(v => String(v.id) === String(item.variant_id));
    const stock = variant ? (variant.inventoryQuantity ?? variant.stock) : (product.inventoryQuantity ?? product.stock);
    if (product.active === false || product.available === false || variant?.available === false
        || (stock != null && Number(stock) !== -1 && (!Number.isFinite(Number(stock)) || Number(stock) < item.quantity))) {
      return `No hay disponibilidad suficiente de "${item.name}" para esa cantidad. Todavía no he creado el pedido. ¿Quieres ajustar la cantidad o consultar otra opción?`;
    }
  }
  return null;
}

function signature(draft, priced) {
  return JSON.stringify({
    items: priced.items.map(i => [key(i.name), Number(i.quantity), Number(i.price)]),
    total: Number(priced.total), name: key(draft.customer_name),
    address: key(draft.address), city: key(draft.city),
    phone: String(draft.customer_phone || ''), date: String(draft.delivery_date || ''), notes: key(draft.notes),
  });
}

function matchesReview(previous, current, priced, history = []) {
  if (previous._reviewed_order && previous._reviewed_order !== signature(current, priced)) return false;
  // Compatibilidad con conversaciones abiertas antes de este cambio: el último
  // mensaje saliente debe ser el resumen, con los mismos productos y total.
  const lastOutbound = [...history].reverse().find(m => m.direction === 'outbound');
  if (previous._reviewed_order) {
    return Boolean(lastOutbound && /todo correcto/i.test(lastOutbound.content)
      && key(lastOutbound.content).includes(key(pricing.summaryBlock(priced))));
  }
  const summary = parseConfirmedSummary(lastOutbound ? [lastOutbound] : []);
  return Boolean(summary && summary.total === Number(priced.total)
    && summary.items.length === priced.items.length && summary.items.length
    && summary.items.every((i, n) => key(i.name) === key(priced.items[n].name)
      && i.quantity === Number(priced.items[n].quantity)
      && i.lineTotal === Number(priced.items[n].price) * i.quantity)
    && ['customer_name', 'address', 'city', 'customer_phone', 'delivery_date'].every(field => key(previous[field]) === key(current[field])));
}

function reviewReply(draft, priced) {
  const phone = draft.requires_customer_phone ? `\n📞 ${draft.customer_phone}` : '';
  const date = draft.delivery_date ? `\n📅 Fecha solicitada: ${draft.delivery_date}` : '';
  const note = draft.notes ? `\n📝 Indicaciones: ${draft.notes}` : '';
  return `Revisa el resumen antes de crear tu pedido:\n\n${pricing.summaryBlock(priced)}\n👤 ${draft.customer_name}\n📍 ${draft.address}, ${draft.city}${phone}${date}${note}\n\n¿Todo correcto? El pedido todavía no está creado y la entrega está pendiente de confirmación.`;
}

module.exports = { catalogIssue, signature, matchesReview, reviewReply };
