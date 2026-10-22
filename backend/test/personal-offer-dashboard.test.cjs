const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function routerHarness() {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/price_confirmed/.test(sql)) return { rows: [{ total: 20, price_confirmed: 3, price_probable: 5, other_known: 4, unknown: 8 }] };
    if (/GROUP BY 1 ORDER BY MIN/.test(sql)) return { rows: [{ tier: '2', won: 2, discounts: 8000, revenue: 36000, average_ticket: 18000 }] };
    if (/GROUP BY 1 ORDER BY 1/.test(sql)) return { rows: [{ day: '2026-10-15', detected: 4, sent: 4, won: 2, revenue: 36000 }] };
    if (/wanted\.size/.test(sql)) return { rows: [{ size: 'XL', sold: 60, target: 3000 }, { size: 'L', sold: 90, target: 3000 }] };
    if (/FROM personal_offer_baselines/.test(sql)) return { rows: [] };
    return { rows: [{ detected: 4, sent: 4, failed: 0, won: 2, expired: 1, replied: 3, discounts: 8000, recovered_revenue: 36000, average_ticket: 18000, trays: 4, eggs: 150, estimated_egg_cost: 18000 }] };
  } };
  const router = load('src/routes/dashboard.js', {
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  return { route: handler(router, 'get', '/personal-offers'), calls };
}

test('métricas de recuperación muestran conversión, margen y calificación de precio', async () => {
  const { route, calls } = routerHarness();
  const res = response();
  await route({ orgId: 77, query: { days: '30' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.conversionRate, 50);
  assert.equal(res.body.data.responseRate, 75);
  assert.equal(res.body.data.estimatedContribution, 18000);
  assert.equal(res.body.data.eggs, 150);
  assert.equal(res.body.data.inventory[0].unit, 'eggs');
  assert.equal(res.body.data.inventory[0].remaining, 2940);
  assert.equal(res.body.data.priceQualification.total, 20);
  assert.equal(res.body.data.priceQualification.confirmed, 3);
  assert.equal(res.body.data.priceQualification.probable, 5);
  assert.equal(res.body.data.priceQualification.otherKnown, 4);
  assert.equal(res.body.data.priceQualification.unknown, 8);
  assert.ok(calls.every(call => call.params[0] === 77));
  assert.ok(calls.some(call => /SUBSTRING/.test(call.sql)));
});

test('métricas rechazan períodos inválidos sin consultar la base', async () => {
  const { route, calls } = routerHarness();
  const res = response();
  await route({ orgId: 77, query: { days: '365' } }, res);
  assert.equal(res.code, 400);
  assert.equal(calls.length, 0);
});
