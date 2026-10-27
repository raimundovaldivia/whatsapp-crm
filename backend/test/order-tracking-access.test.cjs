const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('mapa de consulta: sesiones existentes, SQL real, aislamiento, cierre y vencimiento', async t => {
  const engine = new PGlite();
  const service = load('src/services/delivery-tracking.js', { '../db/database': { getPool: () => engine } });
  try {
    await engine.exec(`
      CREATE TABLE delivery_routes(id int PRIMARY KEY, organization_id int, status text, orders jsonb,
        optimized_route jsonb, stop_statuses jsonb);
      CREATE TABLE orders(id int, organization_id int, status text, delivered_at timestamptz);
      CREATE TABLE shopify_orders(shopify_order_id text, organization_id int, crm_status text, delivered_at timestamptz);
      INSERT INTO orders VALUES (1,1,'en_camino',NULL),(1,2,'entregado',NOW());
      INSERT INTO shopify_orders VALUES ('10000',1,'en_camino',NULL);
      CREATE TABLE delivery_tracking_sessions(id serial PRIMARY KEY, organization_id int, route_id int,
        stop_key text, token_hash text UNIQUE, expires_at timestamptz, revoked_at timestamptz,
        latitude float, longitude float, accuracy_m float, location_updated_at timestamptz, updated_at timestamptz);
      INSERT INTO delivery_routes VALUES (10,1,'in_progress','[{"source":"bot","id":1},{"source":"shopify","id":"10000"}]','[]','{}'),
        (20,2,'in_progress','[{"source":"bot","id":1}]','[]','{}');
    `);
    const reset = async () => {
      await engine.exec(`DELETE FROM delivery_tracking_sessions;
        UPDATE delivery_routes SET status='in_progress', stop_statuses='{}', optimized_route='[]';
        INSERT INTO delivery_tracking_sessions(organization_id,route_id,stop_key,token_hash,expires_at,latitude,longitude,accuracy_m,location_updated_at)
        VALUES (1,10,'bot_1','source',NOW()+INTERVAL '30 minutes',-29.95,-71.34,10,NOW()),
          (2,20,'bot_1','foreign',NOW()+INTERVAL '1 hour',-33.45,-70.66,15,NOW());`);
    };
    await t.test('copia ubicación de la misma ruta, guarda hash y no extiende la vigencia', async () => {
      await reset();
      const token = await service.createOrderTrackingToken(1, 'bot_1');
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      const { rows } = await engine.query('SELECT * FROM delivery_tracking_sessions WHERE token_hash=$1', [service.tokenHash(token)]);
      assert.equal(rows[0].organization_id, 1);
      assert.equal(rows[0].route_id, 10);
      assert.equal(rows[0].latitude, -29.95);
      const { rows: [source] } = await engine.query("SELECT * FROM delivery_tracking_sessions WHERE token_hash='source'");
      assert.equal(+new Date(rows[0].expires_at), +new Date(source.expires_at));
      assert.notEqual(rows[0].token_hash, token);
      assert.equal((await service.getTrackingStatus(token)).active, true);
      await service.updateRouteLocation(1, 10, { latitude: -29.96, longitude: -71.35, accuracy: 12 });
      assert.equal((await service.getTrackingStatus(token)).latitude, -29.96);
      await engine.exec(`UPDATE delivery_routes SET stop_statuses='{"bot_1":"entregado"}' WHERE id=10`);
      const closed = await service.getTrackingStatus(token);
      assert.equal(closed.status, 'delivered');
      assert.equal(closed.active, false);
      assert.equal(closed.latitude, null);
      assert.equal(closed.longitude, null);
      assert.equal(await service.createOrderTrackingToken(1, 'bot_1'), null);
    });
    await t.test('cerrar el pedido directamente o retirar la parada también oculta el mapa', async () => {
      await reset();
      const token = await service.createOrderTrackingToken(1, 'bot_1');
      await engine.exec("UPDATE orders SET status='paid', delivered_at=NOW() WHERE organization_id=1");
      assert.equal((await service.getTrackingStatus(token)).status, 'delivered');
      assert.equal((await service.getTrackingStatus(token)).latitude, null);
      await engine.exec("UPDATE orders SET status='en_camino', delivered_at=NULL WHERE organization_id=1");
      await engine.exec(`UPDATE delivery_routes SET optimized_route='[{"source":"bot","id":2}]' WHERE id=10`);
      assert.equal((await service.getTrackingStatus(token)).active, false);
    });
    await t.test('rechaza otra tienda, otro pedido, parada ajena, rutas cerradas y sesiones revocadas o vencidas', async () => {
      for (const change of [
        "UPDATE delivery_routes SET status='completed' WHERE id=10",
        "UPDATE delivery_routes SET optimized_route='[{\"source\":\"bot\",\"id\":2}]' WHERE id=10",
        "UPDATE delivery_tracking_sessions SET revoked_at=NOW() WHERE organization_id=1",
        "UPDATE delivery_tracking_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE organization_id=1",
        "UPDATE delivery_tracking_sessions SET organization_id=2 WHERE token_hash='source'",
        ...['partial','cancelled','postponed','not_delivered'].map(status => `UPDATE delivery_routes SET stop_statuses='{"bot_1":"${status}"}' WHERE id=10`),
      ]) {
        await reset();
        await engine.exec(change);
        assert.equal(await service.createOrderTrackingToken(1, 'bot_1'), null, change);
      }
      await reset();
      for (const [org, key] of [[3,'bot_1'],[1,'bot_2'],[0,'bot_1'],[1,'../bot_1'],[1,'shopify_1']]) {
        assert.equal(await service.createOrderTrackingToken(org, key), null);
      }
    });
    await t.test('dos rutas simultáneas para la misma compra no conceden ubicación', async () => {
      await reset();
      await engine.exec(`INSERT INTO delivery_routes VALUES (30,1,'in_progress','[{"source":"bot","id":1}]','[]','{}');
        INSERT INTO delivery_tracking_sessions(organization_id,route_id,stop_key,token_hash,expires_at)
        VALUES (1,30,'bot_1','duplicate-route',NOW()+INTERVAL '1 hour');`);
      assert.equal(await service.createOrderTrackingToken(1, 'bot_1'), null);
    });
    await t.test('Shopify conserva su identificador externo y el cierre parcial retira coordenadas', async () => {
      await reset();
      await engine.exec("UPDATE delivery_tracking_sessions SET stop_key='shopify_10000' WHERE token_hash='source'");
      const token = await service.createOrderTrackingToken(1, 'shopify_10000');
      assert.ok(token);
      await engine.exec(`UPDATE delivery_routes SET stop_statuses='{"shopify_10000":"partial"}' WHERE id=10`);
      const state = await service.getTrackingStatus(token);
      assert.equal(state.active, false);
      assert.equal(state.latitude, null);
      assert.equal(state.status, 'finished');
    });
  } finally { await engine.close(); }
});
