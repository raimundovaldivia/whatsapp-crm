import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { createAuthSession, installSessionInterceptors } from './auth-session.mjs';

const account = (id, role = 'owner') => ({ token: `session-test-${id}`, user: { id, organization_id: id, email: 'prueba@example.test', role }, organization: { id, name: `Tienda ${id}` } });
function fixture() {
  const values = new Map([['crm_theme', 'dark'], ['draft', 'conservar']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let reloads = 0;
  const session = createAuthSession(storage, () => { reloads++; });
  session.save(account(10));
  const api = axios.create();
  installSessionInterceptors(api, session, () => new axios.CanceledError('La sesión cambió'));
  return { storage, session, api, reloads: () => reloads };
}

test('cambiar tienda conserva preferencias, reemplaza identidad y exige una recarga limpia', () => {
  const { session, storage, reloads } = fixture();
  const oldToken = session.token;
  session.save(account(20, 'agent'), { switchStore: true });
  assert.equal(reloads(), 1);
  assert.equal(storage.getItem('crm_token'), account(20).token);
  assert.equal(JSON.parse(storage.getItem('crm_user')).role, 'agent');
  assert.equal(JSON.parse(storage.getItem('crm_org')).id, 20);
  assert.equal(storage.getItem('crm_theme'), 'dark');
  assert.equal(storage.getItem('draft'), 'conservar');
  assert.equal(session.isCurrent(oldToken), false);
  assert.throws(() => session.getToken(), { code: 'SESSION_CHANGED' });
});

test('respuesta inválida o fallo de almacenamiento no reemplazan la sesión vigente', () => {
  const { session, storage, reloads } = fixture();
  const invalid = account(20); invalid.user.organization_id = 30;
  assert.throws(() => session.save(invalid), /inválida/);
  const original = storage.setItem;
  storage.setItem = (key, value) => { if (key === 'crm_token' && value === account(20).token) throw new Error('storage lleno'); original(key, value); };
  assert.throws(() => session.save(account(20), { switchStore: true }), /storage lleno/);
  assert.equal(session.getToken(), account(10).token);
  assert.equal(JSON.parse(storage.getItem('crm_org')).id, 10);
  assert.equal(reloads(), 0);
});

test('otra pestaña recarga una vez y no puede enviar datos de su vista con la nueva identidad', async () => {
  const { session, storage, api, reloads } = fixture();
  const otherTab = createAuthSession(storage, () => {});
  otherTab.save(account(20));
  let sent = false;
  await assert.rejects(api.post('/orders', { items: ['datos de tienda 10'] }, { adapter: async () => { sent = true; } }), { code: 'SESSION_CHANGED' });
  session.onStorage({ key: 'crm_token', storageArea: storage });
  session.onStorage({ key: 'crm_token', storageArea: storage });
  assert.equal(sent, false);
  assert.equal(reloads(), 1);
  assert.equal(session.clear(account(10).token), false);
  assert.equal(storage.getItem('crm_token'), account(20).token);
});

test('un cambio de tema no recarga y cerrar sesión conserva datos ajenos a autenticación', () => {
  const { session, storage, reloads } = fixture();
  session.onStorage({ key: 'crm_theme', storageArea: storage });
  assert.equal(reloads(), 0);
  session.clear();
  assert.equal(session.getToken(), null);
  assert.equal(storage.getItem('draft'), 'conservar');
  assert.equal(storage.getItem('crm_org'), null);
});

test('contraseña incorrecta en el selector conserva la tienda abierta', async () => {
  const { session, api, reloads } = fixture();
  await assert.rejects(api.post('/auth/login', {}, { adapter: async config => {
    throw Object.assign(new Error('Credenciales incorrectas'), { config, response: { status: 401 } });
  } }), /Credenciales incorrectas/);
  assert.equal(session.getToken(), account(10).token);
  assert.equal(reloads(), 0);
});

for (const status of [200, 401]) test(`respuesta pendiente ${status} de la tienda anterior se descarta sin borrar la nueva sesión`, async () => {
  const { session, api, storage } = fixture();
  let finish;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const request = api.get('/conversations', { adapter: config => new Promise((resolve, reject) => {
    assert.equal(config.headers.Authorization, `Bearer ${account(10).token}`);
    finish = () => status === 200 ? resolve({ status, data: ['datos privados tienda 10'], config }) : reject(Object.assign(new Error('expired'), { config, response: { status } }));
    start();
  }) });
  await started;
  session.save(account(20), { switchStore: true });
  finish();
  await assert.rejects(request, error => axios.isCancel(error));
  assert.equal(storage.getItem('crm_token'), account(20).token);
});

test('una sesión realmente vencida se borra y vuelve al acceso', async () => {
  const { api, storage, reloads } = fixture();
  await assert.rejects(api.get('/settings', { adapter: async config => { throw Object.assign(new Error('expired'), { config, response: { status: 401 } }); } }));
  assert.equal(storage.getItem('crm_token'), null);
  assert.equal(reloads(), 1);
});
