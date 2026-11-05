'use strict';

const { todayISOChile, addDays, BUSINESS_TIME_ZONE } = require('./business-date');
const { normalizePhone, buildCustomerIdentityMap } = require('./customer-identity');
const { loadOrderLedger } = require('./broadcast-purchases');
const { rawName, fold } = require('./product-identity');

const STORE_SLUG = 'diez-rios-mrs96z69';
const REFRESH_MS = 15 * 60 * 1000;
const DAY = 86400000;
const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const between = (later, earlier) => (Date.parse(later) - Date.parse(earlier)) / DAY;

function eggItems(raw) {
  let items = raw;
  if (typeof raw === 'string') {
    try { items = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    if (!item || Number(item.quantity ?? 1) <= 0) return [];
    const name = typeof item === 'string' ? item : rawName(item);
    const text = fold(name);
    const matched = /\bhuevos?\b|\bpromo 60 xl\b|\b\d+ jumbo\b|\b(?:bandejas?|cajas?)\b.{0,30}\b(?:xl|l|m|s|jumbo|extra)\b/.test(text) || name.includes('🥚');
    return matched ? [name + (item.quantity > 1 ? ' ×' + item.quantity : '')] : [];
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildProfiles(ledger, contacts, scheduled, recentOutreach, day) {
  const identities = buildCustomerIdentityMap(contacts);
  const canonical = value => {
    const phone = normalizePhone(value);
    return identities.get(phone) || phone;
  };
  const customers = new Map();
  const hold = new Set(scheduled.map(r => canonical(r.phone)));
  const optOut = new Set(contacts.filter(c => c.opt_out).map(c => canonical(c.phone)));
  const recentlyContacted = new Set(recentOutreach.map(r => canonical(r.phone)));
  for (const order of ledger) {
    const phone = canonical(order.phone);
    const dispatch = String(order.dispatch || '').toLowerCase();
    const payment = String(order.payment || order.status || '').toLowerCase();
    const fulfilled = String(order.fulfillment || '').toLowerCase();
    if (!phone || !order.date || !Number.isFinite(Date.parse(order.date))) continue;
    if (['cancelled','failed'].includes(dispatch) || ['voided','refunded','cancelled'].includes(payment) || fulfilled === 'restocked') continue;
    const date = localDay.format(new Date(order.date));
    if (date > day) continue;
    const delivered = Boolean(order.delivered_at) || dispatch === 'entregado' || fulfilled === 'fulfilled';
    const paid = ['paid','payment_received'].includes(dispatch) || payment === 'paid' || Boolean(order.payment_marked_at);
    if (date === day || (!delivered && (order.delivery_day >= day ||
        ['por_despachar','asignado_ruta','en_camino'].includes(dispatch) ||
        (['draft','sent','nuevo',''].includes(dispatch) && !paid)))) hold.add(phone);
    if (dispatch === 'no_entregado') {
      if (between(day, date) <= 7) hold.add(phone);
      continue;
    }
    if ((!delivered && !paid) || !(Number(order.total) > 0)) continue;
    const items = eggItems(order.items);
    if (!items.length) continue;
    if (!customers.has(phone)) customers.set(phone, { phone, dates: new Set(), orders: 0, lastTime: -Infinity });
    const customer = customers.get(phone);
    customer.dates.add(date);
    customer.orders++;
    const time = new Date(order.date).getTime();
    if (time > customer.lastTime) {
      Object.assign(customer, { name: order.name || phone, lastTime: time, lastProduct: items.join(', ') });
    }
  }
  const profiles = [];
  for (const c of customers.values()) {
    const dates = [...c.dates].sort().reverse();
    const gaps = dates.slice(1, 6).map((date, i) => between(dates[i], date));
    const interval = gaps.length ? median(gaps) : null;
    const elapsed = between(day, dates[0]);
    const expected = interval === null ? null : addDays(dates[0], Math.round(interval));
    const near = dates.length >= 3 && interval !== null &&
      Math.abs(elapsed - interval) <= Math.max(2, Math.min(5, interval * 0.18));
    const irregular = gaps.length > 1 && median(gaps.map(gap => Math.abs(gap - interval))) > Math.max(2, interval * 0.35);
    profiles.push({ phone: c.phone, name: c.name, orders: c.orders, purchaseDays: dates.length,
      lastDate: dates[0], elapsed, interval, expected, irregular, lastProduct: c.lastProduct,
      hasOrder: hold.has(c.phone), optOut: optOut.has(c.phone), recentOutreach: recentlyContacted.has(c.phone),
      due: near && !hold.has(c.phone) && !optOut.has(c.phone) });
  }
  profiles.sort((a, b) => Number(b.due) - Number(a.due) || Number(a.recentOutreach) - Number(b.recentOutreach) ||
    Number(a.irregular) - Number(b.irregular) || Math.abs(a.elapsed - a.interval) - Math.abs(b.elapsed - b.interval) || b.purchaseDays - a.purchaseDays);
  return { day, profiles, aliases: Object.fromEntries([...identities].filter(([a,b]) => a !== b && customers.has(b))) };
}

let snapshot;
let running;
async function getSnapshot(pool, orgId, refresh = false) {
  const day = todayISOChile();
  if (!refresh && snapshot?.orgId === orgId && snapshot.day === day && Date.now() - snapshot.at < REFRESH_MS) return snapshot;
  if (running?.orgId === orgId && running.day === day) return running.promise;
  const promise = (async () => {
    const [orders, contacts, scheduled, campaigns] = await Promise.all([
      loadOrderLedger(pool, orgId, null, true),
      pool.query('SELECT phone, name, email, address, address1, city, shopify_id, last_order_at, opt_out FROM contacts WHERE organization_id=$1', [orgId]),
      pool.query("SELECT phone FROM scheduled_orders WHERE organization_id=$1 AND status='pending' AND desired_date >= $2::date", [orgId, day]),
      pool.query(`SELECT DISTINCT destination_phone AS phone FROM broadcast_campaign_recipients
        WHERE organization_id=$1 AND result_status IN ('accepted','unknown') AND created_at >= NOW() - INTERVAL '48 hours'
          AND COALESCE(template_name,'') !~* '^(cobro|cobranza|pedido_salio|pedido_en_camino|payment|delivery)'`, [orgId]),
    ]);
    const result = { ...buildProfiles(orders, contacts.rows, scheduled.rows, campaigns.rows, day), orgId, at: Date.now() };
    snapshot = result;
    return result;
  })();
  running = { orgId, day, promise };
  try { return await promise; } finally { if (running?.promise === promise) running = null; }
}

async function readForStore(pool, orgId) {
  const { rows } = await pool.query('SELECT id FROM organizations WHERE id=$1 AND slug=$2', [orgId, STORE_SLUG]);
  if (!rows.length) return null;
  return getSnapshot(pool, rows[0].id);
}

function start(pool) {
  async function tick() {
    try {
      const { rows } = await pool.query('SELECT id FROM organizations WHERE slug=$1', [STORE_SLUG]);
      if (rows.length) await getSnapshot(pool, rows[0].id, true);
    } catch (error) { console.warn('[EggRepurchase]', error.message); }
  }
  void tick();
  const timer = setInterval(tick, REFRESH_MS);
  timer.unref();
  return timer;
}

module.exports = { buildProfiles, readForStore, start };
