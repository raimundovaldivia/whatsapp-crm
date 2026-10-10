function money(value) {
  const amount = Number(String(value || '').replace(/[^0-9]/g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function confirmedMessage(history = []) {
  return [...history].reverse().find(item =>
    item?.direction === 'outbound'
    && /¿?todo correcto\??/i.test(String(item.content || ''))
    && /(?:total|precio)\s*:?\s*\$?\s*[\d.]+/i.test(String(item.content || ''))
  ) || null;
}

/**
 * Recupera exactamente el resumen que el cliente acaba de aprobar. Además del
 * total, conserva el nombre/variante mostrado para impedir que una nueva
 * búsqueda difusa cambie, por ejemplo, "Jumbo" por "XL" al crear el pedido.
 */
function parseConfirmedSummary(history = []) {
  const message = confirmedMessage(history);
  if (!message) return null;

  const content = String(message.content || '');
  const totalMatch = content.match(/(?:total|precio)\s*:?\s*\$?\s*([\d.]+)/i);
  const total = money(totalMatch?.[1]);
  if (!total) return null;

  const items = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:📦\s*)?(\d+)\s*x\s+(.+?)\s+(?:—|–|-)\s*\$\s*([\d.]+)\s*$/iu);
    if (!match) continue;
    const quantity = Math.max(1, Number(match[1]) || 1);
    const lineTotal = money(match[3]);
    const name = match[2].trim();
    if (name && lineTotal) items.push({ quantity, name, lineTotal });
  }

  return { total, items };
}

function parseConfirmedQuote(history = []) {
  return parseConfirmedSummary(history)?.total || null;
}

function preserveConfirmedQuote(priced, history = []) {
  const confirmed = parseConfirmedSummary(history);
  if (!confirmed || !priced || !Array.isArray(priced.items)) return priced;

  // Cuando todas las líneas están presentes, la confirmación del cliente es
  // la fuente de verdad para presentación, variante y precio. Se eliminan los
  // IDs inferidos porque podrían corresponder al producto equivocado; en modo
  // Shopify se guardará como línea personalizada en vez de enlazar otra variante.
  const sameConfirmedQuantities = confirmed.items.length > 0
    && confirmed.items.length === priced.items.length
    && confirmed.items.every((accepted, index) => Number(accepted.quantity) === Number(priced.items[index]?.quantity));
  if (sameConfirmedQuantities) {
    const items = priced.items.map((item, index) => {
      const accepted = confirmed.items[index];
      return {
        ...item,
        product_name: accepted.name,
        name: accepted.name,
        title: accepted.name,
        quantity: accepted.quantity,
        price: accepted.lineTotal / accepted.quantity,
        subtotal: accepted.lineTotal,
        product_id: null,
        variant_id: null,
        matched: true,
        locked_quote: true,
      };
    });
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const discountAmount = Math.max(0, subtotal - confirmed.total);
    const discountPct = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
    return {
      ...priced,
      items,
      subtotal,
      total: confirmed.total,
      discountPct,
      discountAmount,
      preservedQuote: true,
    };
  }

  // El cliente corrigió cantidad o composición después del resumen. Ese
  // resumen ya no es una cotización aceptada y no puede pisar el recálculo.
  if (confirmed.items.length > 0) return priced;

  // Compatibilidad con resúmenes antiguos que sólo incluían el total.
  if (priced.items.length !== 1 || Number(priced.total) === confirmed.total) return priced;
  const quantity = Math.max(1, Number(priced.items[0].quantity) || 1);
  const item = { ...priced.items[0], price: confirmed.total / quantity, subtotal: confirmed.total };
  return {
    ...priced,
    items: [item], subtotal: confirmed.total, total: confirmed.total,
    discountPct: 0, discountAmount: 0,
    preservedQuote: true,
  };
}

module.exports = { parseConfirmedSummary, parseConfirmedQuote, preserveConfirmedQuote };
