// A single commercial rule for the bot and the public checkout. Never changes old orders.
const TIERS = { 30: 11000, 60: 22000, 100: 36500, 180: 54000 };
const WEB_TIERS = { ...TIERS, 30: 12000, 90: 30000 };
const forStore = ctx => ({ ...ctx, eligible: ctx.enabled, tiers: WEB_TIERS, web: true });
const STORE_SLUG = 'diez-rios-mrs96z69';
function packSize(item) {
  const title = String(item.product_name || item.name || item.title || '').toLowerCase();
  if (/^huevos (m|l|xl|jumbo) (blancos|mixtos|cafés) · bandeja de/.test(title)) return 0;
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
function trayTotal(item) {
  const name=String(item.title||item.name||item.product_name||'').toLowerCase(),q=Number(item.quantity),price=Number(item.price);
  if(/\bm\b/.test(name)||!/huevo/.test(name)||/queso|aceituna|combo|pack|promo|empresa|caja|granel|\b(?:60|100|180)\b/.test(name)||!Number.isSafeInteger(q)||q<1||price<1000)return price*q;
  return Math.floor(q/3)*Math.round(price*2.5/100)*100+(q%3===2?Math.round(price*11/6/100)*100:(q%3)*price);
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
  if(ctx.web)for(const i of result){
    if(i.locked_quote||i.free_gift||['especial','promocion','promocion_cantidad'].includes(i.unit_source))continue;
    const total=trayTotal(i);if(total<Number(i.price)*Number(i.quantity)){i.price=total/Number(i.quantity);i.unit_source='escala_bandejas';}
  }
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
  if (!items.some(i => ['escala_xl','escala_bandejas'].includes(i.unit_source)) || total > quote.total) return quote;
  return { ...quote, items, subtotal: total, total, discountPct: 0, discountAmount: 0,
    categoryDiscounts: [], secondUnitDiscounts: [] };
}
function prompt(ctx, products = []) {
  if (!ctx.enabled) return '';
  if(ctx.web){
    const table=products.filter(p=>p.is_business!==true&&/huevo/i.test(p.title||p.name||'')).map(p=>{
      const name=p.title||p.name;
      const totals=[1,2,3].map(quantity=>{const lines=apply([{...p,title:name,quantity,price:Number(p.price ?? p.priceMin)}],ctx);return Math.round(lines[0].price*quantity)});
      return `- ${name}: 1 unidad de venta $${totals[0]}; 2 $${totals[1]}; 3 $${totals[2]}.`;
    }).join('\n');
    return `## Precios de huevos para particulares: misma tabla del ecommerce
${table}
Nueva metodología comercial vigente desde el 9 de octubre de 2026: en la primera consulta de precios o inicio de pedido, da contexto breve: "Ahora tenemos descuentos por llevar 2 o 3 bandejas de la misma variedad". Explica el total y ahorro exactos del producto elegido, y que las M no participan. Revisa el historial y no repitas esta introducción si ya se explicó en la conversación. No interrumpas una consulta de pago, reclamo o despacho con publicidad. No digas "desde hoy" en fechas posteriores ni sugieras que cambió un pedido anterior ya confirmado.
Ofrece activamente la promoción: si pide 1 bandeja, indica cuánto cuesta sumar la segunda y el total; si pide 2, ofrece la tercera con su total. Solo ofrece productos con stock. Nunca agregues cantidades sin aceptación. Si el cliente rechaza, continúa sin insistir. No ofrezcas descuento para M. Si falta color o cantidad por bandeja, pregunta antes de escoger un producto.
Clasificación de nuestra tienda: M 47–53,9 g; L 54–60,9 g; XL 61–67,9 g; Jumbo más de 74 g por huevo. Habla de categoría de peso, no de tamaño visual: clasificamos por peso, no por apariencia; la forma puede variar. No presentes estos rangos como una norma legal ni inventes equivalencias para otros pesos. El color no determina el peso. Explica esto si preguntan por tamaños o diferencias.
Cada unidad de venta es una bandeja o caja según el nombre: nunca confundas cantidad de huevos con cantidad de bandejas. Las promociones son para el mismo producto; las bandejas M no tienen descuento por cantidad. No acumules estos precios con otros descuentos. Respeta precios especiales y promociones ya acordadas si son mejores. No uses la antigua escala de primera compra ni inventes colores, disponibilidad o precios. Si no está definido el color, no prometas blanco, café ni mixto.
Antes de las 13:00 de America/Santiago: entrega el mismo día de reparto, sujeto a stock y cobertura. Confirma el pedido solamente después de guardarlo.`;
  }
  return `## Escala XL autorizada\n${ctx.eligible ? 'Cliente elegible por primera compra o compra previa en esta escala. Precios finales: 30 XL $11.000; 60 XL $22.000; 100 XL $36.500; 180 XL $54.000.' : 'Cliente sin beneficio de bienvenida: usa sus tarifas vigentes, no ofrezcas esta escala.'}
No acumules descuentos. Respeta tarifas especiales y ofertas mejores. No uses la antigua escalera de 5%, 7% o 10%. Responde precios directamente; prioriza 30 y 60 XL sin ocultar otros formatos si los pide.
Pedidos antes de las 13:00 (America/Santiago) se entregan el mismo día de reparto, sujeto a stock y cobertura. Después de esa hora confirma la próxima fecha disponible. No prometas envío gratis adicional. No registres un pedido sin aceptación ni confirmes antes de guardarlo.`;
}
module.exports = { trayTotal, WEB_TIERS, forStore, TIERS, STORE_SLUG, packSize, scaleTotal, historicalScale, context, apply, applyQuote, prompt };
