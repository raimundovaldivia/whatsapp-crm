const { normalizePhone, phoneVariants } = require('./customer-identity');
const { loadPurchases } = require('./broadcast-purchases');

const AD_ID = '120251921295630010';
const PREVIOUS_AD_ID = '120251917404930010';
const PREVIOUS_REEL_ID = '120251480763710010';
const PROMO_SWITCH_AT = '2026-11-07T19:42:15Z';
const PRICES = new Map([
  ['DR-EGG-BOX-XL-180', 45000],
  ['DR-EGG-BOX-JUMBO-100', 27000],
  ['DR-EGG-V2-XL-30-MIXTO', { boxSku: 'DR-EGG-BOX-XL-180', totals: [9900, 17900, 24900, 31900, 38900, 45000] }],
  ['DR-EGG-V2-JUMBO-20-MIXTO', { boxSku: 'DR-EGG-BOX-JUMBO-100', totals: [7900, 13900, 18900, 23400, 27000] }],
]);
const money = amount => '$' + amount.toLocaleString('es-CL');

function offerLine(product) {
  const price = PRICES.get(product.sku);
  if (!price.totals) return product.title + ' por ' + money(price);
  const totals = price.totals;
  const choices = totals.map((total, i) => (i + 1) + ' por ' + money(total));
  const extra = totals.at(-1) / totals.length;
  return product.title + ' (totales por cantidad)\n' + choices.join(' · ') +
    '\nDesde ' + totals.length + ' bandejas, ' + money(extra) + ' por bandeja. Si llevas la caja completa del mismo calibre, cada bandeja mixta adicional cuesta ' + money(extra) + '.';
}

async function resolve({ pool, orgId, isDiezRios, phone, destination, ad, inbound, draft, products, allowEnrollment = true }) {
  const normalized = normalizePhone(phone);
  if (!isDiezRios || !/^569\d{8}$/.test(normalized || '')) return null;
  const {rows: [member]} = await pool.query(
    'SELECT entry_message_id FROM box_ad_customers WHERE organization_id=$1 AND phone=$2 AND ad_id=ANY($3::text[]) ORDER BY ad_id LIMIT 1',
    [orgId, normalized, [AD_ID, PREVIOUS_AD_ID, PREVIOUS_REEL_ID]]);
  const matchingAd = ad?.ad_id === AD_ID && new Date(ad.first_seen_at) >= new Date(PROMO_SWITCH_AT) &&
    ad.source_type !== 'manual_recovery' && ad.message_id != null &&
    ad.provider === 'evolution' && normalizePhone(destination) === '56942876413';
  const fresh = Boolean(matchingAd && inbound?.id != null && String(inbound.id) === String(ad.message_id));
  let entryMessageId = member?.entry_message_id;
  if (!entryMessageId) {
    if (!allowEnrollment) return null;
    const currentEntry = matchingAd && (fresh || draft?.box_ad_message_id === String(ad.message_id)) ? ad : null;
    // Recover earlier entries even when a different ad was clicked later.
    const {rows} = await pool.query(`SELECT a.ad_id, a.message_id, a.first_seen_at
        FROM whatsapp_attributions a
        JOIN conversations c ON c.id=a.conversation_id AND c.organization_id=a.organization_id
        JOIN whatsapp_channels w ON w.id=c.whatsapp_channel_id AND w.organization_id=c.organization_id
        WHERE a.organization_id=$1 AND a.provider='evolution' AND a.message_id IS NOT NULL
          AND ((a.ad_id=$2 AND a.first_seen_at >= $5::timestamptz)
            OR (a.ad_id=$6 AND a.first_seen_at < $5::timestamptz))
          AND a.source_type IS DISTINCT FROM 'manual_recovery'
          AND w.phone_number=ANY($3::text[]) AND c.phone_number=ANY($4::text[])
        ORDER BY a.first_seen_at, a.id LIMIT 1`,
        [orgId, AD_ID, phoneVariants('56942876413'), phoneVariants(normalized), PROMO_SWITCH_AT, PREVIOUS_AD_ID]);
    const entry = rows[0] || currentEntry;
    if (!entry?.message_id) return null;
    const purchases = await loadPurchases(pool, orgId, [normalized]);
    if (purchases.some(order => !entry.first_seen_at || new Date(order.date) <= new Date(entry.first_seen_at))) return null;
    entryMessageId = String(entry.message_id);
    await pool.query(`INSERT INTO box_ad_customers (organization_id,phone,ad_id,entry_message_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,phone,ad_id) DO NOTHING`, [orgId, normalized, entry.ad_id, entryMessageId]);
  }
  const offers = products.filter(p => PRICES.has(p.sku) && p.active !== false &&
    (p.inventoryQuantity == null || p.inventoryQuantity > 0));
  const specialPrices = Object.fromEntries(offers.map(product => {
    const rule = PRICES.get(product.sku);
    if (!rule.totals) return [product.id, rule];
    const box = offers.find(p => p.sku === rule.boxSku);
    return [product.id, { totals: rule.totals, boxProductId: box?.id }];
  }));
  return {
    messageId: entryMessageId, fresh, offers, specialPrices,
    products: products.map(product => {
      const rule = PRICES.get(product.sku);
      if (!rule) return product;
      const price = rule.totals?.[0] ?? rule;
      return { ...product, price, priceMin: price, priceMax: price, description: '',
        compare_price: null, bulk_price: null, quantity_prices: [] };
    }),
    reply: offers.length ? 'Estos son tus precios de cliente para huevos de gallinas libres:\n\n' +
      offers.map(offerLine).join('\n\n') +
      '\n\n¿Qué formato y cantidad necesitas?' : 'En este momento no hay formatos disponibles para esta promoción.',
  };
}

function concernsBoxes(message, draft, offer) {
  if (draft?.box_ad_message_id || /\b(?:cajas?|mixt[oa]s?|180|100|promo(?:ci[oó]n)?)\b/iu.test(message)) return true;
  return (draft?.items || []).some(item => offer.specialPrices[item.product_id] != null ||
    offer.offers.some(product => product.title === (item.product_name || item.name)));
}

module.exports = { AD_ID, PREVIOUS_AD_ID, resolve, concernsBoxes };
