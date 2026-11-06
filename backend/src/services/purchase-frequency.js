const { normalizePhone } = require('./customer-identity');
const { todayISOChile, isValidISODate, addDays } = require('./business-date');
const { loadOrderLedger, isPurchase } = require('./broadcast-purchases');

const DAY = 86400000;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor(sorted.length / 2)] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
};
const daysBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / DAY;

function summarizeDates(dates, today) {
  const distinct = [...new Set(dates)].filter(date => isValidISODate(date) && date <= today).sort();
  const recent = distinct.slice(-12);
  const gaps = recent.slice(1).map((date, index) => daysBetween(date, recent[index]));
  const intervalDays = gaps.length ? Math.round(median(gaps) * 10) / 10 : null;
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
    const date = typeof order.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(order.date)
      ? (isValidISODate(order.date) ? order.date : null) : todayISOChile(new Date(order.date));
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

async function getPurchaseFrequency(pool, orgId, today = todayISOChile()) {
  const [contacts, orders] = await Promise.all([
    pool.query(`SELECT phone, name, contact_type, shopify_id, opt_out FROM contacts
      WHERE organization_id = $1 ORDER BY updated_at DESC, id DESC`, [orgId]),
    loadOrderLedger(pool, orgId, null, true),
  ]);
  return { success: true, asOf: today, customers: buildFrequencyCustomers(contacts.rows, orders, today) };
}

module.exports = { summarizeDates, buildFrequencyCustomers, getPurchaseFrequency };
