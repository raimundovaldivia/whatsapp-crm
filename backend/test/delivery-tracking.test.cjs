const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture(rows = [{ route_id: 8 }], stores = {}, env = { CRM_PUBLIC_URL: 'https://crm.example' }) {
  const calls = [];
  const settings = [];
  const service = load('src/services/delivery-tracking.js', {
    '../db/database': {
      getSetting: async (orgId, key) => { settings.push([orgId, key]); return stores[orgId] || null; },
      getPool: () => ({ query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } }),
    },
  }, { process: { env } });
  return { service, calls, settings };
}

test('crea un enlace opaco y solo guarda el hash del token', async () => {
  const f = fixture();
  const url = await f.service.createTrackingLink(3, 8, 'bot_324');
  assert.match(url, /^https:\/\/crm\.example\/seguimiento\/[A-Za-z0-9_-]{32,96}$/);
  const token = url.split('/').at(-1);
  assert.notEqual(f.calls[0].params[3], token);
  assert.equal(f.calls[0].params[3], f.service.tokenHash(token));
  assert.equal(f.calls[0].params[0], 3);
  assert.equal(f.calls[0].params[1], 8);
  assert.match(f.calls[0].sql, /r\.organization_id = \$1 AND r\.status = 'in_progress'/);
});

test('cada tienda usa su propio dominio HTTPS y descarta rutas del catálogo', async () => {
  const f = fixture(undefined, { 1: ' https://diezrios.com/tienda/huevos?origen=web#catalogo ', 2: 'https://otra-tienda.example/' });
  const first = await f.service.createTrackingLink(1, 8, 'bot_324');
  const second = await f.service.createTrackingLink(2, 9, 'bot_325');
  assert.equal(new URL(first).origin, 'https://diezrios.com');
  assert.equal(new URL(second).origin, 'https://otra-tienda.example');
  assert.match(new URL(first).pathname, /^\/seguimiento\/[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.settings, [[1, 'store_public_url'], [2, 'store_public_url']]);
  assert.equal(f.calls[0].params[0], 1);
  assert.equal(f.calls[1].params[0], 2);
});

test('sin dominio HTTPS válido conserva el enlace anterior, sin aceptar credenciales ni scripts', async () => {
  for (const value of ['', 'diezrios.com', 'javascript:alert(1)', 'http://otra-tienda.example', 'https://user:password@otra-tienda.example', 'x'.repeat(2049)]) {
    const f = fixture(undefined, { 3: value });
    assert.match(await f.service.createTrackingLink(3, 8, 'bot_324'), /^https:\/\/crm\.example\/seguimiento\//);
  }
  for (const key of ['PUBLIC_URL', 'BACKEND_URL']) {
    const f = fixture(undefined, {}, { [key]: 'https://legacy.example/' });
    assert.match(await f.service.createTrackingLink(3, 8, 'bot_324'), /^https:\/\/legacy\.example\/seguimiento\//);
  }
});

test('no genera enlaces para rutas de otra tienda ni entradas inválidas', async () => {
  const f = fixture([]);
  assert.equal(await f.service.createTrackingLink(3, 8, 'bot_324'), null);
  assert.equal(f.calls.length, 1);
  const invalid = fixture();
  for (const [org, route, stop] of [[0, 8, 'bot_324'], [3, '8 OR 1=1', 'bot_324'], [3, 8, ''], [3, 8, 'a'.repeat(301)]]) {
    assert.equal(await invalid.service.createTrackingLink(org, route, stop), null);
  }
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.settings.length, 0);
});

test('una tienda con dominio puede generar enlace sin URL global; sin ninguna URL no escribe', async () => {
  const f = fixture(undefined, { 3: 'https://tienda.example' }, {});
  assert.match(await f.service.createTrackingLink(3, 8, 'bot_324'), /^https:\/\/tienda\.example\/seguimiento\//);
  const missing = fixture(undefined, {}, {});
  assert.equal(await missing.service.createTrackingLink(3, 8, 'bot_324'), null);
  assert.equal(missing.calls.length, 0);
});

test('valida coordenadas antes de tocar la base de datos', () => {
  const { service } = fixture();
  const location = service.validateLocation({ latitude: -29.95, longitude: -71.34, accuracy: 12 });
  assert.equal(location.latitude, -29.95);
  assert.equal(location.longitude, -71.34);
  assert.equal(location.accuracy, 12);
  assert.throws(() => service.validateLocation({ latitude: 120, longitude: -71 }), /Latitud/);
  assert.throws(() => service.validateLocation({ latitude: -30, longitude: 'x' }), /Longitud/);
});

test('el enlace deja de entregar ubicación cuando la parada ya fue entregada', async () => {
  const f = fixture([{
    stop_key: 'bot_324', latitude: -29.95, longitude: -71.34, accuracy_m: 15,
    location_updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
    revoked_at: null, route_status: 'in_progress', stop_statuses: { bot_324: 'entregado' },
  }]);
  const status = await f.service.getTrackingStatus('a'.repeat(43));
  assert.equal(status.active, false);
  assert.equal(status.status, 'delivered');
  assert.equal(status.latitude, null);
  assert.equal(status.longitude, null);
});

test('enlaces previos conservan su token y ocultan ubicación al vencer, revocar o terminar ruta', async () => {
  const row = {
    stop_key: 'bot_324', latitude: -29.95, longitude: -71.34, accuracy_m: 15,
    location_updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
    revoked_at: null, route_status: 'in_progress', stop_statuses: {},
  };
  for (const changes of [{}, { expires_at: '2000-01-01' }, { revoked_at: new Date().toISOString() }, { route_status: 'completed' }, { stop_statuses: { bot_324: 'cancelled' } }]) {
    const f = fixture([{ ...row, ...changes }]);
    const state = await f.service.getTrackingStatus('a'.repeat(43));
    const active = Object.keys(changes).length === 0;
    assert.equal(state.active, active);
    assert.equal(state.latitude, active ? -29.95 : null);
    assert.equal(state.longitude, active ? -71.34 : null);
    assert.match(f.calls[0].sql, /r\.organization_id = s\.organization_id/);
    assert.equal(f.calls[0].params[0], f.service.tokenHash('a'.repeat(43)));
    assert.equal(f.settings.length, 0);
  }
  const f = fixture();
  assert.equal(await f.service.getTrackingStatus('../invalid'), null);
  assert.equal(f.calls.length, 0);
});
