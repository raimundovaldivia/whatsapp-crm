const { normalizePhone } = require('./customer-identity');
const { loadPurchases } = require('./broadcast-purchases');

const AD_ID = '120251917404930010';
const PRICES = new Map([['DR-EGG-BOX-XL-180', 45000], ['DR-EGG-BOX-JUMBO-100', 27000]]);

async function resolve({ pool, orgId, isDiezRios, phone, destination, ad, inbound, draft, products }) {
  if (!isDiezRios || ad?.ad_id !== AD_ID || !ad.message_id ||
      ad.provider !== 'evolution' || normalizePhone(destination) !== '56942876413') return null;
  const fresh = inbound?.id != null && String(inbound.id) === String(ad.message_id);
  if (!fresh && draft?.box_ad_message_id !== String(ad.message_id)) return null;
  const normalized = normalizePhone(phone);
  if (!/^569\d{8}$/.test(normalized || '')) return null;
  const purchases = await loadPurchases(pool, orgId, [normalized]);
  if (purchases.length) return null;
  const offers = products.filter(p => PRICES.has(p.sku) && p.active !== false &&
    (p.inventoryQuantity == null || p.inventoryQuantity > 0));
  const specialPrices = Object.fromEntries(offers.map(p => [p.id, PRICES.get(p.sku)]));
  return {
    messageId: String(ad.message_id), fresh, offers, specialPrices,
    products: offers.map(p => ({
      ...p, priceMin: PRICES.get(p.sku), priceMax: PRICES.get(p.sku), description: '',
      compare_price: null, bulk_price: null, quantity_prices: [],
    })),
    reply: offers.length ? 'Tenemos estas cajas de huevos de gallinas libres para tu primera compra:\n' +
      offers.map(p => p.title + ' por $' + PRICES.get(p.sku).toLocaleString('es-CL')).join('\n') +
      '\n¿Qué caja quieres y cuántas necesitas?' : 'En este momento no hay cajas disponibles para esta promoción.',
  };
}

module.exports = { AD_ID, resolve };
