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

function cleanOfferLabel(value) {
  return String(value || '')
    .replace(/^\s*(?:promo(?:ci[oó]n)?\s+[^:]{1,40}:)\s*/iu, '')
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '')
    .trim();
}

function comboComponent(value) {
  const label = cleanOfferLabel(value);
  const tray = label.match(/(?:bandeja|pack)\s+(?:de\s+)?(jumbo|extra\s+large|xl|large|l|mediano|mediana|m)\s+(?:de\s+)?(\d{1,3})/iu)
    || label.match(/(jumbo|extra\s+large|xl|large|l|mediano|mediana|m)\s*[-–]?\s*(?:bandeja|pack)\s+(?:de\s+)?(\d{1,3})/iu);
  if (tray) {
    const size = tray[1].replace(/\s+/g, ' ').toUpperCase();
    const units = Number(tray[2]);
    return {
      label: `Huevos de Campo Tamaño ${size} – Bandeja ${units} Unidades`,
      kind: 'eggs', size, units, quantity: 1,
    };
  }
  return { label, kind: /queso/iu.test(label) ? 'cheese' : 'product', quantity: 1 };
}

function parseOffers(body) {
  const offers = [];
  const seen = new Set();
  const countedBlocks = new Set();
  const re = /\b(\d{1,4})\s+([a-záéíóúüñ][^|$\n]{0,45}?)\s*\$\s*([\d.]+)/giu;
  // Algunos templates declaran la variedad una vez y después enumeran bloques:
  // "Jumbo: 40 unidades $18.000 | 60 unidades $25.500 | XL: 30 unidades...".
  // El encabezado se hereda hasta que aparece otro; sin esto, "60 Jumbo" y
  // "60 XL" quedaban como dos ofertas indistinguibles llamadas "60 unidades".
  let groupedDescriptor = '';
  // Los templates reales pueden separar las ofertas con "|" o solamente
  // con saltos de línea. Cada oferta debe analizarse de forma independiente.
  const blocks = String(body || '').split(/\||\r?\n/).map(block => block.replace(/^[^\p{L}\p{N}]+/u, '').trim()).filter(Boolean);
  for (const block of blocks) {
    if (!block.includes('+')) {
      const cheese = block.match(/^(?:(\d+)\s+)?(quesos?\s+de\s+cabra[^$]*?)\s*\$[\d.]+/iu);
      const amounts = [...block.matchAll(/\$\s*([\d.]+)/g)];
      if (cheese && amounts.length) {
        const quantity = Number(cheese[1] || 1);
        const productLabel = cheese[2].split(/\s*[-–—:]\s*|\s+hoy\s+/iu)[0].trim().replace(/^quesos\b/iu, 'Queso').replace(/frescos\b/iu, 'Fresco');
        const price = money(amounts.at(-1)[1]);
        offers.push({ units: null, quantity, productLabel, descriptor: productLabel, label: quantity === 1 ? productLabel : `${quantity} ${productLabel}`, price, named: true });
        countedBlocks.add(block);
        continue;
      }
    }
    // Una combinación es una sola oferta comercial con varios productos:
    // "QUESO DE CABRA + BANDEJA XL 30 = $25.000". No debe convertirse en
    // una bandeja de $25.000 ni perder uno de sus componentes.
    const comboMatch = block.match(/(?:^|:)\s*([^|$\n]{2,100}\+[^|$\n]{2,100}?)\s*(?:=|a|:)\s*\$\s*([\d.]+)/iu);
    if (comboMatch) {
      const label = cleanOfferLabel(comboMatch[1]);
      const price = money(comboMatch[2]);
      const components = label.split(/\s*\+\s*/).map(comboComponent).filter(component => component.label);
      const key = `combo_${norm(label)}_${price}`;
      if (price && components.length > 1 && !seen.has(key)) {
        seen.add(key);
        offers.push({ units: null, descriptor: label, price, label, named: true, combo: true, components });
      }
      continue;
    }

    // "2 bandejas XL de 30 huevos a $23.000" expresa 60 huevos en dos
    // envases, no una bandeja de 30 a ese precio.
    const trayMatch = block.match(/\b(\d{1,2})\s+(?:bandejas?|packs?)\s+(?:de\s+)?(jumbo|extra\s+large|xl|large|l|mediano|mediana|m)\s+(?:de\s+)?(\d{1,3})\s+(?:huevos?|unidades?)\s*(?:a|=)?\s*\$\s*([\d.]+)/iu);
    if (trayMatch) {
      const packs = Number(trayMatch[1]);
      const size = trayMatch[2].replace(/\s+/g, ' ').toUpperCase();
      const packSize = Number(trayMatch[3]);
      const units = packs * packSize;
      const price = money(trayMatch[4]);
      const descriptor = `${size} (${packs} bandejas de ${packSize})`;
      const label = `${packs} bandejas ${size} de ${packSize} huevos`;
      const key = `${units}_${norm(descriptor)}_${price}`;
      if (packs && packSize && price && !seen.has(key)) {
        seen.add(key);
        offers.push({ units, descriptor, price, label, packs, packSize, size });
      }
      continue;
    }

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
  for (const block of blocks) {
    if (countedBlocks.has(block)) continue;
    if (!block.includes('$') || /(?:despachos?|env[ií]os?)\s+gratis/iu.test(block)) continue;
    if (/\+[^|$\n]{2,100}?\s*(?:=|a|:)\s*\$\s*[\d.]+/iu.test(block)) continue;
    if (/\b\d{1,2}\s+(?:bandejas?|packs?)\s+(?:de\s+)?(?:jumbo|extra\s+large|xl|large|l|mediano|mediana|m)\s+(?:de\s+)?\d{1,3}\s+(?:huevos?|unidades?)/iu.test(block)) continue;
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

/**
 * Extrae beneficios del tipo "1 producto de aceitunas GRATIS en compras sobre
 * $20.000". El producto, la cantidad y el monto salen del propio template.
 */
function parseFreeGift(body) {
  const text = String(body || '');
  const threshold = '(sobre|superiores?\\s+a|mayores?\\s+a|desde|iguales?\\s+o\\s+superiores?\\s+a|(?:por\\s+un\\s+)?m[ií]nimo(?:\\s+de)?|m[ií]nimas?\\s+de|de\\s+al\\s+menos)';
  const patterns = [
    new RegExp(`(?:tienes?|recibes?|recibe|lleva|obt[eé]n|te\\s+regalamos)?\\s*(\\d{1,2}|un(?:o|a)?|dos|tres|cuatro|cinco)\\s+(?:productos?|unidades?|envases?|potes?|frascos?)?\\s*(?:de\\s+)?([^|.!?\\n]{2,55}?)\\s+gratis\\s+(?:en|por|con)\\s+compras?\\s+${threshold}\\s*\\$?\\s*([\\d.]+)`, 'iu'),
    new RegExp(`([^|.!?\\n]{2,55}?)\\s+gratis\\s+(?:en|por|con)\\s+compras?\\s+${threshold}\\s*\\$?\\s*([\\d.]+)`, 'iu'),
  ];
  for (let index = 0; index < patterns.length; index++) {
    const match = text.match(patterns[index]);
    if (!match) continue;
    const hasQuantity = index === 0;
    const quantityWords = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
    const quantity = hasQuantity ? (Number(match[1]) || quantityWords[norm(match[1])] || 0) : 1;
    const target = cleanOfferLabel(hasQuantity ? match[2] : match[1])
      .replace(/^(?:recibe|lleva|obt[eé]n|te\s+regalamos)\s+(?:un|una)?\s*/iu, '')
      .replace(/^(?:un|una|el|la)\s+/iu, '')
      .trim();
    const comparator = norm(hasQuantity ? match[3] : match[2]);
    const minPurchase = money(hasQuantity ? match[4] : match[3]);
    if (!quantity || !target || !minPurchase) continue;
    return {
      quantity,
      target,
      minPurchase,
      minimumExclusive: /^(sobre|superior|superiores|mayor|mayores)/.test(comparator),
      choiceRequired: /(?:a\s+elecci[oó]n|elige|escoge|variedades?)/iu.test(text),
      stockRequired: /(?:disponib(?:le|les)\s+en\s+stock|sujeta?\s+a\s+stock|hasta\s+agotar\s+stock|seg[uú]n\s+stock)/iu.test(text),
      candidates: [],
    };
  }
  return null;
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
  // El monto mínimo de una regla de regalo no es el precio de una oferta.
  // Ej.: "1 aceituna GRATIS en compras sobre $20.000" no significa que la
  // aceituna cueste $20.000.
  const offers = parseOffers(body).filter(offer => !/\b(?:gratis|regalo)\b/iu.test(`${offer.label || ''} ${offer.descriptor || ''}`));
  const categoryDiscounts = parseCategoryDiscounts(body);
  const secondUnitDiscounts = parseSecondUnitDiscounts(body);
  const freeGift = parseFreeGift(body);
  const parsedDiscountPct = parseDiscountPct(body);
  // Un template con precios finales y porcentaje informativo no acumula ambos
  // beneficios. Los precios explícitos mandan; el porcentaje se usa cuando la
  // promoción realmente consiste en descontar el subtotal.
  const discountPct = (offers.length || categoryDiscounts.length || secondUnitDiscounts.length) ? 0 : parsedDiscountPct;
  const promotional = (offers.length > 0 || parsedDiscountPct > 0 || freeGift)
    && (/promo|promoci[oó]n|oferta|descuento|dcto|rebaja|gratis|regalo/i.test(`${templateName} ${body}`));
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
  const orderCutoffOnlyToday = /(?:extendimos|ampliamos|extendido|nuevo\s+horario)[^.!?\n]{0,90}?pedidos?\s+de\s+hoy[^.!?\n]{0,60}?(?:hasta|a)\s+las?/iu.test(body)
    || (freeGift && validOnlyToday && /(?:pedido|compra|orden)(?:s|do|dos)?[^.!?\n]{0,80}?antes\s+de\s+las?/iu.test(body));
  const usesDefaultValidity = !validUntil && !orderCutoffOnlyToday;
  const expiresAt = usesDefaultValidity ? new Date(sentAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
  const activeByDate = !validUntil || (!!today && today <= validUntil);
  const activeByDefault = !expiresAt || new Date(now).getTime() <= new Date(expiresAt).getTime();
  const active = activeByDate && activeByDefault && (!orderCutoffOnlyToday || beforeChileCutoff(now, sentDay, cutoff));
  const sameDayConditional = /(mismo\s+d[ií]a|durante\s+el\s+d[ií]a)/iu.test(body);
  const stockConditional = /(si\s+(tenemos|hay)\s+stock|sujeta?\s+a\s+stock|disponib(?:le|les)\s+en\s+stock|hasta\s+agotar\s+stock)/iu.test(body);
  const freeShippingMatch = body.match(/(?:despachos?|env[ií]os?)\s+gratis[^$\d]{0,35}(?:sobre|desde|superiores?\s+a)\s*\$?\s*([\d.]+)/iu);
  const freeShippingMin = freeShippingMatch ? money(freeShippingMatch[1]) : 0;

  const catalog = pricing.flattenCatalog(products);
  if (freeGift) {
    const targetTokens = norm(freeGift.target)
      .split(' ')
      .filter(token => token.length > 2)
      .map(token => token.endsWith('s') ? token.slice(0, -1) : token);
    const seenGift = new Set();
    freeGift.candidates = catalog
      .filter(candidate => candidate.available !== false)
      .filter(candidate => {
        const title = norm(candidate.title);
        return targetTokens.length > 0 && targetTokens.some(token => title.includes(token));
      })
      .filter(candidate => {
        const key = `${candidate.product_id || ''}:${candidate.variant_id || ''}:${norm(candidate.title)}`;
        if (seenGift.has(key)) return false;
        seenGift.add(key);
        return true;
      })
      .map(candidate => ({
        title: candidate.title,
        productId: candidate.product_id,
        variantId: candidate.variant_id,
      }));
  }
  const specialPrices = {};
  for (const offer of offers) {
    if (offer.combo) {
      let remaining = Number(offer.price);
      offer.components = offer.components.map((component, index) => {
        const matched = pricing.matchProduct(component.label, catalog);
        const candidate = matched && !matched.ambiguous ? matched.candidate : null;
        const componentsLeft = offer.components.length - index;
        const fallback = Math.floor(remaining / componentsLeft);
        const candidatePrice = Number(candidate?.price) || 0;
        const allocatedPrice = index === offer.components.length - 1
          ? remaining
          : (candidatePrice > 0 && candidatePrice < remaining ? candidatePrice : fallback);
        remaining -= allocatedPrice;
        return {
          ...component,
          label: candidate?.title || component.label,
          productId: candidate?.product_id,
          variantId: candidate?.variant_id,
          price: allocatedPrice,
        };
      });
      continue;
    }
    const matched = pricing.matchProduct(offer.productLabel || (offer.named ? offer.label : `${offer.units} ${offer.descriptor}`), catalog);
    if (!matched || matched.ambiguous) continue;
    offer.productId = matched.candidate.product_id;
    offer.productTitle = matched.candidate.title;
    const keys = [String(offer.productId), norm(matched.candidate.product_title), norm(matched.candidate.title)];
    for (const key of keys) {
      if (offer.quantity) {
        const previous = specialPrices[key];
        const rule = previous && typeof previous === 'object' ? previous : { unitPrice: Number(previous) || Number(matched.candidate.price), quantities: {} };
        if (offer.quantity === 1) rule.unitPrice = offer.price;
        else rule.quantities[String(offer.quantity)] = offer.price;
        specialPrices[key] = rule;
      } else specialPrices[key] = offer.price;
    }
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
    templateName, body, offers, discountPct, categoryDiscounts, secondUnitDiscounts, freeGift, specialPrices, sentDay, validUntil, validOnlyToday,
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
  const { templateName, offers, discountPct, categoryDiscounts, secondUnitDiscounts, freeGift, specialPrices, sentDay, validUntil, validOnlyToday, deliveryWeekOnly, freeShippingMin, orderCutoffOnlyToday, usesDefaultValidity, expiresAt, cutoff, sameDayConditional, stockConditional } = promotion;
  return { templateName, offers, discountPct, categoryDiscounts, secondUnitDiscounts, freeGift, specialPrices, sentDay, validUntil, validOnlyToday, deliveryWeekOnly, freeShippingMin, orderCutoffOnlyToday, usesDefaultValidity, expiresAt, cutoff, sameDayConditional, stockConditional };
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
    : (promotion.offers.length ? 'Para estas presentaciones usa el precio promocional, nunca el precio normal del catálogo.' : 'Usa los precios normales del catálogo para los productos comprados.');
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
  const giftRule = promotion.freeGift
    ? `Regalo: ${promotion.freeGift.quantity} ${promotion.freeGift.target} GRATIS sólo si el total pagado ${promotion.freeGift.minimumExclusive ? 'supera' : 'es igual o superior a'} $${promotion.freeGift.minPurchase.toLocaleString('es-CL')}. El regalo vale $0 y no cuenta para alcanzar el mínimo.${promotion.freeGift.choiceRequired ? ' El cliente debe elegir una variedad disponible antes de confirmar.' : ''}${promotion.freeGift.stockRequired ? ' Está sujeto al stock real.' : ''}`
    : '';
  return `## Promoción activa recibida por este cliente (${promotion.templateName})\n${options ? `Precios exactos:\n${options}\n` : ''}REGLAS OBLIGATORIAS:\n- ${priceRule}${categoryRules ? ` ${categoryRules}` : ''}${secondUnitRules ? ` ${secondUnitRules}` : ''}${giftRule ? `\n- ${giftRule}` : ''}\n- ${validity}${ordering ? `\n- ${ordering}` : ''}\n- ${deliveryRule || 'No inventes condiciones de entrega que el template no indique.'}${shipping ? `\n- ${shipping}` : ''}\n- Si el cliente pide directamente productos enumerados en esta promoción, registra TODOS los productos solicitados. No descartes uno ni anuncies que está agotado basándote solo en el stock cacheado; la disponibilidad se valida al procesar el pedido.\n- No prometas stock; registra el pedido y conserva las condiciones escritas en el template.`;
}

/**
 * Si el comercio acaba de ofrecer un producto en una promoción activa, una
 * marca de stock cacheada no puede convertirse en un rechazo automático.
 * Se quita solamente el "agotado" de los bloques promocionados y se deja
 * explícito que la disponibilidad se valida al registrar el pedido.
 */
function alignPromotedAvailability(catalogText, promotion) {
  if (!catalogText || !promotion?.active || !Array.isArray(promotion.offers)) return catalogText || '';
  const promotedTitles = promotion.offers
    .map(offer => norm(offer.productTitle || ''))
    .filter(Boolean)
    .map(title => title.split(' ').filter(token => token.length >= 3 && !/^\d+$/.test(token)));
  if (!promotedTitles.length) return catalogText;

  return String(catalogText).split(/\n\n/).map(block => {
    const normalizedBlock = norm(block);
    const promoted = promotedTitles.some(titleTokens => {
      const hits = titleTokens.filter(token => normalizedBlock.includes(token)).length;
      return hits >= Math.min(2, titleTokens.length) && hits / titleTokens.length >= 0.6;
    });
    if (!promoted || !/agotado|stock:\s*0/iu.test(block)) return block;
    const cleaned = block
      .replace(/\s*\(stock:\s*0\)/giu, '')
      .replace(/\s*❌\s*agotado/giu, '');
    return `${cleaned}\n  Disponibilidad: validar al registrar el pedido (producto incluido en promoción activa).`;
  }).join('\n\n');
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
  const numberedChoice = text.match(/^(?:la\s+)?(?:opcion\s+)?(\d{1,2})$/iu);
  if (numberedChoice) {
    const index = Number(numberedChoice[1]) - 1;
    return promotion.offers[index] || null;
  }
  // "Por 25000" identifica el combo por su precio total, sin autorizar a
  // repartir ese total inventando un precio para cada producto del pack.
  const mentionedAmounts = [...String(message || '').matchAll(/(?:\$\s*)?(\d{1,3}(?:[.\s]\d{3})+|\d{4,6})/g)]
    .map(match => money(match[1]));
  const byPrice = promotion.offers.filter(offer => mentionedAmounts.includes(Number(offer.price)));
  if (byPrice.length === 1) return byPrice[0];
  const matches = promotion.offers.filter(offer => {
    if (offer.combo) {
      return offer.components.every(component => {
        const source = norm(`${component.label} ${component.kind || ''}`);
        if (component.kind === 'cheese' || /queso|cabra/.test(source)) return /\b(queso|cabra)\b/.test(text);
        if (component.kind === 'eggs' || /huevo|bandeja|\bxl\b|jumbo/.test(source)) {
          return /\b(huevo|huevos|bandeja|xl|jumbo)\b/.test(text);
        }
        const tokens = source.split(' ').filter(token => token.length > 3);
        return tokens.some(token => text.includes(token));
      });
    }
    if (offer.named) {
      if (offer.quantity) {
        const quantity = text.match(/\b(\d+|un|uno|una|dos)\b/);
        if (quantity) {
          const value = ({un:1,uno:1,una:1,dos:2})[quantity[1]] || Number(quantity[1]);
          if (value !== offer.quantity) return false;
        }
      }
      const meaningful = norm(offer.label).split(' ').filter(token => token.length > 3 && !/^\d+$/.test(token));
      return meaningful.some(token => text.includes(token));
    }
    if (offer.packs && offer.size) {
      const packCount = new RegExp(`(^|\\s)${Number(offer.packs)}(?=\\s+(?:bandeja|bandejas|pack|packs)\\b)`).test(text);
      const size = norm(offer.size);
      const hasSize = size.length <= 2
        ? new Set(text.split(' ')).has(size)
        : text.includes(size);
      if (packCount && hasSize) return true;
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
  if (offer.quantity && offer.productId != null) return { product_name: offer.productTitle || offer.productLabel, product_id: offer.productId, quantity: offer.quantity, price: offer.price / offer.quantity, locked_quote: true, promotion_offer: true };
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

function offerOrderItems(offer) {
  if (!offer) return [];
  // El template sólo publica el total del combo. Mantener una única línea
  // evita afirmar precios individuales que el comercio nunca definió.
  return [offerOrderItem(offer)].filter(Boolean);
}

function isBareAffirmative(message) {
  return /^(?:si+|si\s+por\s+favor|si+\s+porfa(?:vor)?|claro|dale|ok(?:ey)?|bueno)$/iu.test(norm(message));
}

function choiceReply(promotion) {
  const choices = (promotion?.offers || []).map((offer, index) =>
    `${index + 1}) ${offer.label} — $${Number(offer.price).toLocaleString('es-CL')}`
  ).join('\n');
  return `Claro 😊 ¿Cuál de estas promociones quieres?\n\n${choices}\n\nPuedes responder con el número o escribir la promoción.`;
}

function isCurrentPriceQuestion(message) {
  const text = String(message || '');
  if (isFuturePromotionQuestion(text)) return false;
  return /(?:cu[aá]nto\s+(?:cuestan?|valen?)|qu[eé]\s+precios?|precio\s+de|tienen\s+(?:alguna\s+)?promo|promociones?\s+(?:de|en|para))/iu.test(text);
}

function priceReply(promotion) {
  const choices = (promotion?.offers || []).map((offer, index) =>
    `${index + 1}) ${offer.label} — $${Number(offer.price).toLocaleString('es-CL')}`
  ).join('\n');
  if (!choices) return null;
  return `Sí 😊 Antes del precio normal, tenemos estas promociones vigentes:\n\n${choices}\n\n¿Cuál te interesa? Puedes responder con el número o escribir la opción.`;
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

function giftQualifies(freeGift, paidTotal) {
  if (!freeGift) return false;
  const total = Number(paidTotal) || 0;
  return freeGift.minimumExclusive ? total > freeGift.minPurchase : total >= freeGift.minPurchase;
}

function selectedFreeGift(message, freeGift) {
  if (!freeGift?.candidates?.length) return null;
  const text = norm(message);
  if (!text) return null;
  const numbered = text.match(/^(?:la\s+)?(?:opcion\s+)?(\d{1,2})$/iu);
  if (numbered) return freeGift.candidates[Number(numbered[1]) - 1] || null;
  const scored = freeGift.candidates.map(candidate => {
    const candidateTokens = norm(candidate.title).split(' ')
      .filter(token => token.length > 2 && !/^(?:aceituna|aceitunas|producto|productos)$/.test(token));
    const hits = candidateTokens.filter(token => text.includes(token)).length;
    return { candidate, hits };
  }).filter(entry => entry.hits > 0).sort((a, b) => b.hits - a.hits);
  if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) return scored[0].candidate;
  const targetMentioned = norm(freeGift.target).split(' ').some(token => token.length > 2 && text.includes(token.replace(/s$/, '')));
  return targetMentioned && freeGift.candidates.length === 1 ? freeGift.candidates[0] : null;
}

function freeGiftOrderItem(candidate, freeGift) {
  if (!candidate || !freeGift) return null;
  return {
    product_name: candidate.title,
    quantity: Number(freeGift.quantity) || 1,
    price: 0,
    locked_quote: true,
    free_gift: true,
    promotion_offer: true,
    ...(candidate.productId != null ? { product_id: candidate.productId } : {}),
    ...(candidate.variantId != null ? { variant_id: candidate.variantId } : {}),
  };
}

function freeGiftChoiceReply(freeGift) {
  const choices = (freeGift?.candidates || []).map((candidate, index) => `${index + 1}) ${candidate.title}`).join('\n');
  if (!choices) return `Tu compra califica para ${freeGift?.quantity || 1} ${freeGift?.target || 'producto'} gratis, sujeto a stock. Voy a validar con el equipo qué variedades están disponibles.`;
  return `¡Tu compra califica para ${freeGift.quantity} ${freeGift.target} gratis! 🎁\n\nElige una variedad disponible:\n${choices}\n\nPuedes responder con el número o el nombre.`;
}

module.exports = { parseOffers, parseDiscountPct, parseCategoryDiscounts, parseSecondUnitDiscounts, parseFreeGift, parseTemplate, fromHistory, snapshot, restore, promptSection, alignPromotedAvailability, selectedOffer, offerOrderItem, offerOrderItems, isBareAffirmative, choiceReply, isCurrentPriceQuestion, priceReply, isFuturePromotionQuestion, futureReply, appliesToDelivery, giftQualifies, selectedFreeGift, freeGiftOrderItem, freeGiftChoiceReply, norm, chileDay };
