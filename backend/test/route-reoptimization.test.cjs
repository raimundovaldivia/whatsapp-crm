const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

const warehouse = {
  warehouse_address: 'Bodega de prueba, La Serena',
  warehouse_lat: '-29.91',
  warehouse_lng: '-71.25',
};

function stop(id) {
  return {
    source: 'bot',
    id: String(id),
    customerName: `Cliente prueba ${id}`,
    fullAddress: `Dirección de prueba ${id}, La Serena`,
    lat: -29.90 - id / 1000,
    lng: -71.24 - id / 1000,
    stopNumber: id,
  };
}

async function fixture({ googleFailure = false } = {}) {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  let tail = Promise.resolve();
  class Pool {
    query(...args) { return query(...args); }
    async connect() {
      let release;
      const previous = tail;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      return { query, release };
    }
    async end() {}
  }
  const pool = new Pool();
  await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
  await engine.exec(`
    INSERT INTO organizations(id, name, slug)
    VALUES (1, 'Organización uno', 'org-uno'), (2, 'Organización dos', 'org-dos');
  `);

  const stops = [stop(1), stop(2), stop(3)];
  await query(
    `INSERT INTO delivery_routes(
       id, organization_id, name, status, orders, optimized_route,
       stop_statuses, total_distance, total_duration, maps_url
     ) VALUES (41, 1, 'Ruta activa', 'in_progress', $1::jsonb, $1::jsonb,
       '{"bot_1":"entregado"}'::jsonb, 'distancia anterior', 'duración anterior', 'mapa-anterior')`,
    [JSON.stringify(stops)],
  );

  let googleCalls = 0;
  const axios = {
    get: async (_url, { params }) => {
      googleCalls += 1;
      if (googleFailure) {
        return { data: { status: 'REQUEST_DENIED', error_message: 'fallo sintético' } };
      }
      const waypoints = String(params.waypoints || '').replace(/^optimize:true\|/, '').split('|').filter(Boolean);
      return { data: {
        status: 'OK',
        routes: [{
          waypoint_order: waypoints.map((_, index) => waypoints.length - index - 1),
          legs: Array.from({ length: waypoints.length + 1 }, (_, index) => ({
            distance: { value: 1000 + index, text: '1 km' },
            duration: { value: 600, text: '10 min' },
            end_location: { lat: -29.90 - index / 1000, lng: -71.24 - index / 1000 },
          })),
          overview_polyline: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
        }],
      } };
    },
  };
  const database = {
    getPool: () => pool,
    getSetting: async (_orgId, key) => warehouse[key] || null,
  };
  const router = load('src/routes/delivery.js', {
    axios,
    '../db/database': database,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  }, {
    process: { env: { JWT_SECRET: 'test-secret-only-'.repeat(4), GOOGLE_MAPS_API_KEY: 'synthetic-key' } },
  });
  return { engine, query, router, googleCalls: () => googleCalls };
}

async function reoptimize(fixtureValue, orgId = 1) {
  const res = response();
  await handler(fixtureValue.router, 'post', '/routes/41/reoptimize')({
    orgId,
    role: 'owner',
    params: { id: '41' },
    body: {},
  }, res);
  return res;
}

test('reoptimization preserves handled stops and saves every pending stop exactly once', async () => {
  const f = await fixture();
  try {
    const res = await reoptimize(f);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.optimized, true);
    assert.equal(res.body.changed, true);
    assert.equal(res.body.preservedStops, 1);
    assert.equal(res.body.pendingStops, 2);
    assert.deepEqual(Array.from(res.body.route.optimized_route, item => `${item.source}_${item.id}`), [
      'bot_1', 'bot_3', 'bot_2',
    ]);
    assert.deepEqual(Array.from(res.body.route.optimized_route, item => item.stopNumber), [1, 2, 3]);

    const stored = (await f.query(
      'SELECT orders, optimized_route, total_distance, total_duration, maps_url FROM delivery_routes WHERE id=41 AND organization_id=1',
    )).rows[0];
    assert.deepEqual(stored.orders.map(item => `${item.source}_${item.id}`), ['bot_1', 'bot_3', 'bot_2']);
    assert.deepEqual(stored.optimized_route.map(item => `${item.source}_${item.id}`), ['bot_1', 'bot_3', 'bot_2']);
    assert.equal(new Set(stored.optimized_route.map(item => `${item.source}_${item.id}`)).size, 3);
    assert.equal(stored.total_distance, '3.0 km');
    assert.equal(stored.total_duration, '30 min');
    assert.match(stored.maps_url, /^https:\/\/www\.google\.com\/maps\/dir\//);
  } finally {
    await f.engine.close();
  }
});

test('a Google failure is visible and leaves the saved route untouched', async () => {
  const f = await fixture({ googleFailure: true });
  try {
    const before = (await f.query('SELECT orders, optimized_route, total_distance, total_duration, maps_url FROM delivery_routes WHERE id=41')).rows[0];
    const res = await reoptimize(f);
    assert.equal(res.code, 502, JSON.stringify(res.body));
    assert.match(res.body.error, /orden anterior se mantuvo/i);
    const after = (await f.query('SELECT orders, optimized_route, total_distance, total_duration, maps_url FROM delivery_routes WHERE id=41')).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await f.engine.close();
  }
});

test('a route from another organization cannot be inspected or reoptimized', async () => {
  const f = await fixture();
  try {
    const res = await reoptimize(f, 2);
    assert.equal(res.code, 404, JSON.stringify(res.body));
    assert.equal(f.googleCalls(), 0);
    const stored = (await f.query('SELECT optimized_route FROM delivery_routes WHERE id=41 AND organization_id=1')).rows[0];
    assert.deepEqual(stored.optimized_route.map(item => `${item.source}_${item.id}`), ['bot_1', 'bot_2', 'bot_3']);
  } finally {
    await f.engine.close();
  }
});
