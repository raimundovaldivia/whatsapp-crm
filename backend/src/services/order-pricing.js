/**
 * order-pricing.js — Carrito multi-producto con precios desde el catálogo
 *
 * POR QUÉ EXISTE
 * Antes el pedido tenía UN producto (product_name + quantity) y el precio lo
 * "extraía" el modelo de la conversación: si nadie lo mencionó, el total
 * quedaba en null; los descuentos que el bot prometía nunca se aplicaban.
 *
 * Ahora el borrador lleva `items: [{ product_name, quantity }]`, cada ítem se
 * resuelve contra el catálogo real (producto o variante), el precio unitario
 * sale de la DB (precio especial del contacto > precio por volumen > precio
 * de lista) y el total se calcula acá, en código, con el descuento acordado.
 *
 * El modelo sigue decidiendo QUÉ pidió el cliente; nunca CUÁNTO cuesta.
 */

const MAX_DISCOUNT_PCT = 10;

// ─── Normalización de texto ──────────────────────────────────────────────────

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin acentos
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'con', 'para', 'por', 'del', 'al', 'x',
  // números en palabras: la cantidad va aparte, no es parte del nombre
  'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'docena', 'media', 'par',
  'quiero', 'pedir', 'mandame', 'mandar', 'porfa', 'favor',
]);

// Singular tosco: bandejas → bandeja, huevos → huevo, cajas → caja
function stem(t) {
  if (t.length > 4 && t.endsWith('es') && !/[aeiou]es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function tokens(s) {
  return norm(s).split(' ').filter(t => t && !STOPWORDS.has(t)).map(stem);
}

// ─── Catálogo plano ──────────────────────────────────────────────────────────

/**
 * Convierte los productos del pipeline (Shopify raw_json o tabla products) en
 * una lista plana de candidatos: un candidato por variante real, o uno por
 * producto si no tiene variantes.
 *
 * @returns {Array<{key, product_id, variant_id, title, price, bulk_price, bulk_min_qty, available}>}
 */
function flattenCatalog(products = []) {
  const out = [];
  for (const p of products) {
    if (!p) continue;
    const realVariants = (p.variants || []).filter(v => v && v.title && norm(v.title) !== 'default title');
    if (realVariants.length) {
      for (const v of realVariants) {
        out.push({
          key:          `${p.id}:${v.id}`,
          product_id:   p.id != null ? String(p.id) : null,
          variant_id:   v.id != null ? String(v.id) : null,
          title:        `${p.title} ${v.title}`.trim(),
          product_title: p.title,
          variant_title: v.title,
          price:        Number(v.price) || Number(p.priceMin) || Number(p.price) || 0,
          bulk_price:   null,
          bulk_min_qty: null,
          available:    v.available !== false && v.stock !== 0,
        });
      }
    } else {
      out.push({
        key:          String(p.id),
        product_id:   p.id != null ? String(p.id) : null,
        variant_id:   null,
        title:        p.title,
        product_title: p.title,
        variant_title: null,
        price:        Number(p.priceMin) || Number(p.price) || 0,
        bulk_price:   p.bulk_price != null ? Number(p.bulk_price) : (p.bulkPrice != null ? Number(p.bulkPrice) : null),
        bulk_min_qty: p.bulk_min_qty != null ? Number(p.bulk_min_qty) : (p.bulkMinQty != null ? Number(p.bulkMinQty) : null),
        available:    p.available !== false,
      });
    }
  }
  return out;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Busca el candidato del catálogo que mejor corresponde a un nombre libre
 * ("bandeja 30 huevos xl", "la XL", "caja de 180").
 *
 * Estrategia, de más a menos estricta:
 *  1. Título normalizado idéntico.
 *  2. Uno contiene al otro.
 *  3. Mayor solapamiento de tokens (Jaccard sobre tokens), mínimo 0.5.
 *
 * @returns {{ candidate, score } | null}
 */
function matchProduct(name, catalog) {
  const q = norm(name);
  if (!q || !catalog?.length) return null;

  // 1. exacto
  const exact = catalog.find(c => norm(c.title) === q);
  if (exact) return { candidate: exact, score: 1 };

  // 2a. El título cabe dentro de lo que dijo el cliente → específico, sin ambigüedad
  //     ("quiero huevos xl bandeja 30 porfa" contiene "huevos xl bandeja 30")
  const titleInQuery = catalog
    .filter(c => { const t = norm(c.title); return t && q.includes(t); })
    .sort((a, b) => norm(b.title).length - norm(a.title).length);
  if (titleInQuery.length) return { candidate: titleInQuery[0], score: 0.95 };

  // 2b. Lo que dijo cabe dentro de varios títulos ("huevos xl" → Bandeja 30 / Caja 180)
  //     → hay que preguntar, no adivinar. Se devuelve el más corto como
  //     candidato pero marcado como ambiguo con las alternativas.
  const queryInTitle = catalog
    .filter(c => { const t = norm(c.title); return t && t.includes(q); })
    .sort((a, b) => norm(a.title).length - norm(b.title).length);
  if (queryInTitle.length === 1) return { candidate: queryInTitle[0], score: 0.9 };
  if (queryInTitle.length > 1) {
    return { candidate: queryInTitle[0], score: 0.6, ambiguous: true, alternatives: queryInTitle.map(c => c.title) };
  }

  // 3. tokens
  const qt = new Set(tokens(name));
  if (!qt.size) return null;
  let best = null;
  for (const c of catalog) {
    const ct = new Set(tokens(c.title));
    if (!ct.size) continue;
    let inter = 0;
    for (const t of qt) if (ct.has(t)) inter++;
    const union = new Set([...qt, ...ct]).size;
    const jaccard = inter / union;
    // Bonus si todos los tokens de la consulta están en el título (consulta corta: "xl", "caja 180")
    const coverage = inter / qt.size;
    const score = Math.max(jaccard, coverage * 0.75);
    if (score >= 0.5 && (!best || score > best.score)) best = { candidate: c, score };
  }
  return best;
}

function gcd(a, b) {
  let x = Math.abs(Number(a) || 0);
  let y = Math.abs(Number(b) || 0);
  while (y) [x, y] = [y, x % y];
  return x;
}

function packageUnits(title) {
  const text = norm(title);
  const match = text.match(/\b(\d{1,4})\s*(?:huevos?|unidades?|uds?|u)\b/i);
  return match ? Number(match[1]) : null;
}

function descriptorMatches(candidate, descriptor) {
  const wanted = tokens(descriptor);
  if (!wanted.length) return false;
  const available = new Set(tokens(candidate.title));
  return wanted.every(token => available.has(token));
}

/**
 * Resuelve una presentación promocional que no existe como SKU independiente.
 * Ejemplo real: "60 Jumbo" en una promo 40/60/100 se representa con tres
 * bandejas Jumbo de 20, conservando $23.500 como total exacto de la línea.
 *
 * Solo se usa cuando el nombre normal no calza con el catálogo. La unidad base
 * se obtiene del MCD de las opciones de la misma familia, por lo que no se
 * confunde con una bandeja de 30 aunque 60 también sea divisible por 30.
 */
function matchPromotionBundle(raw, catalog, offers = []) {
  const name = raw?.product_name || raw?.name || raw?.title || '';
  const normalizedName = norm(name);
  const rawQty = Math.max(1, parseInt(raw?.quantity, 10) || 1);
  const explicitUnits = Number(normalizedName.match(/\b(\d{1,4})\b/)?.[1]) || null;

  const offer = offers.find(candidate => {
    if (!candidate?.units || !candidate?.descriptor || !candidate?.price) return false;
    if (!descriptorMatches({ title: name }, candidate.descriptor)) return false;
    return explicitUnits === Number(candidate.units)
      || (!explicitUnits && rawQty === Number(candidate.units));
  });
  if (!offer) return null;

  const family = offers.filter(candidate =>
    candidate?.units > 0 && descriptorMatches({ title: candidate.descriptor }, offer.descriptor)
  );
  const baseUnits = family.length > 1
    ? family.map(candidate => Number(candidate.units)).reduce(gcd)
    : 0;
  if (!baseUnits || Number(offer.units) % baseUnits !== 0) return null;

  const candidates = catalog.filter(candidate =>
    candidate.available !== false
    && packageUnits(candidate.title) === baseUnits
    && descriptorMatches(candidate, offer.descriptor)
  );
  if (candidates.length !== 1) return null;

  const selections = explicitUnits ? rawQty : 1;
  const bundleQty = Number(offer.units) / baseUnits;
  return {
    candidate: candidates[0],
    quantity: bundleQty * selections,
    unitPrice: Number(offer.price) / bundleQty,
    lineTotal: Number(offer.price) * selections,
    offer,
  };
}

// ─── Precios ─────────────────────────────────────────────────────────────────

/**
 * Precio unitario para un candidato y una cantidad.
 * Prioridad: precio especial del contacto > precio por volumen > lista.
 */
function unitPriceFor(candidate, qty, specialPrices = {}) {
  const sp = specialPrices[candidate.product_id] ?? specialPrices[norm(candidate.product_title)] ?? specialPrices[norm(candidate.title)];
  if (sp != null && Number(sp) > 0) return { price: Number(sp), source: 'especial' };
  if (candidate.bulk_price && candidate.bulk_min_qty && qty >= candidate.bulk_min_qty) {
    return { price: Number(candidate.bulk_price), source: 'volumen' };
  }
  return { price: Number(candidate.price) || 0, source: 'lista' };
}

/**
 * Resuelve y valoriza los ítems del borrador.
 *
 * @param {Array<{product_name, quantity}>} items
 * @param {Array} products   — productos del pipeline (sin aplanar)
 * @param {object} opts      — { specialPrices: {product_id|título → precio}, discountPct }
 * @returns {{ items, subtotal, discountPct, discountAmount, total, unmatched: string[] }}
 */
function priceItems(items = [], products = [], opts = {}) {
  const catalog = flattenCatalog(products);
  const specialPrices = opts.specialPrices || {};
  const promotionOffers = Array.isArray(opts.promotionOffers) ? opts.promotionOffers : [];
  const priced = [];
  const unmatched = [];

  for (const raw of items) {
    if (!raw) continue;
    const name = raw.product_name || raw.name || raw.title || '';
    const qty  = Math.max(1, parseInt(raw.quantity, 10) || 1);
    if (!name.trim()) continue;

    let m = matchProduct(name, catalog);
    const promoBundle = (!m || m.ambiguous)
      ? matchPromotionBundle(raw, catalog, promotionOffers)
      : null;
    if (promoBundle) {
      priced.push({
        product_name: promoBundle.candidate.title,
        name:         promoBundle.candidate.title,
        title:        promoBundle.candidate.title,
        quantity:     promoBundle.quantity,
        price:        promoBundle.unitPrice,
        line_total:   promoBundle.lineTotal,
        unit_source:  'promocion',
        promotion_label: promoBundle.offer.label,
        product_id:   promoBundle.candidate.product_id,
        variant_id:   promoBundle.candidate.variant_id,
        matched:      true,
      });
      continue;
    }
    if (!m) {
      unmatched.push(name);
      priced.push({ product_name: name, name, title: name, quantity: qty, price: Number(raw.price) || 0, unit_source: 'desconocido', matched: false });
      continue;
    }
    const { price, source } = unitPriceFor(m.candidate, qty, specialPrices);
    if (m.ambiguous) {
      // No valorizar un producto que no está claro: el agente pregunta cuál es
      unmatched.push(name);
      priced.push({ product_name: name, name, title: name, quantity: qty, price: 0, unit_source: 'ambiguo', matched: false, ambiguous: true, alternatives: m.alternatives });
      continue;
    }
    priced.push({
      product_name: m.candidate.title,
      name:         m.candidate.title,   // lo que leen CRM, app de reparto y manifiesto
      title:        m.candidate.title,
      quantity:     qty,
      price,
      unit_source:  source,
      product_id:   m.candidate.product_id,
      variant_id:   m.candidate.variant_id,
      matched:      true,
    });
  }

  // Fusionar líneas repetidas del mismo producto (el cliente dijo "una XL" y luego "otra XL")
  const merged = [];
  for (const it of priced) {
    const k = it.product_id
      ? `${it.product_id}:${it.variant_id || ''}:${it.unit_source === 'promocion' ? it.promotion_label : ''}`
      : norm(it.name);
    const prev = merged.find(x => x._k === k);
    if (prev) {
      prev.quantity += it.quantity;
      if (it.line_total != null) prev.line_total = Number(prev.line_total || 0) + Number(it.line_total);
      continue;
    }
    merged.push({ ...it, _k: k });
  }
  merged.forEach(x => delete x._k);

  const subtotal = merged.reduce((s, it) => s + (it.line_total != null ? Number(it.line_total) : it.price * it.quantity), 0);
  const maxDiscountPct = Math.min(100, Math.max(0, Number(opts.maxDiscountPct ?? MAX_DISCOUNT_PCT) || 0));
  const discountPct = Math.min(maxDiscountPct, Math.max(0, Number(opts.discountPct) || 0));
  const discountAmount = Math.round(subtotal * discountPct / 100);
  const total = subtotal - discountAmount;

  return { items: merged, subtotal, discountPct, discountAmount, total, unmatched };
}

// ─── Presentación ────────────────────────────────────────────────────────────

function fmt(n) { return `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`; }

/** Líneas "📦 2x Bandeja 30 XL — $24.000" para el resumen al cliente. */
function itemLines(items = []) {
  return items.map(it => {
    const lineTotal = it.line_total != null ? Number(it.line_total) : it.price * it.quantity;
    return `📦 ${it.quantity}x ${it.name}${it.price ? ` — ${fmt(lineTotal)}` : ''}`;
  }).join('\n');
}

/** Texto para el prompt del agente de pedidos: qué hay valorizado y qué no. */
function pricingContext(pricing) {
  if (!pricing || !pricing.items?.length) return 'Aún no hay productos en el pedido.';
  const lines = pricing.items.map(it => {
    if (it.ambiguous) return `- ${it.quantity}x "${it.name}"  ⚠️ AMBIGUO: puede ser ${it.alternatives.join(' o ')} — pregunta al cliente cuál (no muestres el resumen todavía)`;
    if (!it.matched) return `- ${it.quantity}x "${it.name}"  ⚠️ NO está en el catálogo tal cual — pide al cliente que aclare cuál es (no muestres el resumen todavía)`;
    const lineTotal = it.line_total != null ? Number(it.line_total) : it.price * it.quantity;
    if (it.unit_source === 'promocion') return `- ${it.quantity}x ${it.name} = ${fmt(lineTotal)} total promocional (${it.promotion_label})`;
    return `- ${it.quantity}x ${it.name} @ ${fmt(it.price)} c/u = ${fmt(lineTotal)}`;
  });
  const out = [`Subtotal: ${fmt(pricing.subtotal)}`];
  if (pricing.discountPct) out.push(`Descuento acordado: ${pricing.discountPct}% (−${fmt(pricing.discountAmount)})`);
  out.push(`TOTAL: ${fmt(pricing.total)}`);
  return `${lines.join('\n')}\n${out.join('\n')}`;
}

/** Bloque que se manda al cliente al confirmar. */
function summaryBlock(pricing) {
  const lines = [itemLines(pricing.items)];
  if (pricing.discountPct) lines.push(`🏷️ Descuento ${pricing.discountPct}%: −${fmt(pricing.discountAmount)}`);
  lines.push(`💰 Total: ${fmt(pricing.total)}`);
  return lines.join('\n');
}

/**
 * Convierte un borrador viejo (product_name/quantity/price) al formato de
 * ítems, y limpia campos que ya no se usan. Idempotente.
 */
function normalizeDraft(draft = {}) {
  const d = { ...draft };
  if (!Array.isArray(d.items)) d.items = [];
  if (d.product_name && d.items.length === 0) {
    d.items = [{ product_name: d.product_name, quantity: parseInt(d.quantity, 10) || 1, price: d.price || null }];
  }
  delete d.product_name; delete d.quantity; delete d.price;
  return d;
}

module.exports = {
  flattenCatalog,
  matchProduct,
  matchPromotionBundle,
  priceItems,
  pricingContext,
  summaryBlock,
  itemLines,
  normalizeDraft,
  fmt,
  MAX_DISCOUNT_PCT,
};
