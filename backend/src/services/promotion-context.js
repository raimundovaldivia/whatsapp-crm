/**
 * Convierte el último template promocional de la conversación en reglas
 * comerciales estructuradas. Así el precio no queda a interpretación del LLM.
 */
const pricing = require('./order-pricing');

const TZ = 'America/Santiago';

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chileDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('sv-SE', { timeZone: TZ });
}

function money(value) {
  return Number(String(value || '').replace(/[^0-9]/g, '')) || 0;
}

function parseOffers(body) {
  const offers = [];
  const seen = new Set();
  const re = /\b(\d{1,4})\s+([a-záéíóúüñ][^|$\n]{0,45}?)\s*\$\s*([\d.]+)/giu;
  for (const match of String(body || '').matchAll(re)) {
    const units = Number(match[1]);
    const descriptor = match[2].replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '').trim();
    const price = money(match[3]);
    const key = `${units}_${norm(descriptor)}_${price}`;
    if (!units || !descriptor || !price || seen.has(key)) continue;
    seen.add(key);
    offers.push({ units, descriptor, price, label: `${units} ${descriptor}` });
  }
  return offers;
}

function parseDiscountPct(body) {
  const text = String(body || '');
  const patterns = [
    /(?:descuento|dcto\.?|rebaja)\s+(?:de\s+|del\s+)?(\d{1,3})\s*%/iu,
    /(\d{1,3})\s*%\s+(?:de\s+)?(?:descuento|dcto\.?|off|menos)/iu,
  ];
  for (const pattern of patterns) {
    const value = Number(text.match(pattern)?.[1]);
    if (value > 0 && value <= 100) return value;
  }
  return 0;
}

function explicitUntil(body, sentDay) {
  const m = String(body || '').match(/(?:v[aá]lid[oa]|vigente).{0,30}?hasta(?:\s+el)?\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/iu);
  if (!m) return null;
  let year = m[3] ? Number(m[3]) : Number(String(sentDay || '').slice(0, 4));
  if (year < 100) year += 2000;
  return `${year}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

function parseTemplate(message, products = [], now = new Date()) {
  const content = String(message?.content || '');
  const templateName = content.match(/\[Template:\s*([^\]]+)\]/i)?.[1]?.trim() || '';
  if (!templateName) return null;
  const body = content.replace(/^\s*\[Template:[^\]]+\]\s*/i, '').trim();
  const offers = parseOffers(body);
  const parsedDiscountPct = parseDiscountPct(body);
  // Un template con precios finales y porcentaje informativo no acumula ambos
  // beneficios. Los precios explícitos mandan; el porcentaje se usa cuando la
  // promoción realmente consiste en descontar el subtotal.
  const discountPct = offers.length ? 0 : parsedDiscountPct;
  const promotional = (offers.length > 0 || parsedDiscountPct > 0) && (/promo|promoci[oó]n|oferta|descuento|dcto|rebaja/i.test(`${templateName} ${body}`));
  if (!promotional) return null;

  const sentDay = chileDay(message.created_at || message.createdAt || now);
  const today = chileDay(now);
  const validOnlyToday = /v[aá]lid[oa].{0,45}(solo|s[oó]lo).{0,35}(pedidos?\s+(de|realizados?)\s+)?hoy/iu.test(body)
    || /(oferta|promo(?:ci[oó]n)?).{0,30}(solo|s[oó]lo)\s+por\s+hoy/iu.test(body);
  const validUntil = explicitUntil(body, sentDay) || (validOnlyToday ? sentDay : null);
  const active = !validUntil || (!!today && today <= validUntil);
  const cutoffMatch = body.match(/antes\s+de\s+las?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/iu);
  const cutoff = cutoffMatch
    ? `${String(Number(cutoffMatch[1])).padStart(2, '0')}:${cutoffMatch[2] || '00'}${cutoffMatch[3] ? ` ${cutoffMatch[3].replace(/\s|\./g, '').toUpperCase()}` : ''}`
    : null;
  const sameDayConditional = /(mismo\s+d[ií]a|durante\s+el\s+d[ií]a)/iu.test(body);
  const stockConditional = /(si\s+(tenemos|hay)\s+stock|sujeto\s+a\s+stock)/iu.test(body);

  const catalog = pricing.flattenCatalog(products);
  const specialPrices = {};
  for (const offer of offers) {
    const matched = pricing.matchProduct(`${offer.units} ${offer.descriptor}`, catalog);
    if (!matched || matched.ambiguous) continue;
    offer.productId = matched.candidate.product_id;
    offer.productTitle = matched.candidate.title;
    if (offer.productId != null) specialPrices[String(offer.productId)] = offer.price;
    specialPrices[norm(matched.candidate.product_title)] = offer.price;
    specialPrices[norm(matched.candidate.title)] = offer.price;
  }

  return {
    templateName, body, offers, discountPct, specialPrices, sentDay, validUntil, validOnlyToday,
    active, cutoff, sameDayConditional, stockConditional,
  };
}

function fromHistory(history = [], products = [], now = new Date()) {
  const templates = (Array.isArray(history) ? history : [])
    .filter(message => message?.direction === 'outbound' && /\[Template:/i.test(message?.content || ''))
    .reverse();
  for (const message of templates) {
    const promotion = parseTemplate(message, products, now);
    if (promotion) return promotion;
  }
  return null;
}

function snapshot(promotion) {
  if (!promotion) return null;
  const { templateName, offers, discountPct, specialPrices, sentDay, validUntil, validOnlyToday, cutoff, sameDayConditional, stockConditional } = promotion;
  return { templateName, offers, discountPct, specialPrices, sentDay, validUntil, validOnlyToday, cutoff, sameDayConditional, stockConditional };
}

function restore(saved, now = new Date()) {
  if (!saved?.templateName || !Array.isArray(saved.offers)) return null;
  const today = chileDay(now);
  return {
    ...saved,
    specialPrices: saved.specialPrices && typeof saved.specialPrices === 'object' ? saved.specialPrices : {},
    active: !saved.validUntil || (!!today && today <= saved.validUntil),
  };
}

function promptSection(promotion) {
  if (!promotion) return '';
  const options = promotion.offers.map(offer => `- ${offer.label}: $${offer.price.toLocaleString('es-CL')}`).join('\n');
  if (!promotion.active) {
    return `## Promoción vencida\nEl cliente recibió el template ${promotion.templateName}, pero su vigencia terminó el ${promotion.validUntil}. NO uses esos precios. Si pregunta por la oferta, explica brevemente que venció y ofrece revisar los precios actuales.`;
  }
  const deliveryRule = promotion.sameDayConditional
    ? `La entrega el mismo día${promotion.cutoff ? ` requiere confirmar antes de las ${promotion.cutoff}` : ''}${promotion.stockConditional ? ' y está sujeta a stock' : ''}. Esta condición es distinta de la vigencia del precio.`
    : '';
  const priceRule = promotion.discountPct
    ? `Aplica exactamente ${promotion.discountPct}% de descuento al subtotal del pedido.`
    : 'Para estas presentaciones usa el precio promocional, nunca el precio normal del catálogo.';
  return `## Promoción activa recibida por este cliente (${promotion.templateName})\n${options ? `Precios exactos:\n${options}\n` : ''}REGLAS OBLIGATORIAS:\n- ${priceRule}\n- ${promotion.validOnlyToday ? 'La promoción aplica si el pedido queda confirmado hoy. Puede pedir hoy y solicitar entrega para otro día.' : `Vigencia: ${promotion.validUntil || 'sin fecha explícita en el template'}.`}\n- ${deliveryRule || 'No inventes condiciones de entrega que el template no indique.'}\n- No prometas stock; registra el pedido y conserva las condiciones escritas en el template.`;
}

function optionText(promotion) {
  const offers = promotion.offers.map(offer => `${offer.label} a $${offer.price.toLocaleString('es-CL')}`).join(', ');
  return offers || (promotion.discountPct ? `${promotion.discountPct}% de descuento en tu pedido` : 'la promoción indicada');
}

function isFuturePromotionQuestion(message) {
  const text = String(message || '');
  return /(promo|promoci[oó]n|oferta|precio|respetan?|aplica|vigente|vale)/iu.test(text)
    && /(ma[ñn]ana|otro\s+d[ií]a|despu[eé]s|pr[oó]xim[oa]|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/iu.test(text);
}

function futureReply(promotion) {
  if (!promotion) return null;
  if (!promotion.active) {
    return `Esa promoción era válida hasta el ${promotion.validUntil || promotion.sentDay} y ya venció. Puedo ayudarte con los precios disponibles de hoy, ¿qué cantidad necesitas?`;
  }
  const choices = optionText(promotion);
  if (promotion.validOnlyToday) {
    const delivery = promotion.sameDayConditional
      ? ` La entrega el mismo día${promotion.cutoff ? ` era confirmando antes de las ${promotion.cutoff}` : ''}${promotion.stockConditional ? ' y según stock' : ''}; para mañana podemos dejar el despacho programado.`
      : '';
    if (promotion.offers.length) {
      return `Sí, si confirmas el pedido hoy se respeta el precio promocional aunque lo programemos para mañana.${delivery} ¿Cuál te guardo: ${choices}?`;
    }
    return `Sí, si confirmas el pedido hoy se respeta el ${choices} aunque lo programemos para mañana.${delivery} ¿Qué producto y cantidad necesitas?`;
  }
  return promotion.offers.length
    ? `Sí, podemos programar la entrega para mañana manteniendo esta promoción. ¿Cuál te guardo: ${choices}?`
    : `Sí, podemos programar la entrega para mañana manteniendo el ${choices}. ¿Qué producto y cantidad necesitas?`;
}

module.exports = { parseOffers, parseDiscountPct, parseTemplate, fromHistory, snapshot, restore, promptSection, isFuturePromotionQuestion, futureReply, norm, chileDay };
