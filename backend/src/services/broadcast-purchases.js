// One purchase ledger for audience selection and AI evidence. Profile edits are
// never purchases; linked Shopify/CRM representations count only once.
const { normalizePhone, buildCustomerIdentityMap } = require('./customer-identity');
const { todayISOChile, isValidISODate, addDays } = require('./business-date');

const { importedShopifyClosed } = require('./shopify-dispatch-state');

function purchaseDate(order) {
  return typeof order.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(order.date)
    ? (isValidISODate(order.date) ? order.date : null) : todayISOChile(new Date(order.date));
}

// Shared by the customer list and the evidence used to write follow-ups.
function summarizeDates(dates, today) {
  const distinct = [...new Set(dates)].filter(date => isValidISODate(date) && date <= today).sort();
  const recent = distinct.slice(-12);
  const daysBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
  const gaps = recent.slice(1).map((date, index) => daysBetween(date, recent[index]));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = gaps.length ? (sorted[Math.floor(sorted.length / 2)] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
  const intervalDays = median == null ? null : Math.round(median * 10) / 10;
  const lastPurchase = distinct.at(-1) || null;
  const nextPurchase = intervalDays == null ? null : addDays(lastPurchase, Math.round(intervalDays));
  const daysUntilNext = nextPurchase ? daysBetween(nextPurchase, today) : null;
  const mean = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0;
  const variation = mean ? Math.sqrt(gaps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gaps.length) / mean : 0;
  return {
    purchaseDays: distinct.length, sampleDays: recent.length, lastPurchase,
    daysSincePurchase: lastPurchase ? daysBetween(today, lastPurchase) : null,
    intervalDays, nextPurchase, daysUntilNext,
    regularity: gaps.length < 2 ? 'insufficient' : variation > 0.5 ? 'variable' : 'regular',
    cadence: intervalDays == null ? 'unknown' : intervalDays <= 10 ? 'weekly' : intervalDays <= 20 ? 'fortnightly' : intervalDays <= 40 ? 'monthly' : 'occasional',
    status: daysUntilNext == null ? 'insufficient' : daysUntilNext < 0 ? 'overdue' : daysUntilNext <= 3 ? 'due' : 'upcoming',
    recentDates: recent.slice().reverse(),
  };
}

function isPurchase(order) {
  return ['PAID', 'PARTIALLY_PAID', 'ENTREGADO', 'DELIVERED', 'FULFILLED', 'COMPLETED']
    .includes(String(order.status || '').toUpperCase()) && Boolean(order.date) && Number.isFinite(new Date(order.date).getTime());
}

async function loadOrderLedger(pool, orgId, phones = null, includeDetails = false) {
  const normalized = phones ? [...new Set(phones.map(normalizePhone).filter(Boolean))] : null;
  const phoneSql = column => `CASE WHEN regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') ~ '^9[0-9]{8}$'
    THEN '56' || regexp_replace(${column}, '[^0-9]', '', 'g')
    ELSE regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') END`;
  const [shopify, local] = await Promise.all([
    pool.query(`SELECT shopify_order_id AS id, customer_phone AS phone, shopify_created_at AT TIME ZONE 'UTC' AS date, items,
        ${includeDetails ? `customer_name AS name, total_price AS total, crm_status AS dispatch,
          delivery_date::text AS delivery_day, delivered_at, financial_status AS payment,
          fulfillment_status AS fulfillment,
          (delivered_at IS NULL AND NOT ${importedShopifyClosed}
            AND COALESCE(crm_status, 'nuevo') NOT IN ('entregado','cancelled','draft','failed')
            AND UPPER(COALESCE(financial_status, '')) NOT IN ('REFUNDED','VOIDED')
            AND UPPER(COALESCE(fulfillment_status, '')) <> 'RESTOCKED'
            AND COALESCE(NULLIF(raw_json->>'cancelledAt', ''), NULLIF(raw_json->>'cancelled_at', '')) IS NULL
          ) AS pending_dispatch,` : ''}
        CASE WHEN LOWER(COALESCE(crm_status, '')) = 'cancelled' THEN 'CANCELLED'
          WHEN LOWER(COALESCE(financial_status, '')) IN ('refunded','voided') THEN financial_status
          WHEN delivered_at IS NOT NULL OR LOWER(COALESCE(fulfillment_status, '')) = 'fulfilled'
            THEN 'DELIVERED' ELSE financial_status END AS status
      FROM shopify_orders WHERE organization_id = $1 AND shopify_created_at IS NOT NULL
        AND ($2::text[] IS NULL OR ${phoneSql('customer_phone')} = ANY($2::text[]))`, [orgId, normalized]),
    pool.query(`SELECT o.id, o.shopify_order_id, COALESCE(NULLIF(o.customer_phone, ''), c.phone_number) AS phone,
        o.created_at AT TIME ZONE 'UTC' AS date, o.items, o.status
        ${includeDetails ? `, o.customer_name AS name, o.total_price AS total, o.status AS dispatch,
          o.delivery_date::text AS delivery_day, o.delivered_at, o.payment_marked_at,
          (o.delivered_at IS NULL AND (
            o.status IN ('nuevo','sent','payment_received','por_despachar','asignado_ruta','en_camino','no_entregado')
            OR (o.status = 'paid' AND o.delivery_date IS NOT NULL)
          )) AS pending_dispatch` : ''}
      FROM orders o LEFT JOIN conversations c ON c.id = o.conversation_id AND c.organization_id = o.organization_id
      WHERE o.organization_id = $1 AND o.created_at IS NOT NULL
        AND ($2::text[] IS NULL OR ${phoneSql("COALESCE(NULLIF(o.customer_phone, ''), c.phone_number)")} = ANY($2::text[]))`, [orgId, normalized]),
  ]);
  const records = new Map();
  const shopifyId = id => String(id || '').split('/').at(-1);
  for (const order of shopify.rows) {
    // Reserve even refunded/cancelled Shopify IDs so a stale CRM mirror cannot
    // turn them back into a purchase or replace the original purchase date.
    records.set(`shopify:${shopifyId(order.id)}`, { ...order, phone: normalizePhone(order.phone) });
  }
  for (const order of local.rows) {
    const key = order.shopify_order_id ? `shopify:${shopifyId(order.shopify_order_id)}` : `crm:${order.id}`;
    if (!records.has(key)) records.set(key, { ...order, phone: normalizePhone(order.phone) });
  }
  return [...records.values()];
}

async function loadPurchases(pool, orgId, phones = null) {
  const ledger = await loadOrderLedger(pool, orgId, phones);
  return ledger.filter(isPurchase).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function purchaseSummary(orders, today) {
  const valid = orders.filter(order => isPurchase(order) && purchaseDate(order) && purchaseDate(order) <= today)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const frequency = summarizeDates(valid.map(purchaseDate), today);
  const itemsOf = raw => {
    let items = raw;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = null; } }
    if (!Array.isArray(items)) return { productos: [], detalleCompleto: false };
    let detalleCompleto = items.length > 0 && items.length <= 12;
    const productos = items.slice(0, 12).map(item => {
      const title = typeof item?.title === 'string' ? item.title.trim() : typeof item?.name === 'string' ? item.name.trim() : '';
      const quantity = ['string', 'number'].includes(typeof item?.quantity) ? Number(item.quantity) : NaN;
      const cantidad = Number.isFinite(quantity) && quantity > 0 ? quantity : null;
      if (!title || title.length > 180 || /[\r\n{}]/.test(title) || cantidad == null) detalleCompleto = false;
      return { producto: title.slice(0, 180), cantidad };
    });
    return { productos, detalleCompleto };
  };
  return {
    ultimaCompra: frequency.lastPurchase,
    diasDesdeCompra: frequency.daysSincePurchase,
    cantidadPedidos: valid.length,
    intervaloMedianoDias: frequency.intervalDays,
    fechasDistintas: frequency.purchaseDays,
    regularidad: frequency.regularity,
    proximaCompraEstimada: frequency.nextPurchase,
    diasHastaProximaCompra: frequency.daysUntilNext,
    estadoFrecuencia: frequency.status,
    fechasUsadas: frequency.recentDates,
    limite: 'Pedidos pagados o entregados; una sola fecha no permite inferir frecuencia. Cantidad es unidades del producto, no huevos individuales.',
    pedidos: valid.slice(0, 12).map(order => ({ fecha: purchaseDate(order), ...itemsOf(order.items), estado: String(order.status || '').slice(0, 40) })),
  };
}

function withPurchaseStats(contacts, rawContacts, orders) {
  const identities = buildCustomerIdentityMap(rawContacts);
  const grouped = new Map();
  for (const order of orders) {
    const phone = identities.get(order.phone) || order.phone;
    if (!grouped.has(phone)) grouped.set(phone, []);
    grouped.get(phone).push(order);
  }
  return contacts.map(contact => {
    const purchases = grouped.get(identities.get(contact.phone) || contact.phone) || [];
    const latest = purchases.reduce((date, o) => !date || new Date(o.date) > new Date(date) ? o.date : date, null);
    return { ...contact, total_orders: purchases.length, last_order_at: latest,
      purchase_history_source: 'orders', contact_type: purchases.length ? 'customer' : 'lead' };
  });
}

module.exports = { loadPurchases, loadOrderLedger, purchaseSummary, withPurchaseStats, isPurchase, purchaseDate, summarizeDates };
