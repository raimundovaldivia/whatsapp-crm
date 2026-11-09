const { normalizePhone, phoneVariants } = require('./customer-identity');
const { loadPurchases } = require('./broadcast-purchases');

const AD_ID = '120251921295630010';
const PREVIOUS_AD_ID = '120251917404930010';
const PREVIOUS_REEL_ID = '120251480763710010';
const KAPSO_EGG_AD = '120251607371080010';
const PROMO_SWITCH_AT = '2026-11-07T19:42:15Z';
const PRICES = new Map([
  ['DR-EGG-BOX-XL-180', 45000],
  ['DR-EGG-BOX-JUMBO-100', 27000],
  ['DR-EGG-V2-XL-30-MIXTO', { boxSku: 'DR-EGG-BOX-XL-180', totals: [9900, 17900, 24900, 31900, 38900, 45000] }],
  ['DR-EGG-V2-JUMBO-20-MIXTO', { boxSku: 'DR-EGG-BOX-JUMBO-100', totals: [7900, 13900, 18900, 23400, 27000] }],
]);
const money = amount => '$' + amount.toLocaleString('es-CL');

function offerLine(product, prices) {
  const price = prices.get(product.sku);
  if (!price.totals) return product.title + ' por ' + money(price);
  const totals = price.totals;
  const choices = totals.map((total, i) => (i + 1) + ' por ' + money(total));
  const extra = totals.at(-1) / totals.length;
  return product.title + ' (totales por cantidad)\n' + choices.join(' · ') +
    '\nDesde ' + totals.length + ' bandejas, ' + money(extra) + ' por bandeja. Si llevas la caja completa del mismo calibre, cada bandeja mixta adicional cuesta ' + money(extra) + '.';
}

async function resolve({ pool, orgId, isDiezRios, phone, destination, ad, inbound, draft, products, businessDate, allowEnrollment = true }) {
  const normalized = normalizePhone(phone);
  if (!isDiezRios || !/^[+\d ().-]+$/.test(phone || '') || !/^[1-9]\d{7,14}$/.test(normalized || '')) return null;
  const {rows: [member]} = await pool.query(
    'SELECT entry_message_id FROM box_ad_customers WHERE organization_id=$1 AND phone=$2 AND ad_id=ANY($3::text[]) ORDER BY ad_id LIMIT 1',
    [orgId, normalized, [AD_ID, PREVIOUS_AD_ID, PREVIOUS_REEL_ID, KAPSO_EGG_AD]]);
  const kapsoAd = ad?.ad_id === KAPSO_EGG_AD && ad.provider === 'kapso';
  const directAd = ad?.ad_id === AD_ID && ad.provider === 'evolution' &&
    new Date(ad.first_seen_at) >= new Date(PROMO_SWITCH_AT) && normalizePhone(destination) === '56942876413';
  const matchingAd = (kapsoAd || directAd) && ad.source_type !== 'manual_recovery' && ad.message_id != null;
  const fresh = Boolean(matchingAd && inbound?.id != null && String(inbound.id) === String(ad.message_id));
  let entryMessageId = member?.entry_message_id;
  // A delivered follow-up can be answered on a different sales line than the original ad.
  let trial = null;
  if (businessDate === '2026-11-09' && allowEnrollment) {
    const {rows} = await pool.query(`SELECT r.whatsapp_message_id FROM broadcast_campaign_recipients r
      JOIN broadcast_campaigns b ON b.organization_id=r.organization_id AND b.id=r.campaign_id
      WHERE r.organization_id=$1 AND r.destination_phone=ANY($2::text[]) AND b.template_name=$3
      AND r.result_status='accepted' AND r.whatsapp_message_id IS NOT NULL LIMIT 1`,
      [orgId, phoneVariants(normalized), 'prueba-huevos-xl-20261109']);
    trial = rows[0]?.whatsapp_message_id;
  }
  if (!entryMessageId && !trial) {
    if (!allowEnrollment) return null;
    const currentEntry = matchingAd && (fresh || kapsoAd || draft?.box_ad_message_id === String(ad.message_id)) ? ad : null;
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
  const prices = new Map(PRICES);
  if (trial) {
    entryMessageId ||= trial;
    const sku = 'DR-EGG-V2-XL-30-MIXTO';
    const standard = prices.get(sku);
    prices.set(sku, { ...standard, totals: [9000, 15000, ...standard.totals.slice(2)] });
  }
  const offers = products.filter(p => prices.has(p.sku) && p.active !== false &&
    (p.inventoryQuantity == null || p.inventoryQuantity > 0));
  const specialPrices = Object.fromEntries(offers.map(product => {
    const rule = prices.get(product.sku);
    if (!rule.totals) return [product.id, rule];
    const box = offers.find(p => p.sku === rule.boxSku);
    return [product.id, { totals: rule.totals, boxProductId: box?.id }];
  }));
  return {
    messageId: entryMessageId, fresh, offers, specialPrices,
    products: products.map(product => {
      const rule = prices.get(product.sku);
      if (!rule) return product;
      const price = rule.totals?.[0] ?? rule;
      return { ...product, price, priceMin: price, priceMax: price, description: '',
        compare_price: null, bulk_price: null, quantity_prices: [] };
    }),
    reply: offers.length ? 'Estos son tus precios de cliente para huevos de gallinas libres:\n\n' +
      offers.map(p => offerLine(p, prices)).join('\n\n') +
      '\n\n¿Qué formato y cantidad necesitas?' : 'En este momento no hay formatos disponibles para esta promoción.',
  };
}

// Keep checkout, mixed product questions and delivery questions in their own flows.
function directPriceReply(message, offer) {
  if (!offer) return null;
  const text = String(message || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (!/\b(?:precios?|valor(?:es)?|cuant[oa]s?|cuest\w*|a como|a cuanto|cotiz\w*)\b/.test(text) ||
      /\b(?:ques\w*|aceitunas?|leche|despacho|envio|mayor|factura|primera|blanc\w*|cafe\w*|pedido|confirm\w*|manana|l|m)\b/.test(text)) return null;
  const box = /\b(?:cajas?|100|180)\b/.test(text);
  const tray = /\b(?:bandejas?|20|30|60)\b/.test(text);
  const xl = /\b(?:xl|extras?|180|30|60)\b/.test(text);
  const jumbo = /\b(?:jumbo|100|20)\b/.test(text);
  // Specific multi-pack quantities go through the existing quantity calculator.
  if (/\b(?:[3-9]|\d{2,}|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:bandejas?|cajas?)\b/.test(text)) return null;
  const lines = offer.offers.flatMap(p => {
    const isBox = p.sku.includes('-BOX-');
    const isXL = p.sku.includes('-XL-');
    if ((box !== tray && isBox !== box) || (xl !== jumbo && isXL !== xl)) return [];
    const units = isBox ? (isXL ? 180 : 100) : (isXL ? 30 : 20);
    const kind = isXL ? 'XL' : 'Jumbo';
    const price = offer.specialPrices[p.id];
    if (isBox && /\b(?:dos|2)\s+cajas?\b/.test(text)) return [`Dos cajas de ${units} huevos ${kind} cada una (${2*units} huevos): ${money(price*2)} en total.`];
    if (isBox) return [`Caja de ${units} huevos ${kind}: ${money(price)}.`];
    return [`Bandeja de ${units} huevos ${kind} mixtos: ${money(price.totals[0])}. Dos bandejas (${units*2} huevos): ${money(price.totals[1])} en total.`];
  });
  return lines.length ? lines.join('\n') : null;
}

function concernsBoxes(message, draft, offer) {
  if (draft?.box_ad_message_id || /\b(?:cajas?|mixt[oa]s?|180|100|promo(?:ci[oó]n)?)\b/iu.test(message)) return true;
  return (draft?.items || []).some(item => offer.specialPrices[item.product_id] != null ||
    offer.offers.some(product => product.title === (item.product_name || item.name)));
}

module.exports = { AD_ID, PREVIOUS_AD_ID, KAPSO_EGG_AD, resolve, concernsBoxes, directPriceReply };
