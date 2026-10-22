import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackendUrl } from './backend-url.js';
test('sandbox uses the forwarded HTTPS origin, production URL and local default stay unchanged', () => {
  assert.equal(resolveBackendUrl('same-origin', 'https://workspace-8080.app.github.dev'), 'https://workspace-8080.app.github.dev');
  assert.equal(resolveBackendUrl('https://api.example'), 'https://api.example');
  assert.equal(resolveBackendUrl(undefined), 'http://localhost:3001');
  assert.throws(() => resolveBackendUrl('same-origin', 'file://fixture'));
});
