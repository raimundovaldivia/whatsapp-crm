const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

// Reproducción sintética del reparto reportado. Conserva solamente las
// direcciones necesarias para probar la ruta; nombres, teléfonos, productos e
// identificadores de clientes son ficticios.
const reportedAddresses = [
  'Henry Ford 1680, La Serena',
  'La Academia 1542, La Serena',
  'Balmaceda 4095, 403, torre uno, La Serena',
  'Gral. Bartolomé Blanche 2698 depto 403, La Serena',
  'Avda Gabriela Mistral 3251 depto 502 edificio 1, La Serena',
  'Av El Sauce 1148, Coquimbo',
  'Braulio Arenas 1255, La Serena',
  'Avenida Francisco de Aguirre 500, La Serena',
  'Julio Torres 585, La Serena',
  'Santo Cura de Ars 947, Coquimbo',
  'Damiano Albertini 1588, Coquimbo',
  'Juan Domingo Arce 701, Coquimbo',
];

// Coordenadas distintas y plausibles para ejercitar el contrato sin consultar
// Google ni registrar ubicaciones obtenidas desde producción.
const syntheticCoordinates = [
  [-29.9280, -71.2350], [-29.9660, -71.2440], [-29.9360, -71.2580],
  [-29.9200, -71.2570], [-29.9460, -71.2390], [-29.9820, -71.3360],
  [-29.9130, -71.2500], [-29.9020, -71.2520], [-29.9180, -71.2610],
  [-29.9660, -71.3360], [-29.9740, -71.3300], [-29.9620, -71.3420],
];

function syntheticOrders() {
  return reportedAddresses.map((fullAddress, index) => ({
    source: 'bot',
    id: String(7001 + index),
    customerName: `Cliente prueba ${String(index + 1).padStart(2, '0')}`,
    orderName: `#PRUEBA-${String(index + 1).padStart(2, '0')}`,
    fullAddress,
    lat: syntheticCoordinates[index][0],
    lng: syntheticCoordinates[index][1],
    items: [{ name: 'Producto de prueba', quantity: 1, price: 1000 }],
  }));
}

function routerWithRejectedGoogle() {
  const database = {
    getSetting: async (_orgId, key) => ({
      warehouse_address: 'Bodega de prueba, La Serena',
      warehouse_lat: '-29.91',
      warehouse_lng: '-71.25',
    })[key] || null,
    getPool: () => ({
      query: async (sql, params = []) => {
        if (/FROM\s+orders\b/i.test(sql)) {
          return {
            rows: (params[1] || []).map(id => ({
              id: String(id), status: 'por_despachar', dispatch_count: 0,
              last_attempt_status: null, delivery_note: null, blocked: false,
            })),
          };
        }
        return { rows: [] };
      },
    }),
  };
  return load('src/routes/delivery.js', {
    axios: {
      get: async () => ({
        data: {
          status: 'REQUEST_DENIED',
          error_message: 'Fallo sintético de Google para comprobar el fallback',
        },
      }),
    },
    '../db/database': database,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  }, {
    process: {
      env: {
        JWT_SECRET: 'test-secret-only-'.repeat(4),
        GOOGLE_MAPS_API_KEY: 'synthetic-key',
      },
    },
  });
}

async function persistedFixture() {
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
    INSERT INTO organizations(id, name, slug) VALUES (1, 'Organización prueba', 'org-prueba');
    INSERT INTO users(id, organization_id, email, password_hash, role, name)
    VALUES (10, 1, 'repartidor-prueba@example.test', 'test', 'repartidor', 'Repartidor prueba');
  `);
  for (let index = 0; index < reportedAddresses.length; index++) {
    await query(
      `INSERT INTO orders(id, organization_id, customer_name, shipping_address, items, total_price, status)
       VALUES ($1, 1, $2, $3::jsonb, '[{"name":"Producto de prueba","quantity":1,"price":1000}]'::jsonb, 1000, 'por_despachar')`,
      [7001 + index, `Cliente prueba ${String(index + 1).padStart(2, '0')}`, JSON.stringify({ address: reportedAddresses[index] })],
    );
  }
  const database = {
    getPool: () => pool,
    getSetting: async (_orgId, key) => ({
      warehouse_address: 'Bodega de prueba, La Serena',
      warehouse_lat: '-29.91',
      warehouse_lng: '-71.25',
    })[key] || null,
  };
  const router = load('src/routes/delivery.js', {
    axios: {
      get: async () => ({
        data: {
          status: 'REQUEST_DENIED',
          error_message: 'Fallo sintético de Google para comprobar persistencia',
        },
      }),
    },
    '../db/database': database,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/push': { pushUser: async () => {} },
  }, {
    process: {
      env: {
        JWT_SECRET: 'test-secret-only-'.repeat(4),
        GOOGLE_MAPS_API_KEY: 'synthetic-key',
      },
    },
  });
  return { engine, query, router };
}

function renderMobileMarkers(stops) {
  const mobileRoot = path.resolve(__dirname, '../../mobile/src');
  const routeMapSource = fs.readFileSync(path.join(mobileRoot, 'utils/routeMap.js'), 'utf8');
  const screenSource = fs.readFileSync(path.join(mobileRoot, 'screens/RouteMapScreen.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(routeMapSource.replace(/export /g, ''), context);
  context.stopLabel = value => String(value);
  const htmlFactory = screenSource.slice(
    screenSource.indexOf('function mapHtml('),
    screenSource.indexOf('export default function'),
  );
  vm.runInContext(htmlFactory, context);

  // Simula el viaje por JSONB/API antes de llegar a la app del repartidor.
  context.savedRoute = JSON.parse(JSON.stringify({ orders: stops, optimized_route: stops }));
  const html = vm.runInContext(
    'mapHtml(routeStops(savedRoute), {}, "numbers")',
    context,
  );
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const markers = [];
  const fittedBounds = [];
  const map = {
    invalidateSize() {},
    fitBounds(points) { fittedBounds.push(points); },
  };
  vm.runInNewContext(script, {
    window: { addEventListener() {} },
    L: {
      map: () => map,
      tileLayer: () => ({ addTo() {} }),
      divIcon: options => options,
      marker: point => {
        markers.push(point);
        return { addTo() { return { bindPopup() {} }; } };
      },
    },
  });
  return { markers, fittedBounds };
}

test('the reported twelve-stop route survives a Google rejection and the mobile map receives all twelve markers', async () => {
  const orders = syntheticOrders();
  const res = response();
  await handler(routerWithRejectedGoogle(), 'post', '/optimize')({
    orgId: 1,
    role: 'owner',
    body: { orders, vehicles: 1 },
  }, res);

  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.optimized, false);
  assert.match(res.body.warning, /Google no pudo optimizar/i);
  assert.equal(res.body.routes.length, 1);
  const stops = res.body.routes[0].stops;
  assert.equal(stops.length, 12);
  assert.deepEqual(
    new Set(stops.map(stop => stop.fullAddress)),
    new Set(reportedAddresses),
  );
  assert.equal(new Set(stops.map(stop => `${stop.lat},${stop.lng}`)).size, 12);

  const rendered = renderMobileMarkers(stops);
  assert.equal(rendered.markers.length, 12);
  assert.equal(new Set(rendered.markers.map(point => point.join(','))).size, 12);
  assert.equal(rendered.fittedBounds.length, 1);
  assert.equal(rendered.fittedBounds[0].length, 12);
});

test('the complete persisted API flow returns all twelve synthetic stops to the driver app', async () => {
  const fixture = await persistedFixture();
  try {
    const orders = syntheticOrders();
    const optimized = response();
    await handler(fixture.router, 'post', '/optimize')({
      orgId: 1,
      role: 'owner',
      body: { orders, vehicles: 1 },
    }, optimized);
    assert.equal(optimized.code, 200, JSON.stringify(optimized.body));
    assert.equal(optimized.body.routes[0].stops.length, 12);

    const created = response();
    await handler(fixture.router, 'post', '/routes')({
      orgId: 1,
      role: 'owner',
      body: {
        name: 'Reparto sintético de 12 paradas',
        orders: optimized.body.routes[0].stops,
        optimizedRoute: optimized.body.routes[0].stops,
        send: true,
      },
    }, created);
    assert.equal(created.code, 200, JSON.stringify(created.body));
    const routeId = created.body.route.id;

    const driverView = response();
    await handler(fixture.router, 'get', `/routes/${routeId}`)({
      orgId: 1,
      userId: 10,
      role: 'repartidor',
      params: { id: String(routeId) },
    }, driverView);
    assert.equal(driverView.code, 200, JSON.stringify(driverView.body));
    assert.equal(driverView.body.route.orders.length, 12);
    assert.equal(driverView.body.route.optimized_route.length, 12);
    assert.deepEqual(
      new Set(driverView.body.route.optimized_route.map(stop => stop.fullAddress)),
      new Set(reportedAddresses),
    );

    const rendered = renderMobileMarkers(driverView.body.route.optimized_route);
    assert.equal(rendered.markers.length, 12);
    assert.equal(rendered.fittedBounds[0].length, 12);
    assert.equal(
      (await fixture.query("SELECT COUNT(*)::int AS count FROM orders WHERE organization_id=1 AND status='asignado_ruta'")).rows[0].count,
      12,
    );
  } finally {
    await fixture.engine.close();
  }
});
