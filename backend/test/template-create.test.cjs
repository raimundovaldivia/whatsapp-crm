const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');
const templateRenderer = require('../src/utils/template-renderer.mjs');

function loadRoute(calls) {
  return load('src/routes/templates.js', {
    '../db/database': {
      getWhatsappConfig: async () => ({ kapso_api_key: 'key', business_account_id: 'waba' }),
    },
    '../services/kapso-whatsapp': {},
    '../middleware/auth': { requireAuth: noop },
    '../utils/template-renderer.mjs': templateRenderer,
    axios: {
      post: async (_url, payload) => {
        calls.push(payload);
        return { data: { id: 'template-1', status: 'PENDING' } };
      },
    },
  });
}

test('crear template conserva exactamente cuerpo y muestras multilínea', async () => {
  const calls = [];
  const router = loadRoute(calls);
  const req = {
    orgId: 1,
    body: {
      name: 'promo_multilinea',
      language: 'es',
      category: 'MARKETING',
      body: '  Hola {{2}}\nPrecio: {{1}}  ',
      varSamples: { 1: ' $12.990 🥚 ', 2: 'Ana\nMaría' },
    },
  };
  const res = response();

  await handler(router, 'post', '/')(req, res);

  assert.equal(res.code, 200);
  const body = calls[0].components.find(component => component.type === 'BODY');
  assert.equal(body.text, req.body.body);
  assert.deepEqual(body.example.body_text[0], [' $12.990 🥚 ', 'Ana\nMaría']);
});

test('crear template informa exactamente qué variables faltan', async () => {
  const calls = [];
  const router = loadRoute(calls);
  const req = {
    orgId: 1,
    body: {
      name: 'promo_incompleta',
      language: 'es',
      category: 'MARKETING',
      body: 'Hola {{1}} {{4}}',
      varSamples: { 1: 'Ana' },
    },
  };
  const res = response();

  await handler(router, 'post', '/')(req, res);

  assert.equal(res.code, 400);
  assert.match(res.body.error, /\{\{4\}\}/);
  assert.equal(calls.length, 0);
});
