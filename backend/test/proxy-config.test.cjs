const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configureTrustProxy, resolveTrustProxy } = require('../src/services/proxy-config');

test('production trusts exactly the Railway-facing proxy by default', () => {
  const calls = [];
  const app = { set: (...args) => calls.push(args) };

  assert.equal(configureTrustProxy(app, { isProduction: true }), 1);
  assert.deepEqual(calls, [['trust proxy', 1]]);
});

test('local development stays direct and an explicit hop count is validated', () => {
  assert.equal(resolveTrustProxy(false), false);
  assert.equal(resolveTrustProxy(true, '2'), 2);
  assert.throws(() => resolveTrustProxy(true, 'all'));
  assert.throws(() => resolveTrustProxy(true, '0'));
});
