const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGateway } = require('./gateway.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('QA protects static files, APIs and upgrades while preserving CRM Bearer authentication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-qa-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>QA TEST</html>');
  const backend = http.createServer((req, res) => res.end(JSON.stringify({ authorization: req.headers.authorization, cookie: req.headers.cookie })));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const password = 'test-password-with-at-least-24-characters';
  const gateway = createGateway({ password, root, upstream: 'http://127.0.0.1:' + backend.address().port });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + gateway.address().port;
  try {
    for (const route of ['/', '/api/orders', '/store/sandbox-a', '/assets/app.js', '/socket.io/']) {
      assert.equal((await fetch(url + route)).status, 401);
    }
    assert.equal((await fetch(url + '/qa-health')).status, 200);
    const login = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('qa:' + password).toString('base64') } });
    assert.match(await login.text(), /QA TEST/);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
    const api = await fetch(url + '/api/orders', { headers: { Cookie: cookie.split(';')[0], Authorization: 'Bearer crm-token' } });
    assert.deepEqual(await api.json(), { authorization: 'Bearer crm-token' });
    const rejected = await fetch(url + '/api/orders', { headers: { Cookie: 'crm_qa_access=incorrect', Authorization: 'Bearer crm-token' } });
    assert.equal(rejected.status, 401);
    const upgrade = await new Promise((resolve, reject) => {
      const request = http.request(url + '/socket.io/', { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
      request.on('response', res => { res.resume(); resolve(res.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(upgrade, 401);
  } finally {
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    fs.rmSync(root, { recursive: true });
  }
});
