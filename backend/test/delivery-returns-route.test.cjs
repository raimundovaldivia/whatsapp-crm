const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

test('a scheduled exchange becomes a real route stop and keeps inventory review visible', async () => {
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
      INSERT INTO organizations(id,name,slug) VALUES(1,'Diez Ríos','diez-rios');
      INSERT INTO users(id,organization_id,email,password_hash,name,role)
      VALUES(2,1,'driver@test.cl','x','Luis Fernando','repartidor');
      INSERT INTO order_returns(
        id,organization_id,source,order_id,kind,status,items,customer,reason,
        replacement_description,pickup_required,money_direction,money_method,
        money_amount,driver_user_id,scheduled_date,created_by,request_key,events
      ) VALUES(
        1,1,'bot','247','exchange','scheduled',
        '[{"index":0,"quantity":1,"name":"Queso de Cabra"}]',
        '{"name":"Verónica","phone":"56900000000","address":"Juan Pablo II 917, La Serena"}',
        'Disconformidad','Queso fresco blanco',TRUE,'none','none',0,2,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date,2,'return-route-test','[]'
      );
    `);

    const database = { getPool: () => new Pool(), getSetting: async () => null };
    const router = load('src/routes/delivery.js', {
      '../db/database': database,
      '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../services/push': { pushUser: async () => ({ sent: 1 }) },
    });

    const listed = response();
    await handler(router, 'get', '/orders')({ orgId: 1, query: {} }, listed);
    assert.equal(listed.code, 200, JSON.stringify(listed.body));
    const stop = listed.body.orders.find(row => row.source === 'return');
    assert.ok(stop, 'the exchange must be selectable as a route stop');
    assert.equal(stop.isReturn, true);
    assert.match(stop.orderName, /CAMBIO/);
    assert.equal(stop.items.some(item => item.loadItem === false && item.name.startsWith('Retirar:')), true);
    assert.equal(stop.items.some(item => item.loadItem === true && item.name.startsWith('Entregar:')), true);

    const created = response();
    await handler(router, 'post', '/routes')({
      orgId: 1, userId: 1, role: 'owner',
      body: { name: 'Ruta devoluciones', orders: [stop], optimizedRoute: [stop], driverUserId: 2, send: true },
    }, created);
    assert.equal(created.code, 200, JSON.stringify(created.body));
    const routeId = created.body.route.id;
    let storedReturn = (await query('SELECT status,route_id,driver_user_id FROM order_returns WHERE id=1')).rows[0];
    assert.equal(storedReturn.status, 'scheduled');
    assert.equal(storedReturn.route_id, routeId);
    assert.equal(storedReturn.driver_user_id, 2);

    await query(`UPDATE delivery_routes SET load_checklist=$1::jsonb WHERE id=$2`, [JSON.stringify({ 'Entregar: Queso fresco blanco': true }), routeId]);
    const started = response();
    await handler(router, 'patch', '/routes/1/start')({
      orgId: 1, userId: 2, role: 'repartidor', params: { id: String(routeId) }, body: {},
    }, started);
    assert.equal(started.code, 200, JSON.stringify(started.body));
    assert.equal((await query('SELECT status FROM order_returns WHERE id=1')).rows[0].status, 'in_progress');

    const completed = response();
    await handler(router, 'patch', '/routes/1/stops')({
      orgId: 1, userId: 2, role: 'repartidor', params: { id: String(routeId) },
      body: { stopKey: 'return_1', status: 'entregado', paymentMethod: 'otro' },
    }, completed);
    assert.equal(completed.code, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.routeStatus, 'completed');
    storedReturn = (await query('SELECT status,inventory_status FROM order_returns WHERE id=1')).rows[0];
    assert.equal(storedReturn.status, 'resolved');
    assert.equal(storedReturn.inventory_status, 'pending_review');
    const storedRoute = (await query('SELECT status,stop_statuses FROM delivery_routes WHERE id=$1', [routeId])).rows[0];
    assert.equal(storedRoute.status, 'completed');
    assert.equal(storedRoute.stop_statuses.return_1, 'entregado');

    // La pantalla especial de Cambios y devoluciones debe sincronizar la misma
    // parada, porque las versiones nuevas de la app abren ese flujo dedicado.
    await engine.exec(`
      INSERT INTO order_returns(
        id,organization_id,source,order_id,kind,status,items,customer,reason,
        replacement_description,pickup_required,money_direction,money_method,
        money_amount,driver_user_id,scheduled_date,created_by,request_key,events
      ) VALUES(
        2,1,'bot','248','exchange','scheduled',
        '[{"index":0,"quantity":1,"name":"Queso de Cabra"}]',
        '{"name":"Segunda cliente","phone":"56900000001","address":"Avenida del Mar 100, La Serena"}',
        'Cambio programado','Queso fresco blanco',TRUE,'none','none',0,2,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date,2,'return-route-test-2','[]'
      );
    `);
    const secondList = response();
    await handler(router, 'get', '/orders')({ orgId: 1, query: {} }, secondList);
    const secondStop = secondList.body.orders.find(row => row.source === 'return' && row.id === '2');
    const secondRoute = response();
    await handler(router, 'post', '/routes')({
      orgId: 1, userId: 1, role: 'owner',
      body: { name: 'Segunda ruta', orders: [secondStop], optimizedRoute: [secondStop], driverUserId: 2, send: true },
    }, secondRoute);
    assert.equal(secondRoute.code, 200, JSON.stringify(secondRoute.body));
    const secondRouteId = secondRoute.body.route.id;
    await query('UPDATE delivery_routes SET load_checklist=$1::jsonb WHERE id=$2', [JSON.stringify({ 'Entregar: Queso fresco blanco': true }), secondRouteId]);
    const secondStart = response();
    await handler(router, 'patch', '/routes/1/start')({
      orgId: 1, userId: 2, role: 'repartidor', params: { id: String(secondRouteId) }, body: {},
    }, secondStart);
    assert.equal(secondStart.code, 200, JSON.stringify(secondStart.body));

    const returnsRouter = load('src/routes/order-returns.js', {
      '../db/database': database,
      '../middleware/auth': { requireRole: () => noop },
    });
    const completedFromReturns = response();
    await handler(returnsRouter, 'post', '/2/actions')({
      orgId: 1, userId: 2, role: 'repartidor', params: { id: '2' },
      body: { action: 'complete', pickedUp: true, replaced: true },
    }, completedFromReturns);
    assert.equal(completedFromReturns.code, 200, JSON.stringify(completedFromReturns.body));
    const syncedRoute = (await query('SELECT status,stop_statuses FROM delivery_routes WHERE id=$1', [secondRouteId])).rows[0];
    assert.equal(syncedRoute.status, 'completed');
    assert.equal(syncedRoute.stop_statuses.return_2, 'entregado');
    assert.equal(completedFromReturns.body.case.inventory_status, 'pending_review');
  } finally {
    await engine.close();
  }
});
