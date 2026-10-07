const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, report, validDate } = require('../src/services/cash-register');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');
const makeRoute = (id, key, method, amount, status = 'entregado') => ({
  id, orders: [{ source: 'bot', id: key, totalPrice: 10000, customerName: 'Test' }],
  stop_statuses: { ['bot_' + key]: status }, stop_payments: { ['bot_' + key]: method },
  stop_payment_amounts: amount ? { ['bot_' + key]: { cash: amount } } : {},
  stop_times: { ['bot_' + key]: '2026-10-06T12:00:00Z' },
});
test('cash accountability is grouped by driver and subtracts only that driver expenses', () => {
  const ana = { ...makeRoute(1, 1, 'efectivo'), driver_user_id: 10, driver_name: 'Ana' };
  const leo = { ...makeRoute(2, 2, 'mixto', 4000), driver_user_id: 20, driver_name: 'Leo' };
  const result = summarize([ana, leo], [], [
    { day: '2026-10-06', amount: 1000, driver_user_id: 10, driver_name: 'Ana' },
    { day: '2026-10-06', amount: 500, driver_user_id: 20, driver_name: 'Leo' },
  ], '2026-10-06', '2026-10-06');
  const byName = Object.fromEntries(result.byDriver.map(row => [row.driver, row]));
  assert.equal(byName.Ana.deliveries, 1);
  assert.equal(byName.Ana.cash, 10000);
  assert.equal(byName.Ana.expectedCash, 9000);
  assert.equal(byName.Leo.cash, 4000);
  assert.equal(byName.Leo.expectedCash, 3500);
});
test('cash counts delivered receipts once, splits mixed payments, excludes transfers and flags unknowns', () => {
  const routes = [makeRoute(1,1,'efectivo'), makeRoute(2,1,'efectivo'), makeRoute(3,2,'mixto',4000),
    makeRoute(4,3,'transferencia'), makeRoute(5,4,'efectivo',null,'not_delivered'),
    makeRoute(6,5,null), makeRoute(7,6,'mixto')];
  const result = summarize(routes, [], [{day:'2026-10-06',amount:3000}], '2026-10-06','2026-10-06');
  assert.equal(result.cash,14000);
  assert.equal(result.expenses,3000);
  assert.equal(result.receipts.length,2);
  assert.equal(result.unresolved.length,2);
  assert.deepEqual(result.byDay,[{day:'2026-10-06',cash:14000,expenses:3000}]);
  assert.equal(summarize(routes,[],[],'2026-10-07','2026-10-07').cash,0);
});
test('cash date validation rejects impossible and inverted dates', async () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2026-10-06'), true);
  const router=load('src/routes/delivery.js',{
    '../services/cash-register': { validDate },
    '../middleware/auth': {requireAuth:noop,requireRole:()=>noop},
  });
  const res=response();
  await handler(router,'get','/cash-register')({query:{from:'2026-10-07',to:'2026-10-06'}},res);
  assert.equal(res.code,400);
});
test('cash report scopes every source to the organization and counts expenses beyond the 500-row UI limit', async () => {
  const engine = new PGlite();
  try {
    await load('src/db/setup.js',{pg:{Pool:class {
      async query(sql,params){return params?.length ? engine.query(sql,params) : (await engine.exec(sql)).at(-1);}
      async connect(){return {query:this.query.bind(this),release(){}};}
      async end(){}
    }}}).setupDatabase();
    await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES (1,'A','a'),(2,'B','b');
      INSERT INTO delivery_expenses(organization_id,driver_user_id,amount,created_at)
        SELECT 1,1,100,'2026-10-06 12:00:00' FROM generate_series(1,501);
      INSERT INTO delivery_expenses(organization_id,driver_user_id,amount,created_at) VALUES
        (2,2,99999,'2026-10-06 12:00:00'),(1,1,888,'2026-10-06 01:00:00');`);
    const route=makeRoute(1,1,'efectivo');
    for (const org of [1,2]) await engine.query(`INSERT INTO delivery_routes(organization_id,name,status,orders,stop_statuses,stop_payments,stop_times,created_at)
      VALUES($1,'Ruta','completed',$2,$3,$4,$5,'2026-01-01')`,[org,JSON.stringify(route.orders),JSON.stringify(route.stop_statuses),JSON.stringify(route.stop_payments),JSON.stringify(route.stop_times)]);
    const result=await report(engine,1,'2026-10-06','2026-10-06');
    assert.equal(result.cash,10000,'old routes with deliveries today must be included');
    assert.equal(result.expenses,50100,'all expenses, Chile date and tenant scoped');
    assert.equal(result.expenseCount,501);
  } finally { await engine.close(); }
});
