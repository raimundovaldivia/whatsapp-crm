const { normalizePhone, phoneVariants } = require('./customer-identity');
const { loadPurchases } = require('./broadcast-purchases');

const AD_ID = '120251917404930010';
const PRICES = new Map([['DR-EGG-BOX-XL-180', 45000], ['DR-EGG-BOX-JUMBO-100', 27000]]);

async function resolve({ pool, orgId, isDiezRios, phone, destination, ad, inbound, draft, products, allowEnrollment = true }) {
  const normalized = normalizePhone(phone);
  if (!isDiezRios || !/^569\d{8}$/.test(normalized || '')) return null;
  const key = [orgId, normalized, AD_ID];
  const {rows: [member]} = await pool.query(
    'SELECT entry_message_id FROM box_ad_customers WHERE organization_id=$1 AND phone=$2 AND ad_id=$3', key);
  const matchingAd = ad?.ad_id === AD_ID && ad.source_type !== 'manual_recovery' && ad.message_id != null &&
    ad.provider === 'evolution' && normalizePhone(destination) === '56942876413';
  const fresh = Boolean(matchingAd && inbound?.id != null && String(inbound.id) === String(ad.message_id));
  let entryMessageId = member?.entry_message_id;
  if (!entryMessageId) {
    if (!allowEnrollment) return null;
    const currentEntry = matchingAd && (fresh || draft?.box_ad_message_id === String(ad.message_id)) ? ad : null;
    // Recover earlier entries even when a different ad was clicked later.
    const {rows} = await pool.query(`SELECT a.message_id, a.first_seen_at
        FROM whatsapp_attributions a
        JOIN conversations c ON c.id=a.conversation_id AND c.organization_id=a.organization_id
        JOIN whatsapp_channels w ON w.id=c.whatsapp_channel_id AND w.organization_id=c.organization_id
        WHERE a.organization_id=$1 AND a.ad_id=$2 AND a.provider='evolution' AND a.message_id IS NOT NULL
          AND a.source_type IS DISTINCT FROM 'manual_recovery'
          AND w.phone_number=ANY($3::text[]) AND c.phone_number=ANY($4::text[])
        ORDER BY a.first_seen_at, a.id LIMIT 1`,
        [orgId, AD_ID, phoneVariants('56942876413'), phoneVariants(normalized)]);
    const entry = rows[0] || currentEntry;
    if (!entry?.message_id) return null;
    const purchases = await loadPurchases(pool, orgId, [normalized]);
    if (purchases.some(order => !entry.first_seen_at || new Date(order.date) <= new Date(entry.first_seen_at))) return null;
    entryMessageId = String(entry.message_id);
    await pool.query(`INSERT INTO box_ad_customers (organization_id,phone,ad_id,entry_message_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,phone,ad_id) DO NOTHING`, [...key, entryMessageId]);
  }
  const offers = products.filter(p => PRICES.has(p.sku) && p.active !== false &&
    (p.inventoryQuantity == null || p.inventoryQuantity > 0));
  const specialPrices = Object.fromEntries(offers.map(p => [p.id, PRICES.get(p.sku)]));
  return {
    messageId: entryMessageId, fresh, offers, specialPrices,
    products: products.map(p => PRICES.has(p.sku) ? ({
      ...p, price: PRICES.get(p.sku), priceMin: PRICES.get(p.sku), priceMax: PRICES.get(p.sku), description: '',
      compare_price: null, bulk_price: null, quantity_prices: [],
    }) : p),
    reply: offers.length ? 'Estos son tus precios de cliente para las cajas de huevos de gallinas libres:\n' +
      offers.map(p => p.title + ' por $' + PRICES.get(p.sku).toLocaleString('es-CL')).join('\n') +
      '\n¿Qué caja quieres y cuántas necesitas?' : 'En este momento no hay cajas disponibles para esta promoción.',
  };
}

function concernsBoxes(message, draft, offer) {
  if (draft?.box_ad_message_id || /\b(?:cajas?|180|100|promo(?:ci[oó]n)?)\b/iu.test(message)) return true;
  return (draft?.items || []).some(item => offer.specialPrices[item.product_id] != null ||
    offer.offers.some(product => product.title === (item.product_name || item.name)));
}

module.exports = { AD_ID, resolve, concernsBoxes };
