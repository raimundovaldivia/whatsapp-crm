const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { load, handler, response } = require('./helpers.cjs');

const token = 'a'.repeat(43);
function fixture(state) {
  return load('src/routes/delivery-tracking.js', {
    '../services/delivery-tracking': {
      TOKEN_PATTERN: /^[A-Za-z0-9_-]{32,96}$/,
      getTrackingStatus: async () => {
        if (state instanceof Error) throw state;
        return state;
      },
    },
  });
}

test('la página antigua conserva privacidad y su script tiene un nonce autorizado', () => {
  const router = fixture();
  const headers = {};
  const res = response();
  res.set = (key, value) => { headers[key] = value; return res; };
  router.stack[0].handle({}, res, () => {});
  handler(router, 'get', '/' + token)({ params: { token } }, res);
  assert.match(headers['Cache-Control'], /no-store/);
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  const nonce = /'nonce-([^']+)'/.exec(headers['Content-Security-Policy'])[1];
  assert.ok(nonce);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  const scripts = [...res.body.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.ok(script[1].includes('nonce="' + nonce + '"'));
  assert.doesNotThrow(() => new vm.Script(scripts[1][2]));
  assert.equal(res.body.includes(token), false);
  const second = response();
  second.set = (key, value) => { if (key === 'Content-Security-Policy') assert.equal(value.includes(nonce), false); return second; };
  handler(router, 'get', '/' + token)({ params: { token } }, second);
});

test('estado público conserva respuestas de activo, cerrado, desconocido y fallo', async () => {
  for (const [state, code] of [[{ active: true, status: 'in_transit' }, 200], [{ active: false, status: 'delivered' }, 410], [null, 404], [new Error('database'), 503]]) {
    const router = fixture(state);
    const res = response();
    await handler(router, 'get', '/' + token + '/status')({ params: { token } }, res);
    assert.equal(res.code, code);
    assert.equal(JSON.stringify(res.body).includes('database'), false);
  }
});
