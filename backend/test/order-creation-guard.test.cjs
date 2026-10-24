const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const { requestsAdditionalOrder } = require('../src/services/order-creation-policy');
const { persistBotOrder } = require('../src/services/order-creation-policy');

test('another purchase requires explicit customer intent, not coordination, questions or cancellation', () => {
  for (const message of ['Quiero otro pedido igual', 'Necesito hacer un nuevo pedido', 'Hazme otro pedido', 'Quisiera una compra adicional']) {
    assert.equal(requestsAdditionalOrder(message), true, message);
  }
  for (const message of ['Porfi no venga tarde', 'Ya pagué', 'Sí', 'No quiero otro pedido', '¿Hago otro pedido?', 'Cancela el otro pedido', 'Otro pedido']) {
    assert.equal(requestsAdditionalOrder(message), false, message);
  }
});

test('final persistence serializes competing turns, rejects other tenants and rolls back failed inserts', async () => {
  const engine = new PGlite();
  // PGlite has one connection; serialize its transactions just as PostgreSQL's
  // FOR UPDATE serializes callers holding the same conversation row.
  let queue = Promise.resolve();
  const pool = { async connect() {
    const before = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await before;
    return { query: (sql, args) => engine.query(sql, args), release };
  } };
  try {
    await engine.exec(`CREATE TABLE conversations (id INT, organization_id INT);
      CREATE TABLE orders (id SERIAL PRIMARY KEY, organization_id INT, conversation_id INT,
      status TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ,delivery_date DATE);
      INSERT INTO conversations VALUES (933,1);`);
    const guard = { orgId: 1, conversationId: 933 };
    const sql = "INSERT INTO orders(organization_id,conversation_id,status) VALUES($1,$2,'draft') RETURNING *";
    const results = await Promise.allSettled([
      persistBotOrder(pool, guard, sql, [1,933]),
      persistBotOrder(pool, guard, sql, [1,933]),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'ORDER_ALREADY_EXISTS');
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 1);
    await assert.rejects(persistBotOrder(pool, { ...guard, orgId: 2 }, sql, [2,933]), e => e.status === 404);
    await engine.exec("UPDATE orders SET status='cancelled'");
    await assert.rejects(persistBotOrder(pool, guard, 'INSERT INTO nonexistent VALUES(1)', []));
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, 1);
    assert.ok(await persistBotOrder(pool, guard, sql, [1,933]));
  } finally { await engine.close(); }
});

test('atomic database guard protects active orders beyond ten minutes, with tenant isolation and explicit additional purchases', async () => {
  const engine = new PGlite();
  class Pool {
    async query(sql, args) {
      const result = await engine.query(sql, args);
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    }
  }
  const db = load('src/db/database.js', { pg: { Pool } });
  try {
    await engine.exec(`CREATE TABLE conversations (id INT PRIMARY KEY, organization_id INT,
      pipeline_state TEXT, updated_at TIMESTAMPTZ);
      CREATE TABLE orders (id BIGINT PRIMARY KEY, conversation_id INT, organization_id INT,
      status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, delivery_date DATE);
      INSERT INTO conversations VALUES (933,1,'collecting_order',NOW());
      INSERT INTO orders VALUES (450,933,1,'draft',NOW()-INTERVAL '5 hours',NOW()-INTERVAL '5 hours',NULL);`);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1 }), false);
    assert.equal(await db.claimOrderCreation(933, { orgId: 2, additionalOrderId: 450 }), false);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1, additionalOrderId: 999 }), false);
    const claims = await Promise.all([
      db.claimOrderCreation(933, { orgId: 1, additionalOrderId: 450 }),
      db.claimOrderCreation(933, { orgId: 1, additionalOrderId: 450 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    await engine.exec(`INSERT INTO orders VALUES (456,933,1,'draft',NOW(),NOW(),NULL);
      UPDATE conversations SET pipeline_state='collecting_order';`);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1, additionalOrderId: 450 }), false);
    await engine.exec(`DELETE FROM orders WHERE id=456;
      UPDATE orders SET status='entregado',created_at=NOW()-INTERVAL '2 days';`);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1 }), true);
    await engine.exec(`UPDATE conversations SET pipeline_state='collecting_order';
      UPDATE orders SET status='cancelled',created_at=NOW();`);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1 }), true);
    await engine.exec(`UPDATE conversations SET pipeline_state='collecting_order';
      UPDATE orders SET status='en_camino',created_at=NOW()-INTERVAL '30 days',
      updated_at=NOW()-INTERVAL '30 days',delivery_date=CURRENT_DATE+1;`);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1 }), false);
    await engine.exec(`UPDATE orders SET organization_id=2;`);
    assert.equal(await db.claimOrderCreation(933, { orgId: 1 }), true);
  } finally { await engine.close(); }
});
