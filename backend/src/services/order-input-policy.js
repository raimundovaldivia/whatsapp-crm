function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ambiguousQuantityToken(value = '') {
  const match = normalize(value).match(/\b\d{1,3}o\b/);
  return match?.[0] || null;
}

// Only unambiguous, current customer declarations override model extraction.
// Old summaries and contact/profile names are fallbacks, not new instructions.
function explicitCustomerName(value = '') {
  const clauses = String(value).normalize('NFC').split(/[,;!\n]+|(?<!\b[A-ZÁÉÍÓÚÜÑ])\./u);
  let name = null;
  for (const clause of clauses) {
    if (/[¿?]/u.test(clause)) continue;
    const match = clause.match(/\b(?:(?:a\s+nombre\s+de|mi\s+nombre\s+es|me\s+llamo)\s+|nombre\s*(?:del\s+cliente)?\s*:\s*)(.+)$/iu);
    if (!match) continue;
    const before = normalize(clause.slice(0, match.index));
    if (/\b(?:no|ni|nunca|antes|anterior|anteriormente|ayer|si)\b/u.test(before)) continue;
    const candidate = match[1].split(/\s+(?:(?:y|pero)\s+)?(?:sin\s+cobro|sin\s+despacho|con\s+(?:entrega|despacho)|para\s+(?:hoy|mañana)|por\s+favor\b|porfa\b|gracias\b|quiero\b|necesito\b|quisiera\b|vivo\b|pago\b|mi\s+(?:direcci[oó]n|tel[eé]fono)\b)/iu)[0].trim();
    if (candidate.length > 120 || candidate.split(/\s+/u).length > 12) continue;
    if (!/^[\p{L}\p{M}][\p{L}\p{M}\p{N}'’.\- ]*$/u.test(candidate)) continue;
    if (/^(?:quien|cual|pendiente|por confirmar|nombre|telefono|direccion)$/u.test(normalize(candidate))) continue;
    name = candidate.replace(/\s+/gu, ' ');
  }
  return name;
}

function resolveCustomerName(message, previousName, extractedName) {
  const explicit = explicitCustomerName(message);
  if (explicit) return explicit;
  // A later address/payment message cannot restore a name from an old order.
  // Other natural wording remains supported when the model's name is actually
  // present in the current message, or there is no previously collected name.
  const words = value => normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const candidate = words(extractedName || '');
  if (!previousName || (candidate && ` ${words(message)} `.includes(` ${candidate} `))) {
    return extractedName || previousName;
  }
  return previousName;
}

function isBareAffirmative(value = '') {
  // Reconocer la frase completa, sin un límite de 20 caracteres ni prefijos
  // abiertos ("si cambio...", "ok pero..."). No contiene productos nuevos.
  if (/[¿?]/u.test(String(value))) return false;
  const text = normalize(value).replace(/[,.!;:¡\p{Emoji_Modifier}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:si+|yes|claro|dale|ok(?:ay|ey|a)?|bueno|perfecto|correcto|confirmo(?: (?:el|mi|este) (?:pedido|resumen)(?: de prueba)?)?|adelante|procede|listo|vamos?|por supuesto|de acuerdo|todo correcto|👍)(?: (?:si+|claro|confirmo(?: (?:el|mi|este) (?:pedido|resumen)(?: de prueba)?)?|por supuesto|de acuerdo|todo correcto|(?:lo|la|los|las) espero|(?:aca|aqui) estoy|estoy en casa|(?:muchas )?gracias|por favor|porfa|👍|😊))*$/u.test(text);
}

function itemName(item = {}) {
  return normalize(item.product_name || item.name || item.title || '');
}

function itemTokens(item) {
  const ignored = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'por']);
  return new Set(itemName(item).split(/[^a-z0-9]+/).filter(token => token.length > 1 && !ignored.has(token)));
}

function sameItem(left, right) {
  const a = itemName(left);
  const b = itemName(right);
  if (!a || !b) return false;
  if (a === b || (a.length >= 8 && b.includes(a)) || (b.length >= 8 && a.includes(b))) return true;
  const aTokens = itemTokens(left);
  const bTokens = itemTokens(right);
  const category = token => token.startsWith('huevo') ? 'huevo'
    : token.startsWith('queso') ? 'queso'
      : token.startsWith('aceituna') ? 'aceituna' : null;
  const aCategories = [...new Set([...aTokens].map(category).filter(Boolean))];
  const bCategories = [...new Set([...bTokens].map(category).filter(Boolean))];
  if (aCategories.length || bCategories.length) {
    if (aCategories.length !== bCategories.length || aCategories.some(token => !bCategories.includes(token))) return false;
  }
  const overlap = [...aTokens].filter(token => bTokens.has(token)).length;
  return overlap >= 2 && overlap / Math.min(aTokens.size, bTokens.size) >= 0.6;
}

/**
 * Un "sí" puede confirmar el resumen existente, pero no introducir un SKU que
 * solo apareció en un mensaje saliente o tarjeta promocional. Los productos
 * nuevos se deben volver a nombrar junto con su cantidad.
 */
function unexpectedItemsFromBareAffirmative(message, previousDraft = {}, nextDraft = {}) {
  if (!isBareAffirmative(message)) return [];
  const previous = Array.isArray(previousDraft.items) ? previousDraft.items : [];
  const next = Array.isArray(nextDraft.items) ? nextDraft.items : [];
  if (!previous.length) return [];
  return next.filter(item => !previous.some(existing => sameItem(existing, item)));
}

function isWholesaleInquiry(value = '') {
  const text = normalize(value);
  if (!text || text.length > 800) return false;
  if (/\b(?:por mayor|mayorista|mayoreo|precio(?:s)? (?:de |para )?empresa|venta(?:s)? mayorista(?:s)?)\b/.test(text)) return true;
  if (/\b(?:pallets?|palets?|paleds?)\b/.test(text)) return true;
  const boxes = text.match(/\b(\d{1,3})\s+cajas?\b/);
  return Boolean(boxes && Number(boxes[1]) >= 3);
}

module.exports = {
  explicitCustomerName,
  resolveCustomerName,
  ambiguousQuantityToken,
  isBareAffirmative,
  unexpectedItemsFromBareAffirmative,
  isWholesaleInquiry,
  _sameItem: sameItem,
};
