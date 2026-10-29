const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');
const { loadBotCatalog } = require('../src/services/bot-catalog');
const agent = load('src/services/agents/orders.js', { '../ai-provider': {} });
const product = { id: 7, title: 'Huevos Extra de color · Caja de 180', price: 44900, stock: 10 };
const draft = { customer_name: 'Prueba', address: 'Calle 123', city: 'La Serena', items: [{ product_name: product.title, quantity: 1 }] };

function fixture({ products = [product], settings = {}, permitted = ['sales_ai'] } = {}) {
  const writes = [], extractions = [];
  const db = {
    getSetting: async (_org, key) => settings[key] ?? (key === 'catalog_source' ? 'local' : null),
    setSetting: async (...args) => writes.push(args),
    getPrimaryDataSource: async () => null,
    getProducts: async (org, active) => { assert.equal(org, 2); assert.equal(active, true); return products; },
    getCachedProducts: async () => { throw Error('No usar caché para catálogo local'); },
    createOrder: async () => assert.fail('El simulador no debe crear pedidos'),
  };
  const router = load('src/routes/settings.js', {
    '../db/database': db,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/commercial': { permitted: async (_org, key) => permitted.includes(key) },
    '../services/shopify-api': { formatProductsForAI: products => products.map(p => p.title).join('\n') },
    '../services/agents/orders': {
      ...agent,
      extractOrderData: async (history, previous) => { extractions.push(history); return { ...previous, ...draft }; },
      generateOrderResponse: async () => 'ORDEN_CONFIRMADA',
    },
  });
  const invoke = async (method, path, body = {}) => {
    const res = response();
    await handler(router, method, path)({ orgId: 2, body }, res);
    return res;
  };
  return { invoke, writes, extractions, db };
}

test('el simulador usa catálogo local, incluye el mensaje actual y exige revisar antes de confirmar', async () => {
  const f = fixture();
  const first = await f.invoke('post', '/test-bot', { message: 'Una caja', pipelineState: 'collecting_order', orderDraft: draft });
  assert.equal(first.code, 200);
  assert.equal(first.body.newState, 'collecting_order');
  assert.match(first.body.response, /44.900/);
  assert.equal(f.extractions[0].at(-1).content, 'Una caja');
  const second = await f.invoke('post', '/test-bot', { message: 'Sí, confirmo el pedido', pipelineState: 'collecting_order', orderDraft: first.body.orderDraft, history: [{ role: 'bot', content: first.body.response }] });
  assert.equal(second.body.newState, 'test_complete');
  assert.match(second.body.response, /pedido no guardado ni enviado/);
  assert.doesNotMatch(second.body.response, /undefined/);
  assert.equal(f.writes.length, 0);
});

test('simulador no cierra con catálogo vacío ni con ventas pausadas', async () => {
  for (const options of [{ products: [] }, { settings: { bot_sales_enabled: 'false' } }]) {
    const f = fixture(options);
    const result = await f.invoke('post', '/test-bot', { message: 'Sí, confirmo el pedido', pipelineState: 'collecting_order', orderDraft: draft });
    assert.equal(result.body.newState, 'collecting_order');
    assert.match(result.body.response, /catálogo actual|pendientes de habilitación/);
  }
});

test('condiciones de reparto pertenecen al bot sin abrir funciones logísticas', async () => {
  const f = fixture();
  const result = await f.invoke('post', '/delivery-info', { schedule: 'Lunes de 10 a 18', zone: 'La Serena', paymentMethods: 'Efectivo' });
  assert.equal(result.code, 200);
  assert.equal(f.writes[0][0], 2);
  assert.equal(f.writes[0][1], 'delivery_info');
  const blocked = fixture({ permitted: [] });
  assert.equal((await blocked.invoke('post', '/delivery-info', {})).code, 403);
  assert.equal(blocked.writes.length, 0);
  assert.equal((await f.invoke('post', '/delivery-info', { schedule: {} })).code, 400);
});

test('configuración rechaza falsos booleanos antes de escribir y muestra pendientes', async () => {
  const f = fixture({ products: [] });
  assert.equal((await f.invoke('put', '/', { ai_enabled_global: 'false' })).code, 400);
  assert.equal(f.writes.length, 0);
  const readiness = await f.invoke('get', '/bot-readiness');
  assert.equal(readiness.body.activeProducts, 0);
  assert.ok(readiness.body.warnings.length >= 3);
});

test('catálogo local vacío sigue vacío aunque exista un catálogo externo antiguo', async () => {
  const f = fixture({ products: [] });
  assert.deepEqual(await loadBotCatalog(f.db, 2), []);
});

test('el agente de pedidos recibe las condiciones de la tienda', async () => {
  let prompt;
  const orders = load('src/services/agents/orders.js', {
    '../ai-provider': {
      client: { messages: { create: async input => { prompt = input.system; return {}; } } },
      modelFor: () => 'test', responseText: () => '¿Tu nombre?',
    },
  });
  await orders.generateOrderResponse([], 'Quiero pedir', {}, product.title, '', 'Justo Casero: solo efectivo o transferencia.');
  assert.match(prompt, /Justo Casero: solo efectivo o transferencia/);
});
