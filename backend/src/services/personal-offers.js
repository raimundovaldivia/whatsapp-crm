const DEFAULT_MIN_TRAYS = 1;
const DEFAULT_UNIT_COST = 150;
const DEFAULT_MIN_MARGIN_PCT = 35;
const DEFAULT_VALID_HOURS = 48;
const DEFAULT_TIERS = Object.freeze([
  { minTrays: 1, amount: 1000 },
  { minTrays: 2, amount: 4000 },
  { minTrays: 3, amount: 7000 },
]);
const ALLOWED_AMOUNTS = new Set([1000, 3500, 4000, 7000]);

function folded(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function chileDateTime(value) {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function customerFirstName(value) {
  const name = String(value || '').trim();
  if (!name || /^cliente$/i.test(name) || /^[+0-9 ()-]+$/.test(name)) return '';
  return name.split(/\s+/)[0];
}

function eggsPerTray(value) {
  const text = folded(value);
  const match = text.match(/bandeja\s+(?:de\s+)?(\d{1,3})/);
  const quantity = Number(match?.[1]);
  return quantity > 0 && quantity <= 60 ? quantity : 30;
}

function safeTiers(candidate = {}) {
  const unitCost = Math.max(0, Number(candidate.unit_cost || DEFAULT_UNIT_COST));
  const minMarginPct = Math.max(0, Math.min(100, Number(candidate.min_margin_pct ?? DEFAULT_MIN_MARGIN_PCT)));
  let products = candidate.eligible_products;
  if (typeof products === 'string') {
    try { products = JSON.parse(products); } catch { products = []; }
  }
  if (!Array.isArray(products) || !products.length) {
    products = [{ title: '', price: Number(candidate.min_tray_price) }];
  }
  products = products
    .map(product => ({ price: Number(product.price), eggs: eggsPerTray(product.title) }))
    .filter(product => product.price > 0);
  if (!products.length) return null;
  const safe = DEFAULT_TIERS.filter(tier => {
    return products.every(product => {
      const revenue = product.price * tier.minTrays - tier.amount;
      const cost = tier.minTrays * product.eggs * unitCost;
      const marginPct = revenue > 0 ? ((revenue - cost) / revenue) * 100 : -Infinity;
      return marginPct >= minMarginPct;
    });
  });
  return safe.length === DEFAULT_TIERS.length ? safe : null;
}

function normalizedTiers(offer = {}) {
  const raw = typeof offer.discount_tiers === 'string'
    ? (() => { try { return JSON.parse(offer.discount_tiers); } catch { return []; } })()
    : offer.discount_tiers;
  const tiers = Array.isArray(raw) && raw.length ? raw : [{ minTrays: offer.min_trays || 2, amount: offer.discount_amount }];
  return tiers
    .map(tier => ({ minTrays: Math.max(1, Number(tier.minTrays) || 0), amount: Number(tier.amount) || 0 }))
    .filter(tier => ALLOWED_AMOUNTS.has(tier.amount))
    .sort((a, b) => a.minTrays - b.minTrays);
}

function buildMessage(offer, candidate = {}) {
  const tiers = normalizedTiers(offer);
  if (!tiers.length) throw new Error('Escala de oferta personal inválida');
  const firstName = customerFirstName(candidate.contact_name);
  const greeting = firstName ? `Hola ${firstName} 😊` : 'Hola 😊';
  const expiry = chileDateTime(offer.expires_at);
  return `${greeting} Te dejé un regalo personal para tu próxima compra de huevos XL o L: $1.000 con 1 bandeja, $4.000 con 2 o $7.000 con 3 o más. Está asociado exclusivamente a tu número y vence el ${expiry}. ¿Quieres aprovecharlo?`;
}

function eligibleEggMetrics(items = []) {
  return items.reduce((totals, item) => {
    const text = folded(item?.name || item?.title || item?.product_name);
    const eligibleSize = /\bxl\b/.test(text) || /(?:^|\s)l(?:\s|$)/.test(text);
    const isEggTray = /\bhuevos?\b/.test(text) && /\bbandeja\b/.test(text) && eligibleSize;
    if (!isEggTray) return totals;
    const trays = Math.max(0, Number(item?.quantity) || 0);
    totals.trays += trays;
    totals.eggs += trays * eggsPerTray(text);
    totals.subtotal += trays * Math.max(0, Number(item?.price) || 0);
    return totals;
  }, { trays: 0, eggs: 0, subtotal: 0 });
}

function eggTrayQuantity(items = []) {
  return eligibleEggMetrics(items).trays;
}

function eligibleEggQuantity(items = []) {
  return eligibleEggMetrics(items).eggs;
}

function applicableDiscount(pricing, offer, now = new Date()) {
  if (!pricing || !offer || offer.status !== 'sent') return 0;
  if (new Date(offer.expires_at).getTime() <= new Date(now).getTime()) return 0;
  const eggMetrics = eligibleEggMetrics(pricing.items);
  const trays = eggMetrics.trays;
  const tier = normalizedTiers(offer).filter(item => trays >= item.minTrays).at(-1);
  if (!tier) return 0;
  const amount = tier.amount;
  const unitCost = Math.max(0, Number(offer.unit_cost || DEFAULT_UNIT_COST));
  const minMarginPct = Math.max(0, Math.min(100, Number(offer.min_margin_pct ?? DEFAULT_MIN_MARGIN_PCT)));
  const existingDiscount = Number(pricing.discountAmount) || 0;
  const netRevenue = Math.max(0, eggMetrics.subtotal - existingDiscount - amount);
  const estimatedCost = eggMetrics.eggs * unitCost;
  const marginPct = netRevenue > 0 ? ((netRevenue - estimatedCost) / netRevenue) * 100 : -Infinity;
  return marginPct >= minMarginPct ? amount : 0;
}

function eligiblePricing(pricing, offer, now = new Date()) {
  return applicableDiscount(pricing, offer, now) > 0;
}

function promptSection(offer) {
  if (!offer) return '';
  return `## Beneficio personal vigente\nEste cliente ya recibió una escala personal asociada a su número, válida hasta ${chileDateTime(offer.expires_at)}: $1.000 con 1 bandeja de huevos XL o L, $4.000 con 2 y $7.000 con 3 o más. Se aplica una sola vez y solo si el sistema confirma el margen. No aplica a otras tallas o productos. No ofrezcas porcentajes, no aumentes los montos y no inventes otra promoción.`;
}

function expiryFrom(now = new Date(), hours = DEFAULT_VALID_HOURS) {
  const safeHours = Math.max(1, Math.min(168, Number(hours) || DEFAULT_VALID_HOURS));
  return new Date(new Date(now).getTime() + safeHours * 60 * 60 * 1000);
}

module.exports = {
  DEFAULT_MIN_TRAYS,
  DEFAULT_UNIT_COST,
  DEFAULT_MIN_MARGIN_PCT,
  DEFAULT_VALID_HOURS,
  DEFAULT_TIERS,
  safeTiers,
  normalizedTiers,
  buildMessage,
  eggsPerTray,
  eggTrayQuantity,
  eligibleEggQuantity,
  applicableDiscount,
  eligiblePricing,
  promptSection,
  expiryFrom,
};
