// Run from outside the isolated network. Uses only the local forwarded sandbox.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:8080';
async function call(path, token, options = {}) {
  const response = await fetch(base + path, { ...options, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}
async function login(label) {
  const result = await call('/api/auth/login', null, { method: 'POST', body: JSON.stringify({
    email: `owner-${label}@sandbox.invalid`, password: 'Sandbox-Local-Only-2026!',
  }) });
  assert.equal(result.status, 200);
  assert.ok(result.body.data.token);
  return result.body.data.token;
}
async function main() {
  const home = await fetch(base, { signal: AbortSignal.timeout(15000) });
  assert.equal(home.status, 200);
  const health = await call('/sandbox-health');
  assert.equal(health.body.status, 'ready');
  assert.equal(health.body.sandbox, true, 'Refusing to test a server that is not marked sandbox');
  const a = await login('a'), b = await login('b');
  const chatsA = await call('/api/conversations', a), chatsB = await call('/api/conversations', b);
  assert.equal(chatsA.status, 200); assert.equal(chatsB.status, 200);
  const own = chatsA.body.data[0], foreign = chatsB.body.data[0];
  assert.ok(own); assert.ok(foreign); assert.notEqual(own.organization_id, foreign.organization_id);
  const denied = await call(`/api/conversations/${foreign.id}/messages`, a);
  assert.equal(denied.status, 404);
  const sent = await call(`/api/conversations/${own.id}/messages`, a, {
    method: 'POST', body: JSON.stringify({ text: 'Mensaje ficticio de smoke test' }),
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const messages = await call(`/api/conversations/${own.id}/messages`, a);
  assert.ok(messages.body.data.messages.some(m => String(m.whatsapp_message_id).startsWith('sandbox-')));
  // AI is simulated, not merely disabled by absent credentials.
  const assistant = await call('/api/assistant/chat', a, {
    method: 'POST', body: JSON.stringify({ message: 'Hola sandbox', history: [] }),
  });
  assert.equal(assistant.status, 200, JSON.stringify(assistant.body));
  assert.match(assistant.body.response, /SANDBOX/);
  // Export only an ephemeral token for the CI Socket.IO check. No production credentials.
  if (process.env.SANDBOX_SMOKE_TOKEN_FILE) fs.writeFileSync(process.env.SANDBOX_SMOKE_TOKEN_FILE, a, { mode: 0o600 });
  console.log('Sandbox: login, two-tenant isolation, simulated WhatsApp, simulated AI and readiness OK.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
