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
  // Algunos templates declaran la variedad una vez y después enumeran bloques:
  // "Jumbo: 40 unidades $18.000 | 60 unidades $25.500 | XL: 30 unidades...".
  // El encabezado se hereda hasta que aparece otro; sin esto, "60 Jumbo" y
  // "60 XL" quedaban como dos ofertas indistinguibles llamadas "60 unidades".
  let groupedDescriptor = '';
  const blocks = String(body || '').split('|');
  for (const block of blocks) {
    const headings = [...block.matchAll(/\b(jumbo|extra\s+large|xl|large|mediano|mediana|medium)\s*:\s*(?=\d)/giu)];
    if (headings.length) groupedDescriptor = headings.at(-1)[1].replace(/\s+/g, ' ').trim();

    for (const match of block.matchAll(re)) {
      const units = Number(match[1]);
      let descriptor = match[2].replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '').trim();
      const price = money(match[3]);
      // "Queso 900 g $15.000": 900 g es el tamaño, no una oferta llamada "900 g".
      if (/^(?:g|gr|gramos?|kg|kilos?|ml|litros?)$/iu.test(descriptor)) continue;
      if (groupedDescriptor && /^(?:huevos?|unidades?)$/iu.test(descriptor)) descriptor = groupedDescriptor;
      const key = `${units}_${norm(descriptor)}_${price}`;
      if (!units || !descriptor || !price || seen.has(key)) continue;
      seen.add(key);
      offers.push({ units, descriptor, price, label: `${units} ${descriptor}` });
    }
  }
  // Productos cuyo nombre va antes del tamaño, por ejemplo
  // "Queso de cabra 900 g $15.000". Se revisan por bloque para no absorber
  // el texto introductorio del template ni duplicar las ofertas anteriores.
  for (const block of String(body || '').split('|')) {
    if (!block.includes('$') || /(?:despachos?|env[ií]os?)\s+gratis/iu.test(block)) continue;
    const hasRegularOffer = [...block.matchAll(re)].some(match => {
      const descriptor = match[2].replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '').trim();
      return !/^(?:g|gr|gramos?|kg|kilos?|ml|litros?)$/iu.test(descriptor);
    });
    if (hasRegularOffer) continue;
    const match = block.match(/(?:^|[.!?]\s+)([a-záéíóúüñ][^|$\n]{2,70}?)\s*\$\s*([\d.]+)/iu)
      || block.trim().match(/^([a-záéíóúüñ][^|$\n]{2,70}?)\s*\$\s*([\d.]+)/iu);
    if (!match) continue;
    const label = match[1].replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '').trim();
    const price = money(match[2]);
    const key = `named_${norm(label)}_${price}`;
    if (!label || !price || seen.has(key)) continue;
    seen.add(key);
    offers.push({ units: null, descriptor: label, price, label, named: true });
  }
  return offers;
}

function parseCategoryDiscounts(body) {
  const found = [];
  const patterns = [
    /(\d{1,3})\s*%\s*(?:de\s+)?(?:descuento|dcto\.?|off|menos)\s+(?:en|para|sobre|a)\s+(?:todos?|todas?|los|las)?\s*([^|.\n]+)/giu,
    /(?:descuento|dcto\.?|rebaja)\s+(?:de\s+|del\s+)?(\d{1,3})\s*%\s+(?:en|para|sobre|a)\s+(?:todos?|todas?|los|las)?\s*([^|.\n]+)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of String(body || '').matchAll(pattern)) {
      const pct = Number(match[1]);
      const target = match[2]?.trim().replace(/^(?:todos?|todas?|los|las)\s+/iu, '');
      const genericTarget = /^(?:(?:el|la)\s+)?segund/iu.test(target || '')
        || /^(?:tu\s+)?(?:pedido|compra|orden|subtotal|total)(?:\s+completo)?$/iu.test(target || '');
      if (pct > 0 && pct <= 100 && target && !genericTarget && !found.some(x => x.pct === pct && norm(x.target) === norm(target))) {
        found.push({ pct, target });
      }
    }
  }
  return found;
}

function parseSecondUnitDiscounts(body) {
  const rules = [];
  const pattern = /([a-záéíóúüñ][^|.\n:]{1,45}?)\s+(?:de\s+)?(\d{2,4})\s*(g|gr|gramos?|kg|kilos?)\s*:\s*lleva\s+2\s+(?:unidades?|envases?|potes?|frascos?)[^|.\n]{0,80}?(\d{1,3})\s*%\s+(?:de\s+)?(?:descuento|dcto\.?)\s+en\s+(?:el|la)\s+segund[oa]/giu;
  for (const match of String(body || '').matchAll(pattern)) {
    const pct = Number(match[4]);
    if (!(pct > 0 && pct <= 100)) continue;
    rules.push({
      target: match[1].trim().replace(/^(?:en\s+)?/iu, ''),
      packSize: `${Number(match[2])} ${match[3].toLowerCase()}`,
      pct,
      minQty: 2,
      discountedUnitsPerPair: 1,
    });
  }
  return rules;
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
  const m = String(body || '').match(/(?:v[aá]lid[oa]|vigente).{0,30}?hasta(?:\s+el)?(?:\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))?\s*,?\s*(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/iu);
  if (!m) return null;
  let year = m[3] ? Number(m[3]) : Number(String(sentDay || '').slice(0, 4));
  if (year < 100) year += 2000;
  return `${year}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

function endOfWeek(sentDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sentDay || ''))) return null;
  const date = new Date(`${sentDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + ((7 - date.getUTCDay()) % 7));
  return date.toISOString().slice(0, 10);
}

function parseCutoff(body) {
  const text = String(body || '');
  const extended = text.match(/(?:extendimos|ampliamos|extendido|nuevo\s+horario)[^.!?\n]{0,90}?(?:hasta|a)\s+las?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/iu);
  const regular = text.match(/antes\s+de\s+las?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/iu);
  const match = extended || regular;
  return match
    ? `${String(Number(match[1])).padStart(2, '0')}:${match[2] || '00'}${match[3] ? ` ${match[3].replace(/\s|\./g, '').toUpperCase()}` : ''}`
    : null;
}

function beforeChileCutoff(now, day, cutoff) {
  if (!day || !cutoff || chileDay(now) !== day) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
  const match = cutoff.match(/^(\d{2}):(\d{2})(?:\s+(AM|PM))?$/i);
  if (!match) return false;
  let cutoffHour = Number(match[1]);
  if (match[3]) {
    if (match[3].toUpperCase() === 'PM' && cutoffHour < 12) cutoffHour += 12;
    if (match[3].toUpperCase() === 'AM' && cutoffHour === 12) cutoffHour = 0;
  }
  return hour * 60 + minute <= cutoffHour * 60 + Number(match[2]);
}

function parseTemplate(message, products = [], now = new Date()) {
  const content = String(message?.content || '');
  const templateName = content.match(/\[Template:\s*([^\]]+)\]/i)?.[1]?.trim() || '';
  if (!templateName) return null;
  const body = content.replace(/^\s*\[Template:[^\]]+\]\s*/i, '').trim();
  const offers = parseOffers(body);
  const categoryDiscounts = parseCategoryDiscounts(body);
  const secondUnitDiscounts = parseSecondUnitDiscounts(body);
  const parsedDiscountPct = parseDiscountPct(body);
  // Un template con precios finales y porcentaje informativo no acumula ambos
  // beneficios. Los precios explícitos mandan; el porcentaje se usa cuando la
  // promoción realmente consiste en descontar el subtotal.
  const discountPct = (offers.length || categoryDiscounts.length || secondUnitDiscounts.length) ? 0 : parsedDiscountPct;
  const promotional = (offers.length > 0 || parsedDiscountPct > 0) && (/promo|promoci[oó]n|oferta|descuento|dcto|rebaja/i.test(`${templateName} ${body}`));
  if (!promotional) return null;

  const sentAtCandidate = new Date(message.created_at || message.createdAt || now);
  const sentAt = Number.isNaN(sentAtCandidate.getTime()) ? new Date(now) : sentAtCandidate;
  const sentDay = chileDay(sentAt);
  const today = chileDay(now);
  const validOnlyToday = /v[aá]lid[oa].{0,45}(solo|s[oó]lo).{0,35}(pedidos?\s+(de|realizados?)\s+)?hoy/iu.test(body)
    || /(oferta|promo(?:ci[oó]n)?).{0,30}(solo|s[oó]lo)\s+por\s+hoy/iu.test(body);
  const deliveryWeekOnly = /(?:entrega|despacho)[^.!?\n]{0,35}(?:durante|dentro\s+de)\s+esta\s+semana/iu.test(body)
    || /v[aá]lid[oa][^.!?\n]{0,55}esta\s+semana/iu.test(body);
  const validUntil = explicitUntil(body, sentDay) || (validOnlyToday ? sentDay : (deliveryWeekOnly ? endOfWeek(sentDay) : null));
  const cutoff = parseCutoff(body);
  const orderCutoffOnlyToday = /(?:extendimos|ampliamos|extendido|nuevo\s+horario)[^.!?\n]{0,90}?pedidos?\s+de\s+hoy[^.!?\n]{0,60}?(?:hasta|a)\s+las?/iu.test(body);
  const usesDefaultValidity = !validUntil && !orderCutoffOnlyToday;
  const expiresAt = usesDefaultValidity ? new Date(sentAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
  const activeByDate = !validUntil || (!!today && today <= validUntil);
  const activeByDefault = !expiresAt || new Date(now).getTime() <= new Date(expiresAt).getTime();
  const active = activeByDate && activeByDefault && (!orderCutoffOnlyToday || beforeChileCutoff(now, sentDay, cutoff));
  const sameDayConditional = /(mismo\s+d[ií]a|durante\s+el\s+d[ií]a)/iu.test(body);
  const stockConditional = /(si\s+(tenemos|hay)\s+stock|sujeto\s+a\s+stock)/iu.test(body);
  const freeShippingMatch = body.match(/(?:despachos?|env[ií]os?)\s+gratis[^$\d]{0,35}(?:sobre|desde|superiores?\s+a)\s*\$?\s*([\d.]+)/iu);
  const freeShippingMin = freeShippingMatch ? money(freeShippingMatch[1]) : 0;

  const catalog = pricing.flattenCatalog(products);
  const specialPrices = {};
  for (const offer of offers) {
    const matched = pricing.matchProduct(offer.named ? offer.label : `${offer.units} ${offer.descriptor}`, catalog);
    if (!matched || matched.ambiguous) continue;
    offer.productId = matched.candidate.product_id;
    offer.productTitle = matched.candidate.title;
    if (offer.productId != null) specialPrices[String(offer.productId)] = offer.price;
    specialPrices[norm(matched.candidate.product_title)] = offer.price;
    specialPrices[norm(matched.candidate.title)] = offer.price;
  }
  for (const rule of secondUnitDiscounts) {
    const targetTokens = norm(rule.target).split(' ').filter(token => token.length > 2);
    const packTokens = norm(rule.packSize).split(' ');
    rule.products = catalog
      .filter(candidate => {
        const title = norm(candidate.title);
        return targetTokens.some(token => title.includes(token))
          && packTokens.every(token => title.includes(token));
      })
      .map(candidate => ({
        title: candidate.title,
        price: Number(candidate.price),
        pairTotal: Math.round(Number(candidate.price) * (2 - rule.pct / 100)),
      }));
  }

  return {
    templateName, body, offers, discountPct, categoryDiscounts, secondUnitDiscounts, specialPrices, sentDay, validUntil, validOnlyToday,
    deliveryWeekOnly, freeShippingMin, orderCutoffOnlyToday, usesDefaultValidity, expiresAt, active, cutoff, sameDayConditional, stockConditional,
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
  const { templateName, offers, discountPct, categoryDiscounts, secondUnitDiscounts, specialPrices, sentDay, validUntil, validOnlyToday, deliveryWeekOnly, freeShippingMin, orderCutoffOnlyToday, usesDefaultValidity, expiresAt, cutoff, sameDayConditional, stockConditional } = promotion;
  return { templateName, offers, discountPct, categoryDiscounts, secondUnitDiscounts, specialPrices, sentDay, validUntil, validOnlyToday, deliveryWeekOnly, freeShippingMin, orderCutoffOnlyToday, usesDefaultValidity, expiresAt, cutoff, sameDayConditional, stockConditional };
}

function restore(saved, now = new Date()) {
  if (!saved?.templateName || !Array.isArray(saved.offers)) return null;
  const today = chileDay(now);
  return {
    ...saved,
    specialPrices: saved.specialPrices && typeof saved.specialPrices === 'object' ? saved.specialPrices : {},
    active: (!saved.validUntil || (!!today && today <= saved.validUntil))
      && (!saved.expiresAt || new Date(now).getTime() <= new Date(saved.expiresAt).getTime())
      && (!saved.orderCutoffOnlyToday || beforeChileCutoff(now, saved.sentDay, saved.cutoff)),
  };
}

function promptSection(promotion) {
  if (!promotion) return '';
  const options = promotion.offers.map(offer => `- ${offer.label}: $${offer.price.toLocaleString('es-CL')}`).join('\n');
  if (!promotion.active) {
    const reason = promotion.orderCutoffOnlyToday
      ? `el horario para pedir terminó a las ${promotion.cutoff}`
      : (promotion.usesDefaultValidity ? 'pasaron 24 horas desde su envío' : `su vigencia terminó el ${promotion.validUntil}`);
    return `## Promoción vencida\nEl cliente recibió el template ${promotion.templateName}, pero ${reason}. NO uses esos precios. Si pregunta por la oferta, explica brevemente que venció y ofrece revisar los precios actuales.`;
  }
  const deliveryRule = promotion.sameDayConditional
    ? `La entrega el mismo día${promotion.cutoff ? ` requiere confirmar antes de las ${promotion.cutoff}` : ''}${promotion.stockConditional ? ' y está sujeta a stock' : ''}. Esta condición es distinta de la vigencia del precio.`
    : '';
  const priceRule = promotion.discountPct
    ? `Aplica exactamente ${promotion.discountPct}% de descuento al subtotal del pedido.`
    : 'Para estas presentaciones usa el precio promocional, nunca el precio normal del catálogo.';
  const categoryRules = (promotion.categoryDiscounts || []).map(rule => `Aplica ${rule.pct}% de descuento solamente a ${rule.target}.`).join(' ');
  const secondUnitRules = (promotion.secondUnitDiscounts || []).map(rule => {
    const values = (rule.products || []).map(product => `${product.title}: 1 envase $${product.price.toLocaleString('es-CL')}; 2 envases (${rule.packSize} cada uno) $${product.pairTotal.toLocaleString('es-CL')} en total`).join(' | ');
    return `En ${rule.target}, cobra el primer envase completo y aplica ${rule.pct}% de descuento sólo al segundo por cada par. Dos envases completan 1 kg. Si preguntan valores, responde usando el catálogo: ${values || 'consulta el precio actual del producto y calcula 1,5 veces ese valor para dos envases'}.`;
  }).join(' ');
  const validity = promotion.deliveryWeekOnly
    ? `Sólo aplica a pedidos cuya entrega sea hasta el ${promotion.validUntil}. Para una entrega posterior usa precios normales.`
    : (promotion.validOnlyToday
      ? 'La promoción aplica si el pedido queda confirmado hoy. Puede pedir hoy y solicitar entrega para otro día.'
      : (promotion.usesDefaultValidity ? 'El template no indicó vigencia: por seguridad esta promoción vence 24 horas después de su envío.' : `Vigencia: ${promotion.validUntil}.`));
  const shipping = promotion.freeShippingMin ? `Despacho gratis si el total del pedido es igual o superior a $${promotion.freeShippingMin.toLocaleString('es-CL')}.` : '';
  const ordering = promotion.orderCutoffOnlyToday ? `El pedido debe confirmarse hoy antes de las ${promotion.cutoff}; la hora antigua indicada más abajo no se usa.` : '';
  return `## Promoción activa recibida por este cliente (${promotion.templateName})\n${options ? `Precios exactos:\n${options}\n` : ''}REGLAS OBLIGATORIAS:\n- ${priceRule}${categoryRules ? ` ${categoryRules}` : ''}${secondUnitRules ? ` ${secondUnitRules}` : ''}\n- ${validity}${ordering ? `\n- ${ordering}` : ''}\n- ${deliveryRule || 'No inventes condiciones de entrega que el template no indique.'}${shipping ? `\n- ${shipping}` : ''}\n- Si el cliente pide directamente productos enumerados en esta promoción, registra TODOS los productos solicitados. No descartes uno ni anuncies que está agotado basándote solo en el stock cacheado; la disponibilidad se valida al procesar el pedido.\n- No prometas stock; registra el pedido y conserva las condiciones escritas en el template.`;
}

function optionText(promotion) {
  const offers = promotion.offers.map(offer => `${offer.label} a $${offer.price.toLocaleString('es-CL')}`).join(', ');
  return offers || (promotion.discountPct ? `${promotion.discountPct}% de descuento en tu pedido` : 'la promoción indicada');
}

/**
 * Encuentra una presentación promocional elegida explícitamente por el cliente.
 * Exige que aparezca la cantidad de huevos/unidades completa (40, 60, 100...)
 * para no confundirla con un precio, una fecha o una cantidad de bandejas.
 */
function selectedOffer(message, promotion) {
  if (!promotion?.active || !Array.isArray(promotion.offers)) return null;
  const text = norm(message);
  if (!text) return null;
  const matches = promotion.offers.filter(offer => {
    if (offer.named) {
      const meaningful = norm(offer.label).split(' ').filter(token => token.length > 3 && !/^\d+$/.test(token));
      return meaningful.some(token => text.includes(token));
    }
    const units = String(Number(offer.units));
    const hasUnits = new RegExp(`(^|\\s)${units}(?=\\s|$)`).test(text);
    if (!hasUnits) return false;
    const textTokens = new Set(text.split(' '));
    const descriptorTokens = norm(offer.descriptor)
      .split(' ')
      .filter(token => (token.length > 2 || ['xl', 'l', 'm', 's'].includes(token))
        && !['huevo', 'huevos', 'unidad', 'unidades'].includes(token));
    return descriptorTokens.length === 0 || descriptorTokens.some(token => token.length <= 2 ? textTokens.has(token) : text.includes(token));
  });
  return matches.length === 1 ? matches[0] : null;
}

function offerOrderItem(offer) {
  if (!offer) return null;
  const descriptor = String(offer.descriptor || 'huevos').trim();
  if (offer.named) {
    return { product_name: offer.label, quantity: 1, price: Number(offer.price), locked_quote: true, promotion_offer: true };
  }
  const packMatch = descriptor.match(/(?:bandeja|pack|caja)\s+(?:de\s+)?(\d{1,3})/iu);
  const packs = packMatch && Number(packMatch[1]) > 0 && offer.units % Number(packMatch[1]) === 0
    ? offer.units / Number(packMatch[1])
    : null;
  const name = packs && packs > 1
    ? `${offer.units} huevos ${descriptor.replace(/(?:bandeja|pack|caja)\s+(?:de\s+)?\d{1,3}/iu, '').trim()} (${packs} bandejas de ${packMatch[1]})`.replace(/\s+/g, ' ').trim()
    : `${offer.units} ${/huev/iu.test(descriptor) ? '' : 'huevos '}${descriptor}`.replace(/\s+/g, ' ').trim();
  return {
    product_name: name,
    quantity: 1,
    price: Number(offer.price),
    locked_quote: true,
    promotion_offer: true,
  };
}

function isFuturePromotionQuestion(message) {
  const text = String(message || '');
  return /(promo|promoci[oó]n|oferta|precio|respetan?|aplica|vigente|vale)/iu.test(text)
    && /(ma[ñn]ana|otro\s+d[ií]a|despu[eé]s|pr[oó]xim[oa]|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/iu.test(text);
}

function futureReply(promotion) {
  if (!promotion) return null;
  if (!promotion.active) {
    const reason = promotion.orderCutoffOnlyToday
      ? `hasta las ${promotion.cutoff}`
      : (promotion.usesDefaultValidity ? 'durante 24 horas desde su envío' : `hasta el ${promotion.validUntil || promotion.sentDay}`);
    return `Esa promoción era válida ${reason} y ya venció. Puedo ayudarte con los precios disponibles de hoy, ¿qué cantidad necesitas?`;
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

function appliesToDelivery(promotion, deliveryDate) {
  if (!promotion?.active) return false;
  if (!promotion.deliveryWeekOnly || !deliveryDate) return true;
  return String(deliveryDate).slice(0, 10) <= promotion.validUntil;
}

module.exports = { parseOffers, parseDiscountPct, parseCategoryDiscounts, parseSecondUnitDiscounts, parseTemplate, fromHistory, snapshot, restore, promptSection, selectedOffer, offerOrderItem, isFuturePromotionQuestion, futureReply, appliesToDelivery, norm, chileDay };
