const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function fixture(geocodeStatus = 'OK') {
  const values = new Map();
  let writes = 0;
  const db = {
    getSetting: async (orgId, key) => values.get(`${orgId}:${key}`) ?? null,
    setSetting: async (orgId, key, value) => { writes++; values.set(`${orgId}:${key}`, value); },
  };
  const axios = { get: async (_url, { params }) => ({
    data: { status: geocodeStatus, error_message: 'private provider detail', results: [{ geometry: { location: params.address.includes('Ovalle')
      ? { lat: -30.598, lng: -71.200 }
      : { lat: -29.9027, lng: -71.2519 } } }] },
  }) };
  const router = load('src/routes/settings.js', {
    axios,
    '../db/database': db,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../middleware/commercial-access': { requireSolution: () => noop },
  }, { process: { env: { JWT_SECRET: 'test-secret-only-'.repeat(4), GOOGLE_MAPS_API_KEY: 'synthetic-key' } } });
  return { router, values, get writes() { return writes; } };
}

test('guarda radio y varios puntos solamente en la organización solicitante', async () => {
  const f = fixture();
  const saved = response();
  await handler(f.router, 'post', '/warehouse')({
    orgId: 7,
    body: {
      address: 'Bodega La Serena', coverageRadiusKm: 45,
      coveragePoints: [{ name: 'Sucursal Ovalle', address: 'Centro, Ovalle' }],
    },
  }, saved);
  assert.equal(saved.code, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.warehouse.coverageEnabled, true);
  assert.equal(saved.body.warehouse.coveragePoints[0].geocoded, true);

  const own = response();
  await handler(f.router, 'get', '/warehouse')({ orgId: 7 }, own);
  assert.equal(own.body.warehouse.coverageRadiusKm, 45);
  assert.equal(own.body.warehouse.coveragePoints[0].name, 'Sucursal Ovalle');

  const other = response();
  await handler(f.router, 'get', '/warehouse')({ orgId: 8 }, other);
  assert.equal(other.body.warehouse.coverageEnabled, false);
  assert.deepEqual(other.body.warehouse.coveragePoints, []);
});

test('rechaza radios inválidos antes de escribir configuración', async () => {
  const f = fixture();
  const res = response();
  await handler(f.router, 'post', '/warehouse')({ orgId: 7, body: { address: 'Bodega', coverageRadiusKm: 0 } }, res);
  assert.equal(res.code, 400);
  assert.equal(f.writes, 0);
});

test('distingue acceso a mapas, cuota y dirección sin exponer detalles del proveedor', async () => {
  for (const [status, expected] of [
    ['REQUEST_DENIED', /rechazó el acceso/],
    ['OVER_QUERY_LIMIT', /límite de consultas/],
    ['ZERO_RESULTS', /no encontró la dirección/],
  ]) {
    const f = fixture(status);
    const res = response();
    await handler(f.router, 'post', '/warehouse')({ orgId: 7, body: { address: 'Bodega', coverageRadiusKm: 50 } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.warehouse.geocoded, false);
    assert.equal(res.body.warehouse.coverageEnabled, false);
    assert.match(res.body.warning, expected);
    assert.doesNotMatch(JSON.stringify(res.body), /private provider detail|synthetic-key/);
  }
});
