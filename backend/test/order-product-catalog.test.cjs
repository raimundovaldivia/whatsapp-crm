const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { getOrderProductCatalog, phoneVariants } = require('../src/services/order-product-catalog');

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE contacts (
      organization_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      client_type TEXT NOT NULL DEFAULT 'personal',
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE products (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      price NUMERIC NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      deprecated_at TIMESTAMP,
      is_business BOOLEAN DEFAULT FALSE,
      position INTEGER DEFAULT 0
    );
    CREATE TABLE contact_price_overrides (
      organization_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      product_id TEXT NOT NULL,
      custom_price NUMERIC NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    INSERT INTO contacts (organization_id, phone, client_type) VALUES
      (1, '56911111111', 'personal'),
      (1, '56922222222', 'empresa'),
      (1, '56933333333', 'empresa'),
      (1, '56944444444', 'empresa'),
      (2, '56922222222', 'personal');

    INSERT INTO products (id, organization_id, title, price, active, deprecated_at, is_business, position) VALUES
      (1, 1, 'Producto particular', 1000, TRUE, NULL, FALSE, 1),
      (2, 1, 'Producto empresa', 2000, TRUE, NULL, TRUE, 2),
      (3, 1, 'Legacy activo', 3000, TRUE, NOW(), FALSE, 3),
      (4, 1, 'Producto inactivo', 4000, FALSE, NULL, FALSE, 4),
      (5, 2, 'Producto de otra organización', 5000, TRUE, NULL, FALSE, 1);

    INSERT INTO contact_price_overrides (organization_id, phone, product_id, custom_price) VALUES
      (1, '56922222222', '1', 750),
      (1, '56922222222', '3', 600),
      (1, '56944444444', '3', 500),
      (2, '56922222222', '5', 100);
  `);
  return db;
}

test('el catálogo particular queda aislado por organización y excluye legacy, inactivos y B2B', async () => {
  const db = await fixture();
  try {
    const products = await getOrderProductCatalog(db, 1, '+56 9 1111 1111');
    assert.deepEqual(products.map(product => product.id), [1]);
    assert.equal(products[0].price, '1000');
    assert.equal(products[0].special_price, false);
  } finally {
    await db.close();
  }
});

test('una empresa con precios asignados recibe solo sus productos vigentes y su precio', async () => {
  const db = await fixture();
  try {
    const products = await getOrderProductCatalog(db, 1, '9 2222 2222');
    assert.deepEqual(products.map(product => product.id), [1]);
    assert.equal(products[0].price, '750');
    assert.equal(products[0].special_price, true);
  } finally {
    await db.close();
  }
});

test('una empresa sin precios asignados recibe el catálogo empresa vigente', async () => {
  const db = await fixture();
  try {
    const products = await getOrderProductCatalog(db, 1, '56933333333');
    assert.deepEqual(products.map(product => product.id), [2]);
  } finally {
    await db.close();
  }
});

test('un precio legacy no impide usar el catálogo empresa vigente', async () => {
  const db = await fixture();
  try {
    const products = await getOrderProductCatalog(db, 1, '56944444444');
    assert.deepEqual(products.map(product => product.id), [2]);
  } finally {
    await db.close();
  }
});

test('las variantes de teléfono no incluyen valores vacíos ni pierden el número canónico', () => {
  assert.deepEqual(phoneVariants('+56 9 2222 2222'), ['56922222222', '922222222', '+56922222222']);
  assert.deepEqual(phoneVariants(''), []);
  assert.throws(() => phoneVariants('cliente-desconocido'), /inválido/);
});
