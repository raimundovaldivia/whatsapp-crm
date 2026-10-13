const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const favorites = require('../src/services/product-favorites');

test('favorites are idempotent and isolated by organization', async () => {
  const db = new PGlite();
  const pool = { query: (...args) => db.query(...args) };
  try {
    await db.exec(`
      CREATE TABLE organizations (id INTEGER PRIMARY KEY);
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        is_business BOOLEAN NOT NULL DEFAULT FALSE
      );
      INSERT INTO organizations VALUES (1), (2);
      INSERT INTO products VALUES (10, 1, TRUE, FALSE), (20, 2, TRUE, FALSE), (30, 1, FALSE, FALSE), (40, 1, TRUE, TRUE);
    `);
    await db.exec(fs.readFileSync(path.join(__dirname, '../src/db/store-product-favorites.sql'), 'utf8'));

    const input = { organizationId: 1, productId: 10, visitorId: 'visitor-123456789', favorite: true };
    assert.deepEqual(await favorites.setProductFavorite(pool, input), { favorite: true, count: 1 });
    assert.deepEqual(await favorites.setProductFavorite(pool, input), { favorite: true, count: 1 });
    assert.equal(await favorites.setProductFavorite(pool, { ...input, productId: 20 }), null);
    assert.equal(await favorites.setProductFavorite(pool, { ...input, productId: 30 }), null);
    assert.equal(await favorites.setProductFavorite(pool, { ...input, productId: 40 }), null);
    assert.deepEqual([...await favorites.getFavoriteCounts(pool, 1)], [[10, 1]]);
    assert.deepEqual([...await favorites.getFavoriteCounts(pool, 2)], []);

    assert.deepEqual(await favorites.setProductFavorite(pool, { ...input, favorite: false }), { favorite: false, count: 0 });
    assert.deepEqual([...await favorites.getFavoriteCounts(pool, 1)], []);
  } finally {
    await db.close();
  }
});

test('favorite input rejects malformed public data before SQL', () => {
  assert.throws(() => favorites.favoriteInput('x', 'visitor-123456789', true), /Producto inválido/);
  assert.throws(() => favorites.favoriteInput(1, 'short', true), /visitante inválido/);
  assert.throws(() => favorites.favoriteInput(1, 'visitor-123456789', 'true'), /favorito inválido/);
});
