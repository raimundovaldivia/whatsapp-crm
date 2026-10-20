'use strict';

/**
 * campaign-offers.js — reglas puras de ofertas personales enviadas por texto libre.
 *
 * Sin efectos externos: no toca base de datos, WhatsApp ni IA. El llamador
 * persiste el resultado. Reglas acordadas:
 *  - Vale la última oferta enviada a un cliente; al enviar una nueva, las
 *    anteriores pendientes quedan `superseded`.
 *  - Alcance por defecto explícito: todas las unidades del producto ofrecido,
 *    salvo que el campo `scope` indique un tope.
 *  - Para crear un pedido nuevo la oferta debe estar `sent` y dentro de vigencia.
 *  - Cancelar un pedido canjeado devuelve la oferta a `sent` solo si sigue vigente;
 *    si no, queda `expired`.
 *  - Un problema de despacho no cambia la oferta: el pedido conserva el precio.
 *  - Una oferta incompleta no puede enviarse: se devuelve la lista de campos faltantes
 *    para completarlos manualmente en la app.
 */

const REQUIRED_FIELDS = ['product_id', 'offer_price', 'expires_at', 'scope', 'recipients'];

// Dates without an offset are business dates/times in Chile, never server-local
// midnight. A date alone remains valid through that business day's end.
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const local = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  const day = raw.slice(0, 10);
  if (!require('./business-date').isValidISODate(day)) return null;
  if (!local) {
    if (!/T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const [year, month, date] = day.split('-').map(Number);
  const hour = local[2] == null ? 23 : Number(local[2]);
  const minute = local[3] == null ? 59 : Number(local[3]);
  const second = local[2] == null ? 59 : Number(local[4] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const target = Date.UTC(year, month - 1, date, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const localStamp = ms => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  let instant = target;
  for (let i = 0; i < 3; i++) instant += target - localStamp(instant);
  // Reject a local hour that does not exist during a daylight-saving transition.
  if (localStamp(instant) !== target) return null;
  return new Date(instant + (local[2] == null ? 999 : 0));
}

function validateScope(scope) {
  if (scope === 'all_units') return null;
  if (scope && typeof scope === 'object' && Number.isInteger(scope.cap_units) && scope.cap_units > 0) return null;
  return 'scope debe ser "all_units" o { cap_units: entero > 0 }';
}

/**
 * @param {object} fields  campos extraídos de la instrucción (pueden faltar)
 * @param {{catalog: Array<{product_id, title, available, unit_cost?, min_margin_pct?}>, now?: Date}} opts
 * @returns {{ok: boolean, missing: string[], errors: string[]}}
 */
function validateOfferDraft(fields = {}, { catalog = [], now = new Date() } = {}) {
  const missing = REQUIRED_FIELDS.filter(key => {
    const value = fields[key];
    if (value === undefined || value === null || value === '') return true;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
  const errors = [];
  const warnings = [];

  if (!missing.includes('product_id')) {
    const matches = catalog.filter(p => p.available !== false && String(p.product_id) === String(fields.product_id));
    if (matches.length !== 1) errors.push('product_id debe corresponder a exactamente un producto disponible');
    else if (!missing.includes('offer_price')) {
      const product = matches[0];
      const price = Number(fields.offer_price);
      if (!Number.isInteger(price) || price <= 0) errors.push('offer_price debe ser un entero mayor que cero');
      else if (product.unit_cost != null && product.min_margin_pct != null) {
        const floor = Math.ceil(Number(product.unit_cost) * (1 + Number(product.min_margin_pct) / 100));
        if (price < floor) errors.push(`offer_price ${price} está bajo el mínimo con margen (${floor})`);
      } else {
        // Sin costo o margen no hay nada que comparar: el operador debe confirmarlo.
        warnings.push('margen sin verificar: el producto no tiene costo o margen mínimo');
        if (fields.margin_confirmed !== true) missing.push('margin_confirmed');
      }
    }
  }

  if (!missing.includes('expires_at')) {
    const expires = toDate(fields.expires_at);
    if (!expires) errors.push('expires_at debe ser una fecha válida');
    else if (expires.getTime() <= now.getTime()) errors.push('expires_at ya pasó');
  }

  if (!missing.includes('scope')) {
    const scopeError = validateScope(fields.scope);
    if (scopeError) errors.push(scopeError);
  }

  return { ok: missing.length === 0 && errors.length === 0, missing, errors, warnings };
}

const isExpired = (offer, now) => {
  const expires = toDate(offer.expires_at);
  return !expires || expires.getTime() <= now.getTime();
};

/** Marca como `superseded` las ofertas pendientes anteriores al envío de una nueva. */
function supersedePending(offers, now = new Date()) {
  return offers.map(o => (o.status === 'sent' ? { ...o, status: 'superseded', superseded_at: now.toISOString() } : o));
}

/**
 * La última oferta enviada decide. Si es la última y está vigente y `sent`,
 * es la oferta usable para un pedido nuevo; en cualquier otro caso no hay oferta.
 */
function activeOfferForNewOrder(offers, now = new Date()) {
  const latest = [...offers]
    .filter(o => o.status !== 'failed')
    .sort((a, b) => new Date(b.sent_at || b.created_at) - new Date(a.sent_at || a.created_at))[0];
  if (!latest || latest.status !== 'sent' || isExpired(latest, now)) return null;
  return latest;
}

/** Aplica el precio de la oferta a las líneas del pedido del mismo producto (todas las unidades o hasta el tope). */
function applyOfferToItems(items, offer, orderId = null, now = new Date()) {
  const usableNew = offer && offer.status === 'sent' && !isExpired(offer, now);
  const usableForThisOrder = offer && offer.status === 'redeemed' && offer.redeemed_order_id === orderId;
  if (!usableNew && !usableForThisOrder) return { items, applied: false };
  const cap = offer.scope && typeof offer.scope === 'object' ? offer.scope.cap_units : null;
  let remaining = cap ?? Infinity;
  const next = [];
  for (const item of items) {
    const quantity = Number(item.quantity) || 0;
    if (String(item.product_id) !== String(offer.product_id) || remaining <= 0 || quantity <= 0) { next.push(item); continue; }
    const units = Math.min(quantity, remaining);
    remaining -= units;
    next.push({ ...item, quantity: units, price: Number(offer.offer_price), unit_price: Number(offer.offer_price), offer_id: offer.id, offer_units: units, offer_applied: true });
    // Tope parcial: el resto del pedido vuelve al precio normal.
    if (units < quantity) next.push({ ...item, quantity: quantity - units });
  }
  return { items: next, applied: next.some(i => i.offer_applied) };
}

/** Pasa la oferta a `redeemed` al crear un pedido con ella. */
function redeem(offer, orderId, now = new Date()) {
  if (!(offer.status === 'sent' && !isExpired(offer, now))) throw new Error('La oferta no está disponible para un pedido nuevo');
  return { ...offer, status: 'redeemed', redeemed_order_id: orderId, redeemed_at: now.toISOString() };
}

/** Cancelar el pedido canjeado: vuelve a `sent` solo si la vigencia aún corresponde. */
function onOrderCancelled(offer, now = new Date()) {
  if (offer.status !== 'redeemed') return offer;
  const next = isExpired(offer, now) ? 'expired' : 'sent';
  return { ...offer, status: next, redeemed_order_id: null, redeemed_at: null };
}

/** Problema de despacho: la oferta sigue asociada al pedido aunque haya vencido. */
function onDispatchProblem(offer) {
  return offer;
}

/** Marca como `expired` las ofertas enviadas cuya vigencia ya pasó. */
function expireDue(offers, now = new Date()) {
  return offers.map(o => (o.status === 'sent' && isExpired(o, now) ? { ...o, status: 'expired' } : o));
}

/**
 * Convierte la oferta vigente al formato de promoción que ya usa el bot
 * (specialPrices por producto), para que el precio se aplique por el mismo
 * camino que las promociones de plantilla. Sin tope: unitPrice para cualquier
 * cantidad. Con tope: precios exactos hasta el tope; sobre el tope, catálogo.
 */
function toPromotionContext(offer, now = new Date()) {
  if (!offer || offer.product_id == null || offer.offer_price == null) return null;
  const key = String(offer.product_id);
  const price = Number(offer.offer_price);
  const cap = offer.scope && typeof offer.scope === 'object' ? offer.scope.cap_units : null;
  const quantities = {};
  if (cap) for (let q = 1; q <= cap; q += 1) quantities[String(q)] = price * q;
  const expiresAt = toDate(offer.expires_at)?.toISOString() || null;
  const active = offer.status === 'sent' && !isExpired(offer, now);
  return {
    templateName: 'oferta_personal_campana',
    offerId: offer.id ?? null,
    body: '',
    offers: [{ units: null, quantity: cap || null, descriptor: key, label: offer.product_title || key, price, named: true, direct: true, productId: key }],
    discountPct: 0,
    categoryDiscounts: [],
    secondUnitDiscounts: [],
    freeGift: null,
    specialPrices: { [key]: { unitPrice: cap ? 0 : price, quantities } },
    sentDay: null,
    validUntil: expiresAt ? expiresAt.slice(0, 10) : null,
    validOnlyToday: false,
    deliveryWeekOnly: false,
    freeShippingMin: 0,
    orderCutoffOnlyToday: false,
    usesDefaultValidity: false,
    expiresAt,
    cutoff: null,
    sameDayConditional: false,
    stockConditional: false,
    active,
  };
}

const isExpiredOffer = (offer, now = new Date()) => isExpired(offer, now);

/** Varias ofertas vigentes (una por producto) como un solo contexto de precios. */
function toPromotionContextMany(offers, now = new Date()) {
  const contexts = (offers || []).map(o => toPromotionContext(o, now)).filter(Boolean);
  if (!contexts.length) return null;
  return {
    ...contexts[0],
    offerId: null,
    offerIds: contexts.map(c => c.offerId),
    offers: contexts.flatMap(c => c.offers),
    specialPrices: Object.assign({}, ...contexts.map(c => c.specialPrices)),
    active: contexts.some(c => c.active),
  };
}

/** Lista de ofertas de un destinatario: `offers` (varias) o `offer` (una, compatibilidad). */
function offerListFrom(item) {
  if (Array.isArray(item?.offers)) return item.offers.filter(Boolean);
  return item?.offer ? [item.offer] : [];
}

module.exports = {
  offerExpiryDate: toDate,
  offerListFrom,
  toPromotionContextMany,
  isExpiredOffer,
  REQUIRED_FIELDS,
  validateOfferDraft,
  supersedePending,
  activeOfferForNewOrder,
  applyOfferToItems,
  redeem,
  onOrderCancelled,
  onDispatchProblem,
  expireDue,
  toPromotionContext,
};
