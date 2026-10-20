const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

const MANUAL_REASON = 'La ruta fue terminada por el administrador sin registrar la entrega';

test('finishing a route closes pending stops like midnight and keeps resolved ones', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }

  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'Diez Ríos','diez-rios'),(2,'Otra','otra');
      INSERT INTO shopify_orders(id,organization_id,shopify_order_id,crm_status,delivered_at,customer_name,customer_phone)
      VALUES(1,1,'1001','entregado',NOW(),'Ana','56911111111'),
            (2,1,'1002','en_camino',NULL,'Beto','56922222222'),
            (3,1,'1003','en_camino',NULL,'Carla','56933333333');
      INSERT INTO delivery_routes(id,organization_id,name,status,orders,stop_statuses,sent_at,started_at) VALUES
        (1,1,'Ruta A','in_progress','[{"source":"shopify","id":"1001"},{"source":"shopify","id":"1002"},{"source":"shopify","id":"1003"}]','{"shopify_1001":"entregado"}',NOW(),NOW()),
        (2,1,'Borrador','draft','[{"source":"shopify","id":"1002"}]','{}',NULL,NULL),
        (3,1,'Cerrada','completed','[{"source":"shopify","id":"1002"}]','{}',NOW(),NOW());
    `);

    const database = { getPool: () => new Pool(), getSetting: async () => null };
    const router = load('src/routes/delivery.js', {
      '../db/database': database,
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../services/push': { pushUser: async () => ({ sent: 1 }) },
    });
    const finish = (overrides) => {
      const res = response();
      return handler(router, 'post', '/routes/:id/finish')({
        orgId: 1, userId: 1, role: 'owner', params: { id: '1' }, body: {}, ...overrides,
      }, res).then(() => res);
    };

    // Otra empresa no puede tocar la ruta.
    const foreign = await finish({ orgId: 2 });
    assert.equal(foreign.code, 404, JSON.stringify(foreign.body));

    // Borrador y ruta ya cerrada no se pueden terminar.
    const draft = await finish({ params: { id: '2' } });
    assert.equal(draft.code, 409, JSON.stringify(draft.body));
    const closed = await finish({ params: { id: '3' } });
    assert.equal(closed.code, 409, JSON.stringify(closed.body));

    // Ruta en curso: dos paradas pendientes, una entregada.
    const done = await finish({});
    assert.equal(done.code, 200, JSON.stringify(done.body));
    assert.equal(done.body.success, true);
    assert.equal(done.body.pendingStops, 2);
    assert.equal(done.body.route.status, 'completed');
    assert.ok(done.body.route.completed_at);

    const stored = (await query('SELECT status, stop_statuses, stop_notes FROM delivery_routes WHERE id=1')).rows[0];
    assert.equal(stored.status, 'completed');
    assert.equal(stored.stop_statuses.shopify_1001, 'entregado');
    assert.equal(stored.stop_statuses.shopify_1002, 'not_delivered');
    assert.equal(stored.stop_statuses.shopify_1003, 'not_delivered');
    assert.equal(stored.stop_notes.shopify_1002, MANUAL_REASON);

    const orders = (await query('SELECT id, crm_status, last_attempt_status, delivery_note, delivered_at FROM shopify_orders ORDER BY id')).rows;
    const delivered = orders.find(o => o.id === 1);
    assert.equal(delivered.crm_status, 'entregado', 'la parada entregada no debe cambiar');
    assert.equal(delivered.delivery_note, null);
    for (const id of [2, 3]) {
      const row = orders.find(o => o.id === id);
      assert.equal(row.crm_status, 'no_entregado');
      assert.equal(row.last_attempt_status, 'sin_resolver');
      assert.equal(row.delivery_note, MANUAL_REASON);
    }

    // Terminar otra vez la misma ruta ya no hace nada.
    const again = await finish({});
    assert.equal(again.code, 409, JSON.stringify(again.body));
  } finally {
    await engine.close?.();
  }
});
