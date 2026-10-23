import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionGuard } from './session-guard.mjs';

test('a store change blocks old forms and pending responses before navigation', () => {
  let stored = 'store-a-token';
  const guard = createSessionGuard({ getItem: () => stored });
  assert.equal(guard.token(), 'store-a-token');
  assert.equal(guard.accepts('store-a-token'), true);
  stored = 'store-b-token';
  assert.equal(guard.isCurrent(), false);
  assert.equal(guard.accepts('store-a-token'), false);
  assert.throws(() => guard.token(), { code: 'SESSION_CHANGED' });
});

test('verification and logout reject old responses without invalidating the new session', () => {
  let stored = 'old-token';
  const guard = createSessionGuard({ getItem: () => stored });
  stored = 'verified-token'; guard.adopt(stored);
  assert.equal(guard.token(), 'verified-token');
  assert.equal(guard.accepts('old-token'), false);
  assert.equal(guard.accepts('verified-token'), true);
  stored = null; guard.adopt(null);
  assert.equal(guard.token(), null);
  assert.equal(guard.accepts('verified-token'), false);
});
