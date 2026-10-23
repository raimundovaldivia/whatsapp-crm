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
    for (const route of ['/api/orders', '/store/sandbox-a', '/socket.io/']) {
      assert.equal((await fetch(url + route)).status, 401);
    }
    for (const route of ['/', '/assets/app.js']) {
      const page = await fetch(url + route, { redirect: 'manual' });
      assert.equal(page.status, 303);
      assert.equal(page.headers.get('location'), '/qa-login');
      assert.equal(page.headers.get('www-authenticate'), null);
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

test('HTML login validates credentials, creates a protected cookie and preserves API Bearer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-qa-form-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>QA PRIVATE APP</html>');
  const backend = http.createServer((req, res) => res.end(JSON.stringify({ authorization: req.headers.authorization, cookie: req.headers.cookie })));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const password = 'synthetic-test-password-at-least-24-characters';
  const gateway = createGateway({ password, root, upstream: 'http://127.0.0.1:' + backend.address().port, secure: false });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + gateway.address().port;
  let csrf, formCookie;
  const submit = values => fetch(url + '/qa-login', { method: 'POST', redirect: 'manual', headers: { Origin: 'null', Cookie: formCookie }, body: new URLSearchParams({csrf,...values}) });
  try {
    const form = await fetch(url + '/qa-login');
    const html = await form.text();
    csrf = html.match(/name="csrf" value="([a-f0-9.]+)"/)[1];
    formCookie = form.headers.get('set-cookie').split(';')[0];
    assert.equal(form.status, 200);
    assert.equal(form.headers.get('www-authenticate'), null);
    assert.match(form.headers.get('content-security-policy'), /form-action 'self'/);
    assert.match(html, /name="username"/); assert.match(html, /name="password"/);
    assert.ok(!html.includes(password)); assert.ok(!html.includes('QA PRIVATE APP'));
    for (const values of [{username:'qa',password:'wrong'}, {username:'other',password}]) {
      const rejected = await submit(values);
      assert.equal(rejected.status, 401); assert.ok(!rejected.headers.get('set-cookie')?.includes('crm_qa_access='));
      assert.match(await rejected.text(), /Usuario o contraseña incorrectos/);
    }
    assert.equal((await submit({username:'qa',password,csrf:'forged'})).status, 403);
    const withoutCookie = await fetch(url + '/qa-login', {method:'POST',body:new URLSearchParams({username:'qa',password,csrf}),redirect:'manual'});
    assert.equal(withoutCookie.status,403);
    assert.equal((await fetch(url + '/qa-login', { method:'POST', headers:{Origin:url}, body:'plain' })).status, 415);
    const result = await submit({username:'qa',password});
    assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/');
    const cookie = result.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.ok(!cookie.includes(password));
    const headers = { Cookie: cookie.split(';')[0], Authorization:'Bearer crm-token' };
    assert.match(await (await fetch(url, {headers})).text(), /QA PRIVATE APP/);
    assert.deepEqual(await (await fetch(url+'/api/orders', {headers})).json(), {authorization:'Bearer crm-token'});
    assert.equal((await fetch(url+'/api/orders', {headers:{Authorization:'Bearer crm-token'}})).status, 401);
    for (let i=0;i<20;i++) assert.equal((await submit({username:'qa',password:'wrong'})).status,401);
    const limited = await submit({username:'qa',password});
    assert.equal(limited.status,429); assert.equal(limited.headers.get('retry-after'),'60');
  } finally {
    await Promise.all([new Promise(resolve=>gateway.close(resolve)), new Promise(resolve=>backend.close(resolve))]);
    fs.rmSync(root, {recursive:true});
  }
});
