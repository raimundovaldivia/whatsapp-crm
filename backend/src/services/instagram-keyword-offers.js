'use strict';

const { flattenCatalog, fmt } = require('./order-pricing');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const SETTING = 'instagram_keyword_offers';
const DIEZ_RIOS = 'diez-rios-mrs96z69';
const TEMPLATE = 'oferta_por_palabra_instagram';

function catalogOptions(products) {
  return flattenCatalog(products.filter(p => p.active !== false && !p.is_business))
    .filter(p => p.product_id != null)
    .map(p => ({ key: p.key, title: p.title, productId: p.product_id, variantId: p.variant_id }));
}

function configuredRules(raw, isDiezRios, products) {
  if (raw != null) return JSON.parse(raw);
  if (!isDiezRios) return [];
  const prices = new Map([
    ['DR-EGG-V2-XL-30-BLANCO', 8000], ['DR-EGG-V2-XL-30-MIXTO', 8000],
    ['DR-EGG-V2-XL-30-CAFE', 8000], ['DR-QUESO-FRESCO-700', 10000],
  ]);
  const items = products.filter(p => prices.has(p.sku)).map(p => ({ key: String(p.id), price: prices.get(p.sku) }));
  return items.length ? [{ keyword: 'OFERTA', enabled: true, items }] : [];
}

function validateRules(rules, options) {
  if (!Array.isArray(rules) || rules.length > 100) throw new Error('Guarda hasta 100 palabras por tienda.');
  const allowed = new Map(options.map(item => [item.key, item]));
  const used = new Set();
  return rules.map(rule => {
    const keyword = typeof rule?.keyword === 'string' ? rule.keyword.trim() : '';
    const normalized = normalize(keyword);
    if (!normalized || keyword.length > 60 || !/\p{L}/u.test(normalized)) throw new Error('Escribe una palabra o frase de hasta 60 caracteres.');
    if (used.has(normalized)) throw new Error('Cada palabra debe identificar una sola oferta.');
    used.add(normalized);
    if (typeof rule.enabled !== 'boolean' || !Array.isArray(rule.items) || !rule.items.length) throw new Error('Selecciona los productos de cada oferta.');
    const keys = new Set();
    const items = rule.items.map(item => {
      const key = item?.key;
      if (!allowed.has(key) || keys.has(key)) throw new Error('Selecciona productos vigentes y distintos para cada oferta.');
      keys.add(key);
      if (!Number.isSafeInteger(item.price) || item.price <= 0 || item.price > 2147483647) throw new Error('Ingresa un precio unitario válido en pesos.');
      return { key, price: item.price };
    });
    const clean = { keyword, enabled: rule.enabled, items };
    const promotion = context(clean, options);
    if (reply(promotion).length > 1000) throw new Error('La oferta supera el largo de un mensaje de Instagram. Reduce la cantidad de productos.');
    return clean;
  });
}

function context(rule, options) {
  const offers = [];
  for (const item of rule.items) {
    const product = options.find(option => option.key === item.key);
    if (product) offers.push({ ...product, label: product.title, price: item.price });
  }
  return { templateName: TEMPLATE, keyword: rule.keyword, active: true, offers,
    specialPrices: Object.fromEntries(offers.map(o => [o.key, o.price])) };
}

function reply(promotion, salesOpen = true) {
  if (!promotion.offers.length) return 'Esa oferta ya no tiene productos disponibles. ¿Te ayudo a buscar otra opción?';
  const lines = promotion.offers.map(o => '• ' + o.label + ' a ' + fmt(o.price));
  const closing = salesOpen ? '¿Qué te gustaría llevar y cuántas unidades?' : 'Por ahora las ventas están pausadas.';
  return '¡Hola! Estos son los precios de la oferta:\n\n' + lines.join('\n') + '\n\n' + closing;
}

// Only parse a complete, unambiguous quantity request. Mixed order edits,
// questions and delivery details continue through normal order extraction.
function selection(message, promotion) {
  if (promotion?.templateName !== TEMPLATE || !promotion.active || /[?¿]/u.test(message)) return null;
  const quantities = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
  const text = normalize(message).replace(/^(?:quiero|quisiera|dame|necesito) /, '').replace(/ (?:por favor|porfa)$/, '');
  const match = /^(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) (.+)$/.exec(text);
  if (!match) return null;
  const quantity = quantities[match[1]] || Number(match[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
  const tokens = value => normalize(value).split(' ').filter(t => !['de','la','el','los','las'].includes(t)).map(t => t.replace(/s$/, ''));
  const query = tokens(match[2]);
  if (!query.length) return null;
  const choices = promotion.offers.filter(o => query.every(t => tokens(o.title).includes(t)));
  return choices.length ? { choices, quantity } : null;
}

function choiceForTurn(message, promotion, pending) {
  const choice = selection(message, promotion);
  if (choice || !Array.isArray(pending?.keys)) return choice;
  return selection(pending.quantity + ' ' + message, {
    ...promotion, offers: promotion.offers.filter(o => pending.keys.includes(o.key)),
  });
}

module.exports = { SETTING, DIEZ_RIOS, TEMPLATE, normalize, catalogOptions, configuredRules, validateRules, context, reply, choiceForTurn };
