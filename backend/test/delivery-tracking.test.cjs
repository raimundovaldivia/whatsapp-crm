const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture(rows = [{ route_id: 8 }]) {
  const calls = [];
  const service = load('src/services/delivery-tracking.js', {
    '../db/database': { getPool: () => ({ query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } }) },
  }, { process: { env: { CRM_PUBLIC_URL: 'https://crm.example' } } });
  return { service, calls };
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
