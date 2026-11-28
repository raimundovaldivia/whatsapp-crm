const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, noop, response } = require('./helpers.cjs');

test('el pedido manual guarda las cantidades y los precios explícitos, incluido un regalo', async () => {
  const writes = [];
  const router = load('src/routes/orders.js', {
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': { getPool: () => ({ query: async (sql, values) => {
      writes.push(values);
      return { rows: [{ id: 1 }] };
    } }) },
  });
  async function submit(items) {
    const res = response();
    await handler(router, 'post', '/')({ orgId: 1, body: { customerName: 'Prueba', items } }, res);
    return res.code;
  }
  const egg = { name: 'Huevos L', price: '9490.00', quantity: '2' };
  const gift = { title: 'Manjar', price: 0 };
  for (const invalid of [{ quantity: '' }, { quantity: 0 }, { quantity: '-1' }, { quantity: 1.5 }, { price: '' }, { price: -10 }]) {
    assert.equal(await submit([gift, { ...egg, ...invalid }]), 400);
  }
  assert.equal(writes.length, 0);
  assert.equal(await submit([egg, gift]), 201);
  assert.deepEqual(JSON.parse(writes[0][4]), [
    { name: 'Huevos L', quantity: 2, price: 9490 },
    { name: 'Manjar', quantity: 1, price: 0 },
  ]);
  assert.equal(writes[0][5], '18980');
});
