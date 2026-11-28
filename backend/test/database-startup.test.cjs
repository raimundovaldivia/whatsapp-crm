const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDatabase } = require('../src/services/database-startup');

test('explicit existing-database deployment never calls schema or business-data setup', async () => {
  await prepareDatabase(() => { throw new Error('Database mutation forbidden'); }, { SKIP_DATABASE_SETUP: '1' });
});

test('normal startup still initializes the database and propagates setup failures', async () => {
  let initialized = false;
  await prepareDatabase(async () => { initialized = true; }, {});
  assert.equal(initialized, true);
  await assert.rejects(prepareDatabase(async () => { throw new Error('Database unavailable'); }, {}), /Database unavailable/);
});

test('existing production databases can read both order lists after an upgrade and a restart', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const { load, handler, response, noop } = require('./helpers.cjs');
  const engine = new PGlite();
  const query = (sql, params) => params?.length ? engine.query(sql, params) : engine.exec(sql).then(results => results.at(-1));
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }
  try {
    const { setupDatabase, ensureDispatchAddressColumns } = load('src/db/setup.js', { pg: { Pool } });
    await setupDatabase();
    await engine.exec(`
      ALTER TABLE contacts DROP COLUMN address_description;
      ALTER TABLE shopify_orders DROP COLUMN shipping_address2, DROP COLUMN shipping_address_description;
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Test', 'test');
      INSERT INTO contacts (organization_id, phone, address2) VALUES (1, '56911111111', 'Casa B');
      INSERT INTO orders (organization_id, customer_name, customer_phone, items) VALUES (1, 'Prueba', '56911111111', '[]');
      INSERT INTO shopify_orders (organization_id, shopify_order_id, customer_name, items)
      VALUES (1, '42', 'Prueba', '[]');
    `);
    const pool = new Pool();
    const orders = load('src/routes/orders.js', {
      '../db/database': load('src/db/database.js', { pg: { Pool } }),
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    });
    async function list(path) {
      const res = response();
      await handler(orders, 'get', path)({ orgId: 1, query: {} }, res);
      return res;
    }
    for (const path of ['/', '/shopify']) {
      const res = await list(path);
      assert.equal(res.code, 500);
      assert.match(res.body.error, /column .*address_description.* does not exist/);
    }
    const start = () => prepareDatabase(() => assert.fail('Must skip full setup'), { SKIP_DATABASE_SETUP: '1' },
      () => ensureDispatchAddressColumns(pool));
    await start();
    await engine.exec("UPDATE shopify_orders SET shipping_address2 = 'Depto. 2'");
    await start();
    for (const path of ['/', '/shopify']) {
      const res = await list(path);
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal((res.body.data || res.body.orders).length, 1);
    }
    assert.equal((await query('SELECT address2 FROM contacts')).rows[0].address2, 'Casa B');
    assert.equal((await query('SELECT shipping_address2 FROM shopify_orders')).rows[0].shipping_address2, 'Depto. 2');
  } finally {
    await engine.close();
  }
});
