const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

test('mobile test clone keeps addresses and products but removes every customer identity', async () => {
  const source = {
    id: 42,
    organization_id: 1,
    name: 'Reparto anterior',
    driver_name: 'Repartidor de prueba',
    driver_user_id: 7,
    orders: [{
      source: 'bot', id: '900', customerName: 'Nombre real', customerPhone: '56911112222',
      conversationId: 55, fullAddress: 'Dirección sintética 123, La Serena',
      items: [{ name: 'Huevos XL', quantity: 2, price: 12000 }],
    }],
    optimized_route: [{
      source: 'bot', id: '900', customerName: 'Nombre real', phone: '56911112222',
      fullAddress: 'Dirección sintética 123, La Serena', lat: -29.91, lng: -71.25,
      items: [{ name: 'Huevos XL', quantity: 2, price: 12000 }],
    }],
    total_distance: '10 km', total_duration: '30 min', maps_url: 'https://maps.example/test',
  };
  let inserted = null;
  const pool = { query: async (sql, params) => {
    if (/SELECT \* FROM delivery_routes/i.test(sql)) return { rows: [source] };
    if (/INSERT INTO delivery_routes/i.test(sql)) {
      inserted = {
        id: 100, organization_id: params[0], name: params[1], status: 'sent',
        driver_name: params[2], driver_user_id: params[3],
        orders: JSON.parse(params[4]), optimized_route: JSON.parse(params[5]),
      };
      return { rows: [inserted] };
    }
    return { rows: [] };
  } };
  const router = load('src/routes/delivery.js', {
    '../db/database': { getPool: () => pool, getSetting: async () => null },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });

  const res = response();
  await handler(router, 'post', '/routes/42/test-clone')({
    orgId: 1, role: 'owner', params: { id: '42' }, body: {},
  }, res);

  assert.equal(res.code, 201, JSON.stringify(res.body));
  assert.equal(inserted.status, 'sent');
  assert.equal(inserted.driver_user_id, 7);
  assert.equal(inserted.orders[0].customerName, 'Cliente prueba 01');
  assert.equal(inserted.orders[0].fullAddress, source.orders[0].fullAddress);
  assert.deepEqual(inserted.orders[0].items.map(({ name, quantity, price }) => ({ name, quantity, price })),
    [{ name: 'Huevos XL', quantity: 2, price: 12000 }]);
  assert.equal(inserted.orders[0].source, 'test');
  assert.equal(inserted.orders[0].isTest, true);
  const serialized = JSON.stringify(inserted);
  assert.doesNotMatch(serialized, /Nombre real|56911112222|conversationId/i);
});
