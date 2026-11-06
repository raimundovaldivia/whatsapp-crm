const { normalizePhone } = require('./customer-identity');
const { todayISOChile } = require('./business-date');
const { loadOrderLedger, isPurchase, purchaseDate, summarizeDates } = require('./broadcast-purchases');

function buildFrequencyCustomers(contacts, orders, today = todayISOChile()) {
  const customers = new Map();
  const profiles = new Map();
  for (const contact of contacts) {
    const phone = normalizePhone(contact.phone);
    if (!phone) continue;
    const previous = profiles.get(phone);
    profiles.set(phone, { name: previous?.name || contact.name, optedOut: Boolean(previous?.optedOut || contact.opt_out) });
  }
  const ensure = (phone, name) => {
    const profile = profiles.get(phone);
    if (!customers.has(phone)) customers.set(phone, { phone, name: profile?.name || name || phone, optedOut: profile?.optedOut || false, purchaseCount: 0, dates: [] });
    return customers.get(phone);
  };
  for (const contact of contacts) {
    const phone = normalizePhone(contact.phone);
    if (phone && (contact.contact_type === 'customer' || contact.shopify_id)) ensure(phone, contact.name);
  }
  // The shared ledger has already reconciled Shopify and CRM representations.
  // Keep its purchase criteria consistent with the existing CRM evidence.
  for (const order of orders) {
    if (!isPurchase(order)) continue;
    // Date-only values are business dates; stored timestamps use Chile's zone.
    const date = purchaseDate(order);
    if (!date || date > today) continue;
    const phone = normalizePhone(order.phone);
    if (!phone) continue;
    const customer = ensure(phone, order.name);
    customer.purchaseCount++;
    customer.dates.push(date);
  }
  return [...customers.values()].map(({ dates, ...customer }) => ({ ...customer, ...summarizeDates(dates, today) }))
    .sort((a, b) => (a.daysUntilNext ?? Infinity) - (b.daysUntilNext ?? Infinity) || a.name.localeCompare(b.name, 'es'));
}

async function getPurchaseFrequency(pool, orgId, today = todayISOChile(), phones = null) {
  const selected = phones ? new Set(phones.map(normalizePhone)) : null;
  const [contacts, orders] = await Promise.all([
    pool.query(`SELECT phone, name, contact_type, shopify_id, opt_out FROM contacts
      WHERE organization_id = $1 ORDER BY updated_at DESC, id DESC`, [orgId]),
    loadOrderLedger(pool, orgId, phones, true),
  ]);
  return { success: true, asOf: today, customers: buildFrequencyCustomers(contacts.rows, orders, today)
    .filter(customer => !selected || selected.has(customer.phone)) };
}

module.exports = { summarizeDates, buildFrequencyCustomers, getPurchaseFrequency };
