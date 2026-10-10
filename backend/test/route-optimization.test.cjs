const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

const warehouse = { address: 'Bodega de prueba, La Serena', lat: -29.91, lng: -71.25 };
const settings = {
  warehouse_address: warehouse.address,
  warehouse_lat: String(warehouse.lat),
  warehouse_lng: String(warehouse.lng),
};

function syntheticOrder(id, coords = null) {
  return {
    source: id % 2 ? 'bot' : 'shopify',
    id: `synthetic-${id}`,
    customerName: `Punto de prueba ${id}`,
    fullAddress: `Dirección de prueba ${id}, La Serena`,
    ...(coords || {}),
  };
}

function routerWithDirections({ failAt = null } = {}) {
  let calls = 0;
  const axios = { get: async (_url, { params }) => {
    calls++;
    if (calls === failAt) throw new Error('fallo simulado de Directions');
    const raw = String(params.waypoints || '').replace(/^optimize:true\|/, '');
    const count = raw ? raw.split('|').length : 0;
    return { data: {
      status: 'OK',
      routes: [{
        waypoint_order: Array.from({ length: count }, (_, index) => count - index - 1),
        legs: Array.from({ length: count + 1 }, (_, index) => ({
          distance: { value: 1000 + index, text: '1 km' },
          duration: { value: 600, text: '10 min' },
          end_location: { lat: -29.90 - index / 1000, lng: -71.24 - index / 1000 },
        })),
        overview_polyline: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
      }],
    } };
  } };
  const database = {
    getSetting: async (_orgId, key) => settings[key] || null,
    getPool: () => ({ query: async () => ({ rows: [] }) }),
  };
  return load('src/routes/delivery.js', {
    axios,
    '../db/database': database,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  }, { process: { env: { JWT_SECRET: 'test-secret-only-'.repeat(4), GOOGLE_MAPS_API_KEY: 'synthetic-key' } } });
}

async function optimize(router, orders, vehicles) {
  const res = response();
  await handler(router, 'post', '/optimize')({ orgId: 1, role: 'owner', body: { orders, vehicles } }, res);
  return res;
}

function routeKeys(routes) {
  return routes.flatMap(route => route.stops.map(stop => `${stop.source}_${stop.id}`));
}

test('multiple synthetic routes contain every stop exactly once, including addresses without coordinates', async () => {
  // No real customer data or phone numbers are used. Unlocated records are
  // deliberately interleaved to reproduce the former mixed-index bug.
  const orders = Array.from({ length: 12 }, (_, index) => {
    const located = ![0, 3, 7, 10].includes(index);
    return syntheticOrder(index + 1, located
      ? { lat: -29.88 - index / 100, lng: -71.20 - index / 100 }
      : null);
  });
  const result = await optimize(routerWithDirections(), orders, 3);
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.routes.length, 3);
  const keys = routeKeys(result.body.routes);
  assert.equal(keys.length, orders.length);
  assert.equal(new Set(keys).size, orders.length);
  assert.deepEqual(new Set(keys), new Set(orders.map(order => `${order.source}_${order.id}`)));
  for (const route of result.body.routes) {
    assert.deepEqual(route.stops.map(stop => stop.stopNumber), route.stops.map((_, index) => index + 1));
    assert.ok(route.path.length >= 2, 'the real Directions polyline is included for the map');
  }
});

test('identical coordinates still produce the requested balanced synthetic routes without omissions', async () => {
  const orders = Array.from({ length: 11 }, (_, index) =>
    syntheticOrder(index + 30, { lat: -29.9027, lng: -71.2519 }));
  const result = await optimize(routerWithDirections(), orders, 4);
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.routes.length, 4);
  const sizes = result.body.routes.map(route => route.stops.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  const keys = routeKeys(result.body.routes);
  assert.equal(keys.length, 11);
  assert.equal(new Set(keys).size, 11);
});

test('synthetic coverage stays exact from one through eight vehicles', async () => {
  const orders = Array.from({ length: 19 }, (_, index) =>
    syntheticOrder(index + 100, index % 5 === 0 ? null : { lat: -29.70 - index / 200, lng: -71.05 - index / 200 }));
  for (let vehicles = 1; vehicles <= 8; vehicles++) {
    const result = await optimize(routerWithDirections(), orders, vehicles);
    assert.equal(result.code, 200, `vehicles=${vehicles}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.routes.length, vehicles);
    const keys = routeKeys(result.body.routes);
    assert.equal(keys.length, orders.length, `vehicles=${vehicles}`);
    assert.equal(new Set(keys).size, orders.length, `vehicles=${vehicles}`);
  }
});

test('a simulated Google failure keeps all synthetic stops visible and reports the route as not optimized', async () => {
  const orders = Array.from({ length: 8 }, (_, index) =>
    syntheticOrder(index + 60, { lat: -29.80 - index / 100, lng: -71.10 - index / 100 }));
  const result = await optimize(routerWithDirections({ failAt: 1 }), orders, 2);
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.optimized, false);
  assert.match(result.body.warning, /conservaron todas sus paradas/i);
  const keys = routeKeys(result.body.routes);
  assert.equal(keys.length, 8);
  assert.equal(new Set(keys).size, 8);
});

