// A single commercial rule for the bot and the public checkout. Never changes old orders.
const TIERS = { 30: 11000, 60: 22000, 100: 36500, 180: 54000 };
const WEB_TIERS = { ...TIERS, 30: 12000 };
const forStore = ctx => ({ ...ctx, eligible: ctx.enabled, tiers: WEB_TIERS });
const STORE_SLUG = 'diez-rios-mrs96z69';
function packSize(item) {
  const title = String(item.product_name || item.name || item.title || '').toLowerCase();
  if (!/\bxl\b/.test(title) || /queso|aceituna|combo|especial|empresa/.test(title)) return 0;
  if (!/huevo|bandeja|caja|promo/.test(title)) return 0;
  const sizes = title.match(/\b(?:20|30|60|100|180)\b/g) || [];
  return sizes.length === 1 && TIERS[Number(sizes[0])] ? Number(sizes[0]) : 0;
}
function scaleTotal(units, tiers = TIERS) {
  if (!Number.isSafeInteger(units) || units < 1 || units > 180000) return null;
  const dp = Array(units + 1).fill(Infinity); dp[0] = 0;
  for (let n = 1; n <= units; n++) for (const [pack, price] of Object.entries(tiers)) {
    if (n >= Number(pack)) dp[n] = Math.min(dp[n], dp[n - Number(pack)] + price);
  }
  return Number.isFinite(dp[units]) ? dp[units] : null;
}
function parseItems(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function historicalScale(order) {
  const items = parseItems(order.items).filter(i => packSize(i) && Number(i.quantity) > 0);
  const units = items.reduce((s, i) => s + packSize(i) * Number(i.quantity), 0);
  const actual = items.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
  return units > 0 && Number.isFinite(actual) && Math.abs(actual - scaleTotal(units)) < 1;
}
async function context(queryable, orgId, phone) {
  const { rows: orgs } = await queryable.query('SELECT slug FROM organizations WHERE id = $1', [orgId]);
  if (orgs[0]?.slug !== STORE_SLUG) return { enabled: false, eligible: false };
  const clean = String(phone || '').replace(/\D/g, '');
  if (!/^(?:56)?9\d{8}$/.test(clean)) return { enabled: true, eligible: false };
  const national = clean.slice(-9);
  const variants = [national, '56' + national];
  const { rows } = await queryable.query(`
    SELECT items FROM orders WHERE organization_id = $1
      AND regexp_replace(customer_phone, '[^0-9]', '', 'g') = ANY($2::text[])
      AND status NOT IN ('cancelled','refunded')
    UNION ALL
    SELECT items::text FROM shopify_orders WHERE organization_id = $1
      AND regexp_replace(customer_phone, '[^0-9]', '', 'g') = ANY($2::text[])
      AND COALESCE(UPPER(financial_status),'') NOT IN ('VOIDED','REFUNDED')
      AND COALESCE(raw_json->>'cancelled_at','') = ''`, [orgId, variants]);
  const { rows: overrides } = await queryable.query(`SELECT product_id, product_title, custom_price
    FROM contact_price_overrides WHERE organization_id = $1
    AND regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[])`, [orgId, variants]);
  return { enabled: true, eligible: rows.length === 0 || rows.some(historicalScale), overrides };
}
function apply(items, ctx) {
  const result = items.map(i => ({ ...i }));
  if (!ctx?.enabled) return result;
  for (const item of result) {
    const override = ctx.overrides?.find(o => String(o.product_id) === String(item.product_id ?? item.id)
      || (o.product_title && o.product_title === (item.title || item.name || item.product_name)));
    if (override && Number(override.custom_price) > 0) {
      item.price = Number(override.custom_price); item.unit_source = 'especial';
    }
  }
  if (!ctx.eligible) return result;
  const selected = result.filter(i => packSize(i) && !i.locked_quote && !i.free_gift
    && !['especial','promocion','promocion_cantidad'].includes(i.unit_source));
  const units = selected.reduce((s, i) => s + packSize(i) * Number(i.quantity), 0);
  const current = selected.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
  const target = scaleTotal(units, ctx.tiers || TIERS);
  if (target === null || target > current) return result;
  let allocated = 0;
  selected.forEach((item, index) => {
    const amount = index === selected.length - 1 ? target - allocated
      : Math.round(target * Number(item.price) * Number(item.quantity) / current);
    allocated += amount; item.price = amount / Number(item.quantity); item.unit_source = 'escala_xl';
  });
  return result;
}
function applyQuote(quote, ctx) {
  if (!ctx?.eligible) return quote;
  const items = apply(quote.items, ctx);
  const total = Math.round(items.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0));
  // Choose the better complete quote; do not stack the welcome price with other discounts.
  if (!items.some(i => i.unit_source === 'escala_xl') || total > quote.total) return quote;
  return { ...quote, items, subtotal: total, total, discountPct: 0, discountAmount: 0,
    categoryDiscounts: [], secondUnitDiscounts: [] };
}
function prompt(ctx) {
  if (!ctx.enabled) return '';
  return `## Escala XL autorizada\n${ctx.eligible ? 'Cliente elegible por primera compra o compra previa en esta escala. Precios finales: 30 XL $11.000; 60 XL $22.000; 100 XL $36.500; 180 XL $54.000.' : 'Cliente sin beneficio de bienvenida: usa sus tarifas vigentes, no ofrezcas esta escala.'}
No acumules descuentos. Respeta tarifas especiales y ofertas mejores. No uses la antigua escalera de 5%, 7% o 10%. Responde precios directamente; prioriza 30 y 60 XL sin ocultar otros formatos si los pide.
Pedidos antes de las 13:00 (America/Santiago) se entregan el mismo día de reparto, sujeto a stock y cobertura. Después de esa hora confirma la próxima fecha disponible. No prometas envío gratis adicional. No registres un pedido sin aceptación ni confirmes antes de guardarlo.`;
}
module.exports = { WEB_TIERS, forStore, TIERS, STORE_SLUG, packSize, scaleTotal, historicalScale, context, apply, applyQuote, prompt };
