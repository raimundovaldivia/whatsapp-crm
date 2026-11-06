'use strict';

// One organization-owned catalog configuration, shared by web and bot.
const SETTING = 'catalog_quantity_prices';
function parseConfig(raw) {
  let config;
  try { config = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const result = {};
  for (const [sku, rule] of Object.entries(config)) {
    const totals = rule?.totals;
    if (!Array.isArray(totals) || !totals.length || totals.length > 100 ||
        totals.some((p, i) => !Number.isSafeInteger(p) || p <= 0 ||
          (i > 0 && (p < totals[i - 1] || p / (i + 1) > totals[i - 1] / i)))) continue;
    result[sku] = { totals, box_size: Number.isSafeInteger(rule.box_size) && rule.box_size > 1 ? rule.box_size : null,
      units_per_tray: Number.isSafeInteger(rule.units_per_tray) && rule.units_per_tray > 0 ? rule.units_per_tray : null };
  }
  return result;
}
async function loadConfig(db, orgId) { return parseConfig(await db.getSetting(orgId, SETTING)); }
function decorate(products, config) {
  return products.map(p => {
    const rule = config[p.sku];
    // A base-price edit must not silently retain an incompatible old scale.
    if (!rule || Number(p.priceMin ?? p.price) !== rule.totals[0]) return p;
    return { ...p, quantity_prices: rule.totals, box_size: rule.box_size, units_per_tray: rule.units_per_tray };
  });
}
function totalFor(totals, quantity) {
  if (!Array.isArray(totals) || !totals.length || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return null;
  if (quantity <= totals.length) return totals[quantity - 1];
  // Beyond one full box, retain the full-box unit rate, rounded only at total.
  return Math.round(totals[totals.length - 1] * quantity / totals.length);
}
function apply(items, products) {
  return items.map(item => {
    const product = products.find(p => String(p.id) === String(item.product_id ?? item.id));
    const total = totalFor(product?.quantity_prices, item.quantity);
    if (total === null || item.locked_quote || item.free_gift || ['especial', 'promocion', 'promocion_cantidad'].includes(item.unit_source)) return item;
    return { ...item, price: total / item.quantity, unit_source: 'escala_catalogo' };
  });
}
function aiText(product) {
  if (!product.quantity_prices?.length) return '';
  const scale = product.quantity_prices.map((p, i) => `${i + 1} bandeja(s): $${p.toLocaleString('es-CL')} total`).join('; ');
  return `  Escala automática por cantidad del MISMO producto: ${scale}. Desde ${product.quantity_prices.length} bandejas se mantiene el precio por bandeja de caja completa. Cada bandeja contiene ${product.units_per_tray} huevos. Una caja completa equivale a ${product.box_size} bandejas: registra el producto de bandeja con quantity=${product.box_size}, no como una bandeja. Los totales son de productos; confirma el despacho según las condiciones de la tienda. No sumes calibres distintos para calcular el descuento.`;
}
function parseShipping(raw) {
  let rule; try { rule = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  return rule && Number.isSafeInteger(rule.fee) && rule.fee >= 0 && Number.isSafeInteger(rule.freeFrom) && rule.freeFrom > 0
    ? { fee: rule.fee, freeFrom: rule.freeFrom } : null;
}
async function loadShipping(db, orgId) { return parseShipping(await db.getSetting(orgId, 'store_shipping_rule')); }
function withShipping(quote, rule) {
  if (!rule) return quote;
  const productsTotal = Math.round(quote.productsTotal ?? quote.total);
  const deliveryFee = productsTotal > 0 && productsTotal < rule.freeFrom ? rule.fee : 0;
  return { ...quote, productsTotal, deliveryFee, total: productsTotal + deliveryFee };
}
module.exports = { SETTING, parseConfig, loadConfig, decorate, totalFor, apply, aiText, parseShipping, loadShipping, withShipping };
