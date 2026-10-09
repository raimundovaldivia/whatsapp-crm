const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

test('history sync preserves local logistics and does not recreate historical dispatches', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const r = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...r, rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
  };
  class Pool {
    async end() {}
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
  }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec("INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b')");
    const db = load('src/db/database.js', { pg: { Pool } });
    const order = (id, fulfillmentStatus = 'FULFILLED') => ({
      id, name: '#' + id, financialStatus: 'PAID', fulfillmentStatus,
      customer: {}, items: [], totalPrice: 100, createdAt: '2025-01-01T12:00:00Z',
    });
    await db.upsertShopifyOrders(1, [order('history'), order('pending', 'UNFULFILLED'),
      order('partial', 'PARTIALLY_FULFILLED'), order('old-open', 'UNFULFILLED'),
      order('old-partial', 'PARTIALLY_FULFILLED'), order('old-scheduled', 'UNFULFILLED'),
      order('old-attempt', 'UNFULFILLED'), order('retry'), order('rescheduled'),
      order('delivered'), order('cancelled'), order('assigned'), order('enroute'), order('refunded')]);
    await db.upsertShopifyOrders(2, [order('other-tenant', 'UNFULFILLED')]);
    await engine.exec(`
      UPDATE shopify_orders SET shopify_created_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 day'
        WHERE shopify_order_id IN ('pending','partial');
      UPDATE shopify_orders SET customer_name='Ana Maria Leiva', customer_phone='56911111111'
        WHERE shopify_order_id IN ('pending','partial','old-open');
      UPDATE shopify_orders SET delivery_date=CURRENT_DATE - 1 WHERE shopify_order_id='old-scheduled';
      UPDATE shopify_orders SET dispatch_count=1,last_attempt_at=NOW() WHERE shopify_order_id='old-attempt';
      UPDATE shopify_orders SET crm_status='no_entregado', dispatch_count=2,
        last_attempt_status='failed', delivery_note='Reintentar' WHERE shopify_order_id='retry';
      UPDATE shopify_orders SET crm_status='por_despachar' WHERE shopify_order_id='rescheduled';
      UPDATE shopify_orders SET crm_status='entregado', delivered_at=NOW(),
        payment_marked_at=NOW(), payment_record_source='manual' WHERE shopify_order_id='delivered';
      UPDATE shopify_orders SET crm_status='cancelled' WHERE shopify_order_id='cancelled';
      UPDATE shopify_orders SET crm_status='asignado_ruta' WHERE shopify_order_id='assigned';
      UPDATE shopify_orders SET crm_status='en_camino' WHERE shopify_order_id='enroute';
      UPDATE shopify_orders SET financial_status='REFUNDED', fulfillment_status='UNFULFILLED'
        WHERE shopify_order_id='refunded';
    `);
    const logistics = () => engine.query(`SELECT shopify_order_id,crm_status,delivered_at,
      delivery_date,delivery_note,dispatch_count,last_attempt_status,payment_marked_at,payment_record_source
      FROM shopify_orders ORDER BY id`);
    const before = (await logistics()).rows;
    await db.upsertShopifyOrders(1, ['history','retry','rescheduled','delivered','cancelled','assigned','enroute'].map(id => order(id)));
    assert.deepEqual((await logistics()).rows, before);
    const router = load('src/routes/delivery.js', {
      '../db/database': { getPool: () => new Pool() },
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    });
    const res = response();
    await handler(router, 'get', '/orders')({ orgId: 1 }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.deepEqual(Array.from(res.body.orders, o => o.id).sort(), ['old-attempt','old-scheduled','rescheduled','retry']);
    assert.equal(res.body.orders.filter(o => o.customerName === 'Ana Maria Leiva').length <= 1, true,
      'historical Shopify purchases must not create repeated delivery stops');
    // Reject a stale browser selection on the server as well.
    for (const id of ['history', 'pending', 'partial', 'old-open', 'old-partial']) {
      const send = response();
      await handler(router, 'post', '/routes')({ orgId: 1, body: {
        send: true, orders: [{ id, source: 'shopify', items: [] }],
      } }, send);
      assert.equal(send.code, 400, JSON.stringify(send.body));
    }
    assert.equal((await engine.query('SELECT COUNT(*)::int AS n FROM delivery_routes')).rows[0].n, 0);
    assert.deepEqual((await logistics()).rows, before, 'filtering must not invent delivery states');
  } finally { await engine.close(); }
});
