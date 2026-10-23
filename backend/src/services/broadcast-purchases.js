// One purchase ledger for audience selection and AI evidence. Profile edits are
// never purchases; linked Shopify/CRM representations count only once.
const { normalizePhone, buildCustomerIdentityMap } = require('./customer-identity');
const { todayISOChile } = require('./business-date');

function isPurchase(order) {
  return ['PAID', 'PARTIALLY_PAID', 'ENTREGADO', 'DELIVERED', 'FULFILLED', 'COMPLETED']
    .includes(String(order.status || '').toUpperCase()) && Boolean(order.date) && Number.isFinite(new Date(order.date).getTime());
}

async function loadPurchases(pool, orgId, phones = null) {
  const normalized = phones ? [...new Set(phones.map(normalizePhone).filter(Boolean))] : null;
  const phoneSql = column => `CASE WHEN regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') ~ '^9[0-9]{8}$'
    THEN '56' || regexp_replace(${column}, '[^0-9]', '', 'g')
    ELSE regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') END`;
  const [shopify, local] = await Promise.all([
    pool.query(`SELECT shopify_order_id AS id, customer_phone AS phone, shopify_created_at AS date, items,
        CASE WHEN LOWER(COALESCE(crm_status, '')) = 'cancelled' THEN 'CANCELLED'
          WHEN LOWER(COALESCE(financial_status, '')) IN ('refunded','voided') THEN financial_status
          WHEN delivered_at IS NOT NULL OR LOWER(COALESCE(fulfillment_status, '')) = 'fulfilled'
            THEN 'DELIVERED' ELSE financial_status END AS status
      FROM shopify_orders WHERE organization_id = $1 AND shopify_created_at IS NOT NULL
        AND ($2::text[] IS NULL OR ${phoneSql('customer_phone')} = ANY($2::text[]))`, [orgId, normalized]),
    pool.query(`SELECT o.id, o.shopify_order_id, COALESCE(NULLIF(o.customer_phone, ''), c.phone_number) AS phone,
        o.created_at AS date, o.items, o.status
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
  return [...records.values()].filter(isPurchase).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function purchaseSummary(orders, today) {
  const valid = orders.filter(isPurchase);
  const dates = [...new Set(valid.map(order => todayISOChile(new Date(order.date))))].sort().reverse();
  const intervals = dates.slice(1).map((date, i) => (Date.parse(dates[i]) - Date.parse(date)) / 86400000).sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const itemsOf = raw => {
    let items = raw;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { return []; } }
    return Array.isArray(items) ? items.slice(0, 12).map(item => ({
      producto: String(item.title || item.name || '').slice(0, 180), cantidad: Number(item.quantity) || null,
    })) : [];
  };
  return {
    ultimaCompra: dates[0] || null,
    diasDesdeCompra: dates.length ? (Date.parse(today) - Date.parse(dates[0])) / 86400000 : null,
    cantidadPedidos: valid.length,
    intervaloMedianoDias: intervals.length ? (intervals[middle] + intervals[Math.floor((intervals.length - 1) / 2)]) / 2 : null,
    fechasDistintas: dates.length,
    limite: 'Pedidos pagados o entregados; una sola fecha no permite inferir frecuencia. Cantidad es unidades del producto, no huevos individuales.',
    pedidos: valid.slice(0, 12).map(order => ({ fecha: todayISOChile(new Date(order.date)), productos: itemsOf(order.items), estado: String(order.status || '').slice(0, 40) })),
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

module.exports = { loadPurchases, purchaseSummary, withPurchaseStats, isPurchase };
