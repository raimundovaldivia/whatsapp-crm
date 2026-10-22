const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { load, handler, response, noop } = require('./helpers.cjs');

const hash = bcrypt.hashSync('clave-segura-1', 4);
const otherHash = bcrypt.hashSync('otra-clave-2', 4);
const users = [
  { id: 1, organization_id: 10, email: 'dueno@x.cl', password_hash: hash, name: 'Dueño', role: 'owner', auth_version: 0 },
  { id: 2, organization_id: 20, email: 'dueno@x.cl', password_hash: otherHash, name: 'Dueño', role: 'owner', auth_version: 0 },
];
const orgs = { 10: { id: 10, name: 'JustoCasero', slug: 'justocasero', setup_done: true }, 20: { id: 20, name: 'Diez Ríos', slug: 'diezrios', setup_done: true } };
const fakeDb = {
  getUsersByEmail: async (email) => users.filter(u => u.email === email),
  getOrgById: async (id) => orgs[id],
};

function loginRouter() {
  return load('src/routes/auth.js', {
    'express': require('express'),
    'bcryptjs': bcrypt,
    '../db/database': fakeDb,
    '../middleware/auth': { generateToken: u => `tok-${u.id}`, requireAuth: noop },
  });
}
async function callLogin(body) {
  const router = loginRouter();
  const fn = handler(router, 'post', '/login');
  const res = response();
  await fn({ body }, res);
  return res;
}

test('login con una sola cuenta sigue funcionando igual', async () => {
  const res = await callLogin({ email: 'dueno@x.cl', password: 'otra-clave-2' });
  assert.equal(res.body.data.token, 'tok-2');
  assert.equal(res.body.data.organization.slug, 'diezrios');
});

test('login con misma clave en dos empresas pide elegir empresa', async () => {
  const sameKey = bcrypt.hashSync('misma-clave-3', 4);
  users[0].password_hash = sameKey; users[1].password_hash = sameKey;
  const res = await callLogin({ email: 'dueno@x.cl', password: 'misma-clave-3' });
  assert.equal(res.body.data.needsOrganization, true);
  assert.equal(res.body.data.token, undefined);
  const names = res.body.data.organizations.map(o => o.name).sort();
  assert.equal(names.length, 2);
  assert.equal(names[0], 'Diez Ríos');
  assert.equal(names[1], 'JustoCasero');
  users[0].password_hash = hash; users[1].password_hash = otherHash;
});

test('eligiendo empresa entra solo a esa cuenta', async () => {
  const sameKey = bcrypt.hashSync('misma-clave-3', 4);
  users[0].password_hash = sameKey; users[1].password_hash = sameKey;
  const res = await callLogin({ email: 'dueno@x.cl', password: 'misma-clave-3', organizationId: 10 });
  assert.equal(res.body.data.token, 'tok-1');
  assert.equal(res.body.data.user.organization_id, 10);
  users[0].password_hash = hash; users[1].password_hash = otherHash;
});

test('clave de una empresa no abre la otra cuenta', async () => {
  const res = await callLogin({ email: 'dueno@x.cl', password: 'clave-que-no-existe' });
  assert.equal(res.code, 401);
  assert.equal(res.body.success, false);
});

test('empresa elegida donde la clave no existe responde 401', async () => {
  const res = await callLogin({ email: 'dueno@x.cl', password: 'clave-segura-1', organizationId: 20 });
  assert.equal(res.code, 401);
  assert.equal(res.body.success, false);
});
