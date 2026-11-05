const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProfiles, readForStore } = require('../src/services/egg-repurchase');
const { loadOrderLedger } = require('../src/services/broadcast-purchases');

const day = '2026-11-05';
const phone = '56911112222';
const order = (date, patch = {}) => ({ phone, date, name: 'Cliente', dispatch: 'entregado', total: '20000',
  items: '[{"name":"PROMO 60 XL","quantity":1}]', ...patch });
const weekly = ['2026-10-15', '2026-10-22', '2026-10-29'].map(d => order(d + 'T12:00:00Z'));
const profile = (orders, contacts = [], scheduled = [], sent = []) => buildProfiles(orders, contacts, scheduled, sent, day).profiles[0];

test('uses Chile business days, separates order count and different purchase days, and predicts without a manual refresh', () => {
  const sameDay = order('2026-10-30T02:59:00Z', { phone: '+56 9 1111 2222', items: ['25 BANDEJAS DE 30 XL'] });
  const exceptions = [
    { total: 0 }, { dispatch: 'cancelled' }, { payment: 'refunded' }, { fulfillment: 'restocked' },
    { items: [{ title: 'Queso de cabra' }] }, { items: 'invalid' }, { items: [{ name: 'Huevos XL', quantity: 0 }] },
  ].map(patch => order('2026-10-31T12:00:00Z', patch));
  const p = profile([...weekly, sameDay, ...exceptions]);
  assert.equal(p.orders, 4); assert.equal(p.purchaseDays, 3); assert.equal(p.lastDate, '2026-10-29');
  assert.equal(p.interval, 7); assert.equal(p.elapsed, 7); assert.equal(p.expected, day); assert.equal(p.due, true);
  assert.match(p.lastProduct, /BANDEJAS/);
});

test('tomorrow bookings, open orders, non-delivery and opt-outs keep due customers out of the shortlist', () => {
  for (const patch of [{ dispatch:'por_despachar' }, { dispatch:'nuevo', payment:'paid', delivery_day:'2026-11-09' },
    { dispatch:'no_entregado' }]) {
    assert.equal(profile([...weekly, order('2026-11-04T12:00:00Z', patch)]).due, false);
  }
  assert.equal(profile(weekly, [], [{phone:'911112222'}]).hasOrder, true);
  assert.equal(profile(weekly,[{phone,opt_out:true}]).due, false);
  assert.equal(profile(weekly, [], [], [{phone}]).recentOutreach, true);
  assert.equal(profile([...weekly, order(day+'T12:00:00Z', {dispatch:'draft'})]).hasOrder,true);
});

test('limited history is identified even if the two dates imply a near-term interval', () => {
  assert.equal(profile(weekly.slice(-1)).interval, null);
  assert.equal(profile(weekly.slice(-2)).due, false);
  const historical = ['2026-03-01','2026-04-01','2026-05-01','2026-06-01','2026-09-24','2026-10-01','2026-10-08','2026-10-15','2026-10-22','2026-10-29'];
  assert.equal(profile(historical.map(d=>order(d+'T12:00:00Z'))).interval,7);
});

test('Shopify mirror reserves its ID and disabled stores never run the ledger', async () => {
  const shared = { ...weekly[0], id:'123', status:'paid', payment:'paid', dispatch:'nuevo' };
  const pool = { query: async (sql,args) => {
    assert.equal(args[0], 3);
    return { rows: sql.includes('FROM shopify_orders') ? [shared] : [{...shared, id:2, shopify_order_id:'gid://shopify/Order/123'}] };
  }};
  const rows = await loadOrderLedger(pool,3,null,true);
  assert.equal(rows.length,1); assert.equal(profile(rows).orders,1);
  const disabled = {query: async (sql,args) => {
    assert.match(sql,/FROM organizations WHERE id=\$1 AND slug=\$2/); assert.equal(args[0],4); return {rows:[]};
  }};
  assert.equal(await readForStore(disabled,4),null);
});
