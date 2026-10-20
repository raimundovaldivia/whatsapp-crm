const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('encuentra el pedido entregado en otra conversación del mismo teléfono sin cruzar organizaciones', async () => {
  const engine = new PGlite();
  const query = async (sql, params = []) => {
    const result = params.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }

  try {
    await engine.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        phone_number TEXT
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        conversation_id INTEGER NOT NULL,
        customer_phone TEXT,
        status TEXT,
        items TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO conversations(id, organization_id, phone_number) VALUES
        (1, 10, '+56 9 1234 5678'),
        (2, 10, '912345678'),
        (3, 20, '56912345678');
      INSERT INTO orders(id, organization_id, conversation_id, customer_phone, status, items, updated_at) VALUES
        (101, 10, 2, '56 9 1234 5678', 'entregado', '[{"title":"Huevos Jumbo"}]', CURRENT_TIMESTAMP),
        (202, 20, 3, '56912345678', 'entregado', '[{"title":"No debe cruzarse"}]', CURRENT_TIMESTAMP + INTERVAL '1 minute');
    `);
    const db = load('src/db/database.js', { pg: { Pool } });

    const order = await db.getRecentDeliveredOrder(1, 7);
    assert.equal(order.id, 101);
    assert.equal(order.organization_id, 10);
    assert.match(order.items, /Huevos Jumbo/);
  } finally {
    await engine.close();
  }
});
