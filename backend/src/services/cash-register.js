const TZ = 'America/Santiago';
const dayOf = value => new Date(value).toLocaleDateString('sv-SE', { timeZone: TZ });
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
function summarize(routes, orders, expenses, from, to) {
  const orderMap = new Map(orders.map(o => [`${o.source}_${o.id}`, o]));
  const delivered = new Map();
  for (const route of routes) {
    const stops = route.optimized_route?.length ? route.optimized_route : route.orders || [];
    for (const stop of stops) {
      const key = `${stop.source}_${stop.id}`;
      if (route.stop_statuses?.[key] !== 'entregado') continue;
      const at = route.stop_times?.[key] || route.completed_at || route.sent_at || route.created_at;
      // One receipt per order, even if an old route repeats a delivered stop.
      if (delivered.has(key) && new Date(delivered.get(key).at) >= new Date(at)) continue;
      delivered.set(key, { route, stop, key, at });
    }
  }
  const receipts = [], unresolved = [];
  const drivers = new Map();
  const driverFor = (id, name) => {
    const key = id == null ? `name:${name || 'Sin repartidor'}` : `id:${id}`;
    if (!drivers.has(key)) drivers.set(key, {
      key, driverId: id ?? null, driver: name || 'Sin repartidor',
      deliveries: 0, cashDeliveries: 0, cash: 0, expenses: 0,
      adjustments: 0, unresolved: 0, expectedCash: 0,
    });
    return drivers.get(key);
  };
  for (const { route, stop, key, at } of delivered.values()) {
    const day = dayOf(at);
    if (day < from || day > to) continue;
    const order = orderMap.get(key);
    const method = Object.hasOwn(route.stop_payments || {}, key) ? route.stop_payments[key] : order?.payment_method;
    const amounts = route.stop_payment_amounts?.[key];
    const extras = (route.stop_extras?.[key] || []).reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    const total = Number(order?.total_price ?? (Number(stop.totalPrice || 0) + extras));
    const cash = method === 'efectivo' ? total : method === 'mixto' ? Number(amounts?.cash ?? order?.payment_cash_amount) : 0;
    const driver = driverFor(route.driver_user_id, route.driver_name);
    driver.deliveries += 1;
    const row = { key, day, at, customer: stop.customerName || order?.customer_name || 'Cliente',
      label: stop.orderName || '#' + stop.id, driver: driver.driver, driverId: driver.driverId, cash,
      approximateDate: !route.stop_times?.[key] };
    if (!method || method === 'otro' || !Number.isFinite(cash) || cash < 0 || (method === 'mixto' && (cash <= 0 || cash >= total))) {
      unresolved.push({ ...row, cash: null });
      driver.unresolved += 1;
    } else if (cash > 0) {
      receipts.push(row);
      driver.cashDeliveries += 1;
      driver.cash += cash;
    }
  }
  const daily = new Map();
  const getDay = day => { if (!daily.has(day)) daily.set(day, { day, cash: 0, expenses: 0 }); return daily.get(day); };
  receipts.forEach(row => { getDay(row.day).cash += row.cash; });
  expenses.forEach(row => {
    const amount = Number(row.amount) || 0;
    getDay(row.day).expenses += amount;
    driverFor(row.driver_user_id, row.driver_name).expenses += amount;
  });
  const byDriver = [...drivers.values()].map(row => ({
    ...row,
    expectedCash: row.cash - row.expenses,
  })).sort((a, b) => b.expectedCash - a.expectedCash || a.driver.localeCompare(b.driver, 'es'));
  return { receipts: receipts.sort((a,b) => b.day.localeCompare(a.day)), unresolved,
    cash: receipts.reduce((sum, row) => sum + row.cash, 0),
    expenses: expenses.reduce((sum, row) => sum + Number(row.amount), 0),
    expenseCount: expenses.length, byDay: [...daily.values()].sort((a,b) => a.day.localeCompare(b.day)), byDriver };
}
async function report(pool, orgId, from, to) {
  const [routes, orders, expenses, movements] = await Promise.all([
    // Read all marked routes: an old route can have a delivery during this period.
    pool.query(`SELECT id,orders,optimized_route,stop_statuses,stop_payments,stop_payment_amounts,
      stop_extras,stop_times,completed_at,sent_at,created_at,driver_user_id,driver_name FROM delivery_routes
      WHERE organization_id=$1 AND status <> 'draft' AND stop_statuses IS NOT NULL`, [orgId]),
    pool.query(`SELECT 'bot' AS source,id::text AS id,total_price::text AS total_price,payment_method,payment_cash_amount,customer_name
      FROM orders WHERE organization_id=$1 UNION ALL
      SELECT 'shopify',shopify_order_id,total_price::text,payment_method,payment_cash_amount,customer_name
      FROM shopify_orders WHERE organization_id=$1`, [orgId]),
    pool.query(`SELECT amount,driver_user_id,driver_name,TO_CHAR(((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date,'YYYY-MM-DD') AS day
      FROM delivery_expenses WHERE organization_id=$1
      AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date BETWEEN $2::date AND $3::date`, [orgId, from, to]),
    pool.query(`SELECT m.return_id,m.amount,m.created_at,r.driver_user_id,u.name AS driver_name
      FROM return_money_movements m LEFT JOIN order_returns r ON r.id=m.return_id AND r.organization_id=m.organization_id
      LEFT JOIN users u ON u.id=r.driver_user_id AND u.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND m.method='efectivo'
      AND (m.created_at AT TIME ZONE 'America/Santiago')::date BETWEEN $2::date AND $3::date ORDER BY m.created_at`, [orgId,from,to]),
  ]);
  const result=summarize(routes.rows, orders.rows, expenses.rows, from, to);
  const days=new Map(result.byDay.map(row=>[row.day,{...row,adjustments:0}]));
  const drivers=new Map(result.byDriver.map(row=>[row.driverId == null ? `name:${row.driver}` : `id:${row.driverId}`,{...row}]));
  for(const movement of movements.rows){
    const amount=Number(movement.amount)||0;const day=dayOf(movement.created_at);
    if(!days.has(day))days.set(day,{day,cash:0,expenses:0,adjustments:0});days.get(day).adjustments+=amount;
    const key=movement.driver_user_id==null?`name:${movement.driver_name||'Sin repartidor'}`:`id:${movement.driver_user_id}`;
    if(!drivers.has(key))drivers.set(key,{key,driverId:movement.driver_user_id??null,driver:movement.driver_name||'Sin repartidor',deliveries:0,cashDeliveries:0,cash:0,expenses:0,adjustments:0,unresolved:0,expectedCash:0});
    drivers.get(key).adjustments+=amount;
  }
  const byDriver=[...drivers.values()].map(row=>({...row,expectedCash:row.cash+row.adjustments-row.expenses}))
    .sort((a,b)=>b.expectedCash-a.expectedCash||a.driver.localeCompare(b.driver,'es'));
  return {...result, byDriver, movements:movements.rows, adjustments:movements.rows.reduce((sum,row)=>sum+Number(row.amount),0),byDay:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day))};
}
module.exports = { report, summarize, validDate };
