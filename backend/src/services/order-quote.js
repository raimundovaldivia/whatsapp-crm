function parseConfirmedQuote(history = []) {
  const message = [...history].reverse().find(item =>
    item?.direction === 'outbound'
    && /¿?todo correcto\??/i.test(String(item.content || ''))
    && /(?:total|precio)\s*:?[\s$]*[\d.]+/i.test(String(item.content || ''))
  );
  if (!message) return null;
  const match = String(message.content).match(/(?:total|precio)\s*:?[\s$]*([\d.]+)/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/\./g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function preserveConfirmedQuote(priced, history = []) {
  const quote = parseConfirmedQuote(history);
  if (!quote || !priced || !Array.isArray(priced.items) || priced.items.length !== 1) return priced;
  if (Number(priced.total) === quote) return priced;
  const quantity = Math.max(1, Number(priced.items[0].quantity) || 1);
  const item = { ...priced.items[0], price: quote / quantity, subtotal: quote };
  return {
    ...priced,
    items: [item], subtotal: quote, total: quote,
    discountPct: 0, discountAmount: 0,
    preservedQuote: true,
  };
}

module.exports = { parseConfirmedQuote, preserveConfirmedQuote };
