'use strict';

const { createHash } = require('node:crypto');
const { getOrderProductCatalog } = require('./order-product-catalog');
const quantityPricing = require('./quantity-pricing');
const xlPricing = require('./xl-welcome-pricing');

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}
const present = value => value !== undefined && value !== null && value !== '';
function number(value, label, { integer = true, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') invalid(label);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isSafeInteger(n))) invalid(label);
  return n;
}
function reduction(base, value, type = 'percent') {
  if (!present(value)) return 0;
  if (!['percent', 'fixed'].includes(type)) invalid('Elige un descuento en pesos o porcentaje.');
  const pct = type === 'percent';
  const n = number(value, pct ? 'El porcentaje debe estar entre 0 y 100.' : 'El descuento en pesos supera el importe disponible.', { integer: !pct, max: pct ? 100 : base });
  return pct ? Math.round(base * n / 100) : n;
}

function calculate(input, catalog, context) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) invalid('Agrega entre 1 y 100 líneas de productos.');
  const groups = new Map();
  const lines = input.items.map(item => {
    const qty = number(item?.quantity, 'Ingresa una cantidad entre 1 y 1000.', { max: 1000 });
    if (!qty) invalid('La cantidad debe ser mayor que cero.');
    const p = present(item.productId) ? catalog.find(p => String(p.id) === String(item.productId)) : null;
    if (present(item.productId) && !p) invalid('Un producto ya no está disponible para este cliente. Revisa el pedido.');
    const title = p?.title || (typeof item.name === 'string' && item.name.trim());
    if (!title || title.length > 300) invalid('Completa el nombre de cada producto.');
    const override = present(item.unitPrice);
    const price = number(override ? item.unitPrice : p?.price, 'Ingresa un precio válido en pesos.');
    const base = number(price * qty, 'El importe de la línea es demasiado alto.');
    const line = { name: title, title, quantity: qty, base_total: base, volume_total: base, discount_type: item.discountType || 'percent', discount_value: item.discount || 0 };
    if (p) {
      line.product_id = p.id;
      line.productId = p.id;
      if (!override && !p.is_business && !p.special_price) {
        let group = groups.get(p.id);
        if (!group) {
          group = { id: p.id, title, price, quantity: 0, lines: [] };
          groups.set(p.id, group);
        }
        group.quantity += qty;
        if (group.quantity > 1000) invalid('El máximo por producto es 1000 unidades.');
        group.lines.push(line);
      }
    }
    return line;
  });
  const priced = quantityPricing.storePrices([...groups.values()].map(({ lines, ...item }) => item), catalog, context);
  for (const product of priced) {
    const group = groups.get(product.id);
    let qty = 0, assigned = 0;
    for (const line of group.lines) {
      qty += line.quantity;
      const running = Math.round(product.price * qty);
      line.volume_total = running - assigned;
      assigned = running;
    }
  }
  let subtotal = 0, baseTotal = 0, volumeSaving = 0, lineSaving = 0;
  for (const line of lines) {
    line.item_discount = reduction(line.volume_total, line.discount_value, line.discount_type);
    line.before_order_discount = line.volume_total - line.item_discount;
    subtotal += line.before_order_discount;
    baseTotal += line.base_total;
    volumeSaving += line.base_total - line.volume_total;
    lineSaving += line.item_discount;
  }
  number(baseTotal, 'El total de los productos es demasiado alto.');
  const total = present(input.manualTotal) ? number(input.manualTotal, 'Ingresa un total válido en pesos.')
    : subtotal - reduction(subtotal, input.discount, input.discountType);
  // Allocate the order adjustment in whole pesos. Legacy consumers multiply price by quantity.
  const weightTotal = subtotal || lines.reduce((sum, line) => sum + line.quantity, 0);
  let weight = 0, assigned = 0;
  for (const line of lines) {
    weight += subtotal ? line.before_order_discount : line.quantity;
    const running = weight === weightTotal ? total : Math.round(total * (weight / weightTotal));
    line.line_total = running - assigned;
    line.order_adjustment = line.line_total - line.before_order_discount;
    line.price = line.line_total / line.quantity;
    assigned = running;
  }
  const quote = { items: lines, baseTotal, volumeSaving, lineSaving, subtotal, orderAdjustment: total - subtotal, total, saving: baseTotal - total };
  quote.signature = createHash('sha256').update(JSON.stringify(quote)).digest('hex');
  return quote;
}
async function quoteOrder(db, orgId, phone, input) {
  const pool = db.getPool();
  const [catalog, config, context] = await Promise.all([
    getOrderProductCatalog(pool, orgId, phone),
    quantityPricing.loadConfig(db, orgId),
    xlPricing.context(pool, orgId, phone),
  ]);
  return calculate(input, quantityPricing.decorate(catalog, config), context);
}
function verify(quote, signature) {
  if (quote.signature !== signature) throw Object.assign(new Error('Los precios cambiaron. Revisa el total actualizado antes de crear el pedido.'), { status: 409 });
}
const money = n => '$' + n.toLocaleString('es-CL');
function summary(quote) {
  const lines = quote.items.map(i => {
    const savings = [];
    if (i.base_total > i.volume_total) savings.push('por cantidad −' + money(i.base_total - i.volume_total));
    if (i.item_discount) savings.push('descuento del producto −' + money(i.item_discount));
    return '• ' + i.title + ' ×' + i.quantity + ' — ' + money(i.before_order_discount) + (savings.length ? ' (' + savings.join(', ') + ')' : '');
  });
  if (quote.orderAdjustment < 0) lines.push('Descuento adicional: −' + money(-quote.orderAdjustment));
  if (quote.orderAdjustment > 0) lines.push('Ajuste adicional: +' + money(quote.orderAdjustment));
  if (quote.saving > 0) {
    const percent = (100 * quote.saving / quote.baseTotal).toLocaleString('es-CL', { maximumFractionDigits: 2 });
    lines.push('Ahorro total: ' + money(quote.saving) + ' (' + percent + '%)');
  }
  lines.push('Total: ' + money(quote.total));
  return lines.join('\n');
}

module.exports = { calculate, quoteOrder, verify, summary };
