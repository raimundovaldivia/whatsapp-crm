const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { load, handler, response } = require('./helpers.cjs');

const password = 'fixture-only-password';
const otherPassword = 'fixture-other-password';
const hash = bcrypt.hashSync(password, 4);
const otherHash = bcrypt.hashSync(otherPassword, 4);

function fixture() {
  const users = [
    { id: 1, organization_id: 10, email: 'owner@example.test', name: 'Owner', role: 'owner', auth_version: 0, password_hash: hash },
    { id: 2, organization_id: 20, email: 'owner@example.test', name: 'Owner', role: 'agent', auth_version: 0, password_hash: hash },
    { id: 3, organization_id: 30, email: 'owner@example.test', name: 'Owner', role: 'admin', auth_version: 0, password_hash: otherHash },
    { id: 4, organization_id: 40, email: 'someone@example.test', name: 'Someone', role: 'owner', auth_version: 0, password_hash: hash },
  ];
  const db = {
    getUsersByEmail: async email => users.filter(user => user.email === email),
    getUserById: async id => users.find(user => user.id === id),
    getOrgById: async id => ({ id, name: `Store ${id}`, slug: `store-${id}`, setup_done: true }),
  };
  const auth = load('src/middleware/auth.js', { '../db/database': db });
  const router = load('src/routes/auth.js', { bcryptjs: bcrypt, '../db/database': db, '../middleware/auth': auth });
  const call = async (method, path, body = {}, token) => {
    const req = { body, method: method.toUpperCase(), path, originalUrl: `/api/auth${path}`, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = response();
    if (path !== '/login') {
      let passed = false;
      await auth.requireAuth(req, res, () => { passed = true; });
      if (!passed) return res;
    }
    await handler(router, method, path)(req, res);
    return res;
  };
  const login = async () => (await call('post', '/login', { email: ' owner@example.test ', password, organizationId: 10 })).body.data.token;
  return { users, auth, call, login };
}

test('switches only among credential-verified stores and keeps the destination role and original expiry', async () => {
  const { call, login, auth } = fixture();
  const token = await login();
  const options = await call('get', '/organizations', {}, token);
  assert.deepEqual(Array.from(options.body.data.organizations, org => org.organization_id), [10, 20]);
  const switched = await call('post', '/switch-organization', { organizationId: 20, role: 'owner', accounts: [{ orgId: 30 }] }, token);
  assert.equal(switched.body.data.user.role, 'agent');
  assert.equal(switched.body.data.organization.id, 20);
  const destination = await auth.authenticateToken(switched.body.data.token);
  assert.equal(destination.organization_id, 20);
  assert.equal(destination.role, 'agent');
  assert.equal(jwt.decode(switched.body.data.token).exp, jwt.decode(token).exp);
  const back = await call('post', '/switch-organization', { organizationId: 10 }, switched.body.data.token);
  assert.equal(back.body.data.organization.id, 10);
  assert.equal(jwt.decode(back.body.data.token).exp, jwt.decode(token).exp);
  assert.equal((await call('post', '/switch-organization', { organizationId: 30 }, token)).code, 403);
  assert.equal((await call('post', '/switch-organization', { organizationId: 40 }, token)).code, 403);
});

test('invalid, missing and tampered authentication cannot list or switch stores', async () => {
  const { call, login } = fixture();
  assert.equal((await call('get', '/organizations')).code, 401);
  const token = await login();
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...jwt.decode(token), orgId: 40 })).toString('base64url');
  assert.equal((await call('get', '/organizations', {}, parts.join('.'))).code, 401);
  for (const organizationId of ['20', 0, -1, 1.5, null, {}, [20]]) {
    assert.equal((await call('post', '/switch-organization', { organizationId }, token)).code, 400);
  }
});

test('revoked, deleted, reassigned or changed-role destination accounts are removed and cannot be selected', async () => {
  for (const change of [user => { user.auth_version++; }, user => { user.role = 'owner'; }, user => { user.email = 'changed@example.test'; }, user => { user.organization_id = 99; }, user => { user.id = 99; }]) {
    const { users, call, login } = fixture();
    const token = await login();
    change(users[1]);
    assert.equal((await call('post', '/switch-organization', { organizationId: 20 }, token)).code, 403);
    assert.equal((await call('get', '/organizations', {}, token)).body.data.organizations.length, 1);
  }
  const { users, call, login } = fixture();
  const token = await login(); users[0].auth_version++;
  assert.equal((await call('post', '/switch-organization', { organizationId: 20 }, token)).code, 401);
});

test('old single-store sessions can verify stores once without logout or extending expiry', async () => {
  const { auth, call } = fixture();
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = jwt.sign({ userId: 1, orgId: 10, role: 'owner', authVersion: 0, exp }, auth.JWT_SECRET);
  assert.equal((await call('get', '/organizations', {}, token)).body.data.organizations.length, 1);
  assert.equal((await call('post', '/switch-organization', { organizationId: 20 }, token)).code, 403);
  assert.equal((await call('post', '/verify-organizations', { password: 'wrong' }, token)).code, 403);
  const verified = await call('post', '/verify-organizations', { password }, token);
  assert.equal(verified.body.data.organizations.length, 2);
  assert.equal(jwt.decode(verified.body.data.token).exp, exp);
  assert.equal((await call('post', '/switch-organization', { organizationId: 20 }, verified.body.data.token)).body.data.organization.id, 20);
});

test('another password can authorize another store with the same email, while preserving verified stores', async () => {
  const { call, login } = fixture();
  const token = await login();
  const linked = await call('post', '/verify-organizations', { password: otherPassword, email: 'someone@example.test' }, token);
  assert.deepEqual(Array.from(linked.body.data.organizations, org => org.organization_id), [10, 20, 30]);
  assert.equal((await call('post', '/switch-organization', { organizationId: 30 }, linked.body.data.token)).body.data.organization.id, 30);
  assert.equal((await call('post', '/switch-organization', { organizationId: 40 }, linked.body.data.token)).code, 403);
  for (const password of [null, {}, [], '', 'x'.repeat(129)]) {
    assert.equal((await call('post', '/verify-organizations', { password }, token)).code, 400);
  }
});

test('expired sessions cannot extend their access through verification or switching', async () => {
  const { auth, users, call } = fixture();
  const expired = auth.generateToken(users[0], { accounts: users.slice(0, 2), expiresAt: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await call('post', '/verify-organizations', { password }, expired)).code, 401);
  assert.equal((await call('post', '/switch-organization', { organizationId: 20 }, expired)).code, 401);
});
