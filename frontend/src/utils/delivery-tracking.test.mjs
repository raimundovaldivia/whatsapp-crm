import test from 'node:test';
import assert from 'node:assert/strict';
import { trackingTokenFromPath, fetchTrackingStatus } from './delivery-tracking.mjs';

const token = 'a'.repeat(43);

test('reconoce seguimiento antes del catálogo y reserva enlaces inválidos', () => {
  assert.equal(trackingTokenFromPath('/seguimiento/' + token), token);
  assert.equal(trackingTokenFromPath('/seguimiento/' + token + '/'), token);
  for (const path of ['/seguimiento', '/seguimiento/corto', '/seguimiento/' + token + '/admin']) {
    assert.equal(trackingTokenFromPath(path), '');
  }
  for (const path of ['/', '/admin', '/tienda/ejemplo', '/justo-casero', '/seguimientos']) {
    assert.equal(trackingTokenFromPath(path), null);
  }
});

test('consulta el mismo endpoint público sin cookies, credenciales CRM ni referrer', async () => {
  const controller = new AbortController();
  let call;
  const state = await fetchTrackingStatus('https://api.example/', token, controller.signal, async (...args) => {
    call = args;
    return { ok: true, status: 200, json: async () => ({ active: true, latitude: -30, longitude: -71 }) };
  });
  assert.equal(call[0], 'https://api.example/seguimiento/' + token + '/status');
  assert.deepEqual(call[1], { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
  assert.equal(state.latitude, -30);
});

test('cierre, entrega, revocación o enlace desconocido no conservan coordenadas', async () => {
  for (const [http, status, expected] of [[410, 'delivered', 'delivered'], [410, 'finished', 'finished'], [404, '', 'invalid'], [200, 'finished', 'finished']]) {
    const state = await fetchTrackingStatus('https://api.example', token, undefined, async () => ({
      status: http, ok: http === 200,
      json: async () => ({ active: false, status, latitude: -30, longitude: -71 }),
    }));
    assert.deepEqual(state, { active: false, status: expected });
  }
});

test('fallos de red, servidor o límite de solicitudes permiten reintentar sin afirmar cierre', async () => {
  for (const status of [429, 500, 503]) {
    await assert.rejects(fetchTrackingStatus('https://api.example', token, undefined, async () => ({ status, ok: false })), /temporalmente/);
  }
  await assert.rejects(fetchTrackingStatus('https://api.example', token, undefined, async () => { throw new Error('offline'); }), /offline/);
});

test('un token malformado no produce ninguna solicitud', async () => {
  const result = await fetchTrackingStatus('https://api.example', '../admin', undefined, async () => { assert.fail('No debe consultar'); });
  assert.equal(result.status, 'invalid');
});
