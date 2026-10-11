// A single commercial rule for the bot and the public checkout. Never changes old orders.
const TIERS = { 30: 11000, 60: 22000, 100: 36500, 180: 54000 };
const WEB_TIERS = { ...TIERS, 30: 12000, 90: 30000 };
const forStore = ctx => ({ ...ctx, eligible: ctx.enabled, tiers: WEB_TIERS, web: true });
const STORE_SLUG = 'diez-rios-mrs96z69';
const money = value => `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
const normalize = value => String(value || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
function packSize(item) {
  const title = String(item.product_name || item.name || item.title || '').toLowerCase();
  // Una caja activa ya tiene un precio final de catálogo. No debe volver a
  // pasar por la escala que combina presentaciones XL sueltas.
  if (/\bcaja\b/.test(title)) return 0;
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

function eggSize(value) {
  const text = normalize(value);
  if (/\bjumbo\b/.test(text)) return 'Jumbo';
  if (/\bxl\b/.test(text)) return 'XL';
  if (/(?:^|\s)l(?:\s|$)/.test(text)) return 'L';
  if (/(?:^|\s)m(?:\s|$)/.test(text)) return 'M';
  return null;
}

function eggColor(product) {
  const configured = normalize(product?.egg_color);
  const text = `${configured} ${normalize(product?.title || product?.name)}`;
  if (/\bblanc/.test(text)) return 'blancos';
  if (/\bmixt/.test(text)) return 'mixtos';
  if (/\bcafe/.test(text)) return 'cafés';
  return null;
}

function presentationUnits(product) {
  const configured = Number(product?.pack_units);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  const text = normalize(product?.title || product?.name);
  const match = text.match(/\bbandeja\s*(?:de\s*)?(\d{1,3})\b/)
    || text.match(/\b(\d{1,3})\s*(?:huevos?|unidades?)\b/);
  return Number(match?.[1]) || null;
}

function quantityTargets(text) {
  const result = [];
  for (const match of String(text || '').matchAll(/\b(\d{2,3})\b/g)) {
    const value = Number(match[1]);
    if (value >= 20 && value <= 500 && !result.includes(value)) result.push(value);
  }
  return result;
}

/**
 * Cotiza en código cantidades expresadas como número de huevos (p. ej. 100 XL).
 * Evita que el modelo confunda una caja eliminada con las bandejas activas o
 * describa un "descuento automático" sin mostrar el total final.
 */
function quantityPriceReply(userMessage, history = [], products = [], ctx = {}) {
  const current = String(userMessage || '');
  if (!ctx?.web || !/(?:cu[aá]nto|cu[aá]l|qu[eé]).{0,24}(?:vale|valen|valor|cuesta|cuestan|sale|salen)|\bprecio\b/iu.test(current)) return null;
  const targets = quantityTargets(current);
  if (!targets.length) return null;

  const recentInbound = [current, ...history.slice().reverse()
    .filter(message => message?.direction === 'inbound')
    .map(message => String(message.content || ''))].slice(0, 6);
  const size = recentInbound.map(eggSize).find(Boolean);
  if (!size) return null;
  const requestedColor = recentInbound.map(text => eggColor({ title: text })).find(Boolean);
  const askedForBox = recentInbound.some(text => /\bcaja\b/iu.test(text));

  const available = products.filter(product => {
    const title = product?.title || product?.name || '';
    const price = Number(product?.price ?? product?.priceMin);
    return product?.active !== false && product?.available !== false && Number(product?.stock ?? 1) !== 0
      && price > 0 && eggSize(product?.egg_size || title) === size;
  });
  if (!available.length) return null;

  // Si existe la caja exacta activa, el agente debe usarla tal cual; este
  // atajo sólo resuelve equivalencias con bandejas cuando esa caja no existe.
  if (targets.some(target => available.some(product => {
    const title = normalize(product?.title || product?.name);
    return /\bcaja\b/.test(title) && presentationUnits(product) === target;
  }))) return null;

  const sections = [];
  for (const target of targets.slice(0, 2)) {
    const bestByColor = new Map();
    for (const product of available) {
      const title = product?.title || product?.name || '';
      const normalizedTitle = normalize(title);
      const units = presentationUnits(product);
      const color = eggColor(product);
      if (!/\bbandeja\b/.test(normalizedTitle) || !units || !color || target % units !== 0) continue;
      if (requestedColor && color !== requestedColor) continue;
      const quantity = target / units;
      if (!Number.isSafeInteger(quantity) || quantity < 2 || quantity > 30) continue;
      const [priced] = apply([{ ...product, title, quantity, price: Number(product.price ?? product.priceMin) }], ctx);
      const total = Math.round(Number(priced?.price) * quantity);
      if (!Number.isFinite(total) || total <= 0) continue;
      const option = { color, quantity, units, total };
      const previous = bestByColor.get(color);
      if (!previous || total < previous.total || (total === previous.total && quantity < previous.quantity)) {
        bestByColor.set(color, option);
      }
    }
    const options = ['blancos', 'mixtos', 'cafés'].map(color => bestByColor.get(color)).filter(Boolean);
    if (!options.length) continue;
    const heading = `${target} huevos ${size} exactos`;
    const lines = options.map(option => `${option.color[0].toUpperCase()}${option.color.slice(1)}: ${option.quantity} bandejas de ${option.units} — ${money(option.total)}`);
    sections.push({ target, heading, lines });
  }
  if (!sections.length) return null;

  const first = sections[0];
  const intro = askedForBox
    ? `No tenemos una caja activa de ${first.target} huevos ${size}, pero sí podemos completar ${first.heading} con bandejas de la misma variedad:`
    : `Para completar ${first.heading} con bandejas de la misma variedad:`;
  const extra = sections.slice(1).map(section => `Para ${section.heading}:\n${section.lines.join('\n')}`);
  const detail = [first.lines.join('\n'), ...extra].join('\n\n');
  const condition = size === 'M'
    ? 'En las bandejas M no hay descuento por cantidad.'
    : 'Estos totales ya incluyen el descuento por repetir exactamente la misma bandeja; no se mezclan colores ni formatos y no se agrega otro porcentaje.';
  const close = requestedColor ? '¿Te preparo esa opción?' : '¿Qué color prefieres?';
  return `${intro}\n${detail}\n\n${condition} ${close}`;
}

function prompt(ctx, products = []) {
  if (!ctx.enabled) return '';
  if(ctx.web){
    const table=products.filter(p=>p.is_business!==true&&/huevo/i.test(p.title||p.name||'')).map(p=>{
      const name=p.title||p.name;
      const totals=[1,2,3,4,5,6].map(quantity=>{const lines=apply([{...p,title:name,quantity,price:Number(p.price ?? p.priceMin)}],ctx);return Math.round(lines[0].price*quantity)});
      const normalized=String(name||'').toLowerCase();
      const units=Number((normalized.match(/\bbandeja\s*(?:de\s*)?(\d{1,3})\b/)||normalized.match(/\b(\d{1,3})\s*(?:huevos?|unidades?)\b/)||[])[1])||null;
      const packageName=/\bcaja\b/.test(normalized)||(!/\bbandeja\b/.test(normalized)&&units>=100)?'caja':/\bbandeja\b/.test(normalized)?'bandeja':'presentación';
      const exactPresentation=`1 ${packageName}${units?` de ${units} huevos`:''}`;
      const packagePlural=packageName==='presentación'?'presentaciones':`${packageName}s`;
      return `- ${name}: presentación exacta = ${exactPresentation}; ${totals.map((total,index)=>`${index+1} ${index===0?packageName:packagePlural} $${total}`).join('; ')}.`;
    }).join('\n');
    return `## Precios de huevos para particulares: misma tabla del ecommerce
${table}
Origen confirmado por Diez Ríos: todos nuestros huevos son 100% de campo, incluidos blancos, cafés y mixtos. Destaca este atributo de forma natural al presentar los huevos o responder por su origen; no lo repitas en cada mensaje. No deduzcas del término "de campo" certificación orgánica, crianza libre, alimentación específica ni otras condiciones no verificadas.
Nueva metodología comercial vigente desde el 9 de octubre de 2026: en la primera consulta de precios o inicio de pedido, explica brevemente que el descuento se calcula al repetir exactamente la misma bandeja: misma talla, mismo color y misma cantidad de huevos por bandeja. No se calcula por el total general de huevos ni se mezclan colores o formatos. Nunca respondas solamente "hay descuento automático": muestra el total final y el ahorro exactos para la opción consultada, y aclara que las M no participan. Revisa el historial y no repitas esta introducción si ya se explicó en la conversación. No interrumpas una consulta de pago, reclamo o despacho con publicidad. No digas "desde hoy" en fechas posteriores ni sugieras que cambió un pedido anterior ya confirmado.
Ofrece activamente la promoción: si pide 1 bandeja, indica cuánto cuesta sumar la segunda y el total; si pide 2, ofrece la tercera con su total. Solo ofrece productos con stock. Nunca agregues cantidades sin aceptación. Si el cliente rechaza, continúa sin insistir. No ofrezcas descuento para M. Si falta color o cantidad por bandeja, pregunta antes de escoger un producto.
Si pide una cantidad total de huevos cuya caja ya no existe, intenta formar esa cantidad exacta con bandejas activas antes de decir que no se puede. Ejemplo obligatorio: 100 huevos XL pueden formarse con 5 bandejas XL de 20; conserva el nombre "bandejas", calcula el total de esa misma variedad y pregunta el color si falta. Para 120 huevos compara las combinaciones exactas activas y ofrece la de menor total para cada color. No revivas cajas legacy ni presentes una suma de bandejas como caja.
Referencia NCh1376.Of78 divulgada por Chilehuevos: Muy chico hasta 40 g; Chico más de 40 y hasta 47 g; Mediano (M) más de 47 y hasta 54 g; Grande (L) más de 54 y hasta 61 g; Extra grande (XL) más de 61 y hasta 68 g; Especial más de 68 g. Estos son los rangos de la referencia chilena, no los rangos comerciales que anunciamos para L y XL. En Diez Ríos elevamos 2 g los extremos de referencia para nuestra selección comercial: L de 56 a 63 g y XL (Extra grande) de 63 a 70 g. Al ofrecer nuestros productos usa estos rangos comerciales y explica la diferencia si preguntan. No digas que la norma chilena fija L en 56–63 ni XL en 63–70. Los rangos comerciales comparten el límite 63 g: no reasignes un producto por ese peso; conserva su variante registrada. No extiendas el ajuste de 2 g a M, Especial o Jumbo. Es peso individual del huevo con cáscara. En la tabla normativa los límites superiores están incluidos: 54 g es M, 61 g es L y 68 g es XL. Jumbo no es una categoría independiente de esta norma: es el nombre comercial de nuestra selección sobre 74 g, que pertenece a Especial. Habla de categoría de peso, no de apariencia. No afirmes certificación, cumplimiento de un lote ni obligatoriedad legal sin verificación. El color no determina el peso. Explica esto si preguntan por tamaños o diferencias.
DEFINICIÓN COMERCIAL OBLIGATORIA: una bandeja es la presentación individual de 20 o 30 huevos indicada en el nombre. Una caja es un formato diferente y de mayor cantidad; sólo existe si el catálogo activo dice "Caja" o muestra una presentación cerrada de 100 o 180 huevos. Una caja NO es sinónimo de una bandeja y varias bandejas con descuento NO pasan a llamarse caja. Los precios de la tabla anterior corresponden a la presentación exacta escrita en cada línea. Si todas las líneas activas dicen bandeja y preguntan "¿esos precios son por caja?", responde directamente que son precios por bandeja e indica cuántos huevos trae cada una. Cada vez que el cliente diga "caja" sin indicar su contenido, la PRIMERA pregunta debe ser: "¿De cuántos huevos necesitas la caja?". Sólo después pregunta calibre o color si todavía hace falta; no deduzcas la cantidad desde el historial. Si no hay una caja activa en el catálogo, dilo y ofrece calcular el total de las bandejas disponibles; nunca inventes un precio de caja ni conviertas una caja en bandeja por tu cuenta.
Cada unidad de venta es una bandeja o caja según el nombre: nunca confundas cantidad de huevos con cantidad de bandejas. Las promociones son para el mismo producto; las bandejas M no tienen descuento por cantidad. No acumules estos precios con otros descuentos. Respeta precios especiales y promociones ya acordadas si son mejores. No uses la antigua escala de primera compra ni inventes colores, disponibilidad o precios. Si no está definido el color, no prometas blanco, café ni mixto.
Antes de las 13:00 de America/Santiago: entrega el mismo día de reparto, sujeto a stock y cobertura. Confirma el pedido solamente después de guardarlo.`;
  }
  return `## Escala XL autorizada\n${ctx.eligible ? 'Cliente elegible por primera compra o compra previa en esta escala. Precios finales: 30 XL $11.000; 60 XL $22.000; 100 XL $36.500; 180 XL $54.000.' : 'Cliente sin beneficio de bienvenida: usa sus tarifas vigentes, no ofrezcas esta escala.'}
No acumules descuentos. Respeta tarifas especiales y ofertas mejores. No uses la antigua escalera de 5%, 7% o 10%. Responde precios directamente; prioriza 30 y 60 XL sin ocultar otros formatos si los pide.
Pedidos antes de las 13:00 (America/Santiago) se entregan el mismo día de reparto, sujeto a stock y cobertura. Después de esa hora confirma la próxima fecha disponible. No prometas envío gratis adicional. No registres un pedido sin aceptación ni confirmes antes de guardarlo.`;
}
module.exports = { trayTotal, WEB_TIERS, forStore, TIERS, STORE_SLUG, packSize, scaleTotal, historicalScale, context, apply, applyQuote, quantityPriceReply, prompt };
