const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAudienceCatalog, catalogPurchaseMatcher } = require('../src/services/audience-products');

const catalog = [
  { id: 4, title: 'Huevos M · Bandeja de 30', sku: 'M-30' },
  { id: 5, title: 'Huevos XL · Bandeja de 30', sku: 'XL-30' },
  { id: 6, title: 'Queso de cabra' },
  { id: 7, title: 'Bandeja antigua M', active: false, replacement_product_id: 4 },
];

test('una selección múltiple une compras y respeta el calibre e identificadores del catálogo', () => {
  const match = catalogPurchaseMatcher(catalog, ['4', '6']);
  assert.ok(match({ productId: 4, name: 'Título anterior' }, false));
  assert.ok(match({ name: 'QUESO DE CABRA' }, true));
  assert.ok(match({ sku: 'm-30', name: 'Título de Shopify' }, true));
  assert.ok(match({ product_id: 7 }, false));
  assert.ok(match({ title: 'Bandeja antigua M' }, true));
  assert.equal(match({ product_id: 5, name: catalog[0].title }, false), false);
  assert.equal(match({ title: catalog[1].title }, true), false);
  assert.equal(match({ title: 'Combo queso de cabra y huevos M' }, true), false);
  assert.equal(match({ productId: 4, title: 'Otro producto' }, true), false);
  assert.equal(match({ product_id: 4, _deliveryExtra: true }, false), false);
  assert.equal(catalogPurchaseMatcher(catalog, ['999']), null);
});

test('incluye productos inactivos y mayoristas de la organización y admite los ID de Shopify', async () => {
  const db = {
    getSetting: async id => id === 1 ? 'local' : 'shopify',
    getProducts: async (id, onlyActive) => { assert.equal(id, 1); assert.ok(!onlyActive); return catalog; },
    getCachedProducts: async id => {
      assert.equal(id, 2);
      return [{ id: 88, external_id: 'gid://shopify/Product/120', title: 'Manjar', is_business: true }];
    },
  };
  assert.deepEqual(await loadAudienceCatalog(db, 1), catalog);
  const cached = await loadAudienceCatalog(db, 2);
  assert.ok(cached[0].is_business);
  const match = catalogPurchaseMatcher(cached, ['gid://shopify/Product/120']);
  assert.ok(match({ productId: '120' }, true));
});

test('la ruta devuelve cada teléfono una vez al seleccionar varios productos en CRM y Shopify', async () => {
  const { load, handler, response, noop } = require('./helpers.cjs');
  const orders = [
    { customer_phone: '911111111', items: [{ productId: 4 }, { productId: 6 }] },
    { customer_phone: '+56 9 1111 1111', shopify: true, items: JSON.stringify([{ name: 'Queso de cabra' }]) },
    { customer_phone: '922222222', items: [{ productId: 6 }] },
    { customer_phone: '933333333', items: [{ productId: 5 }] },
  ];
  const pool = { query: async (sql, params) => {
    assert.equal(params[0], 1);
    return { rows: sql.includes('UNION ALL') ? orders : [{ count: 4 }] };
  } };
  const db = { getPool: () => pool, getSetting: async () => 'local', getProducts: async () => catalog,
    getPrimaryDataSource: async () => ({ config: { scopes: ['read_all_orders'] } }) };
  const router = load('src/routes/contacts.js', {
    '../db/database': db, '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/audience-products': { loadAudienceCatalog, catalogPurchaseMatcher },
  });
  const res = response();
  await handler(router, 'post', '/by-product')({ orgId: 1, method: 'POST', query: {}, body: { productIds: ['4', '6'] } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(Array.from(res.body.phones), ['56911111111', '56922222222']);
  assert.equal(res.body.historyComplete, true);
});
