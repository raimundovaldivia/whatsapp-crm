import test from 'node:test';
import assert from 'node:assert/strict';
import { trackingTokenFromPath, fetchTrackingStatus, trackingLookupFromPath, fetchOrderStatus } from './delivery-tracking.mjs';

const token = 'a'.repeat(43);

test('consulta sin token y por tienda en host compartido, conservando enlaces de reparto', () => {
  assert.deepEqual(trackingLookupFromPath('/seguimiento'), { storeSlug:null });
  assert.deepEqual(trackingLookupFromPath('/seguimiento/'), { storeSlug:null });
  assert.deepEqual(trackingLookupFromPath('/tienda/store-a/seguimiento'), { storeSlug:'store-a' });
  for (const path of ['/seguimiento/'+token, '/seguimiento/corto', '/tienda/../seguimiento', '/admin']) {
    assert.equal(trackingLookupFromPath(path), null);
  }
});

test('teléfono y referencia viajan solo en POST, sin credenciales ni referrer', async () => {
  const input = { phone:'911111111', orderNumber:'DR-1', storeSlug:'store-a' };
  let call;
  const result = await fetchOrderStatus('https://api.example/', input, undefined, async (...args) => {
    call=args; return { ok:true, json:async()=>({status:'received'}) };
  });
  assert.equal(call[0], 'https://api.example/seguimiento/consultar');
  assert.equal(call[1].method,'POST');
  assert.deepEqual(JSON.parse(call[1].body),input);
  assert.equal(call[1].credentials,'omit');
  assert.equal(call[1].cache,'no-store');
  assert.equal(call[1].referrerPolicy,'no-referrer');
  assert.equal(result.status,'received');
});

test('búsqueda distingue datos incorrectos, límite y error temporal sin mostrar errores internos', async () => {
  for (const [status, message] of [[400,/Revisa/],[404,/No encontramos/],[429,/15 minutos/],[503,/nuevamente/]]) {
    await assert.rejects(fetchOrderStatus('',{},undefined,async()=>({ok:false,status})),message);
  }
});

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
