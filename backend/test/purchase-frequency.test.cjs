const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const frequency = require('../src/services/purchase-frequency');
const { todayISOChile } = require('../src/services/business-date');

const today = '2026-11-06';
const order = (id, date, extra = {}) => ({ id, date, phone: '912345678', name: 'Cliente de prueba', source: 'crm', status: 'paid', ...extra });

test('calcula días únicos, mediana, atraso y límite de muestra sin inventar compras', () => {
  const result = frequency.buildFrequencyCustomers([], [
    order(1, '2026-10-01'), order(2, '2026-10-08'), order(3, '2026-10-08'), order(4, '2026-10-15'),
    order(5, '2026-10-29'), order(6, '2026-11-10'), order(7, null), order(8, '2026-02-30'),
  ], today)[0];
  assert.equal(result.purchaseCount, 5);
  assert.equal(result.purchaseDays, 4);
  assert.equal(result.intervalDays, 7);
  assert.equal(result.nextPurchase, '2026-11-05');
  assert.equal(result.daysUntilNext, -1);
  assert.equal(result.status, 'overdue');
  assert.equal(result.daysSincePurchase, 8);
  const dates = Array.from({ length: 20 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);
  const summary = frequency.summarizeDates(dates, today);
  assert.equal(summary.sampleDays, 12);
  assert.equal(summary.purchaseDays, 20);
  assert.equal(summary.recentDates.at(-1), '2026-10-09');
});

test('cero o una fecha de compra no tienen estimación; dos fechas tienen historial limitado', () => {
  for (const dates of [[], ['2026-11-01', '2026-11-01']]) {
    const result = frequency.summarizeDates(dates, today);
    assert.equal(result.intervalDays, null);
    assert.equal(result.nextPurchase, null);
    assert.equal(result.status, 'insufficient');
  }
  const result = frequency.summarizeDates(['2026-10-30', '2026-11-06'], today);
  assert.equal(result.intervalDays, 7);
  assert.equal(result.regularity, 'insufficient');
  assert.equal(result.status, 'upcoming');
  assert.equal(frequency.summarizeDates(['2026-10-23', '2026-10-30'], today).status, 'due');
  assert.equal(frequency.summarizeDates(['2026-10-01', '2026-10-02', '2026-11-01'], today).regularity, 'variable');
});

test('une formatos telefónicos sin fusionar nombres iguales', () => {
  const result = frequency.buildFrequencyCustomers([{ phone: '+56 9 1234 5678', name: 'Nombre guardado' }], [
    order(2, '2026-10-01', { source: 'shopify', shopify_order_id: '100', phone: '56912345678' }),
    order(3, '2026-10-08', { phone: '+56 9 1234 5678' }),
    order(4, '2026-10-08', { phone: '56987654321', name: 'Nombre guardado' }),
  ], today);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Nombre guardado');
  assert.equal(result[0].purchaseCount, 2);
  assert.equal(result[0].intervalDays, 7);
});

test('conserva el criterio del CRM: compras pagadas o entregadas, sin borradores ni cancelaciones', () => {
  const result = frequency.buildFrequencyCustomers([], [
    order(1, '2026-10-01', { status: 'draft' }), order(2, '2026-10-02', { status: 'cancelled' }),
    order(3, '2026-10-03', { source: 'shopify', status: 'REFUNDED' }),
    order(4, '2026-10-04', { source: 'shopify', status: 'VOIDED' }),
    order(6, '2026-10-05', { source: 'shopify', shopify_order_id: '200', status: 'cancelled' }),
    order(7, '2026-10-06', { source: 'shopify', status: 'DELIVERED' }),
    order(8, '2026-10-07', { status: 'nuevo' }),
    order(9, '2026-10-08', { status: 'paid' }),
  ], today);
  assert.equal(result[0].purchaseCount, 2);
  assert.equal(result[0].lastPurchase, '2026-10-08');
});

test('conserva bajas entre variantes y no incluye leads sin compras', () => {
  const result = frequency.buildFrequencyCustomers([
    { phone: '912345678', name: 'Prueba', contact_type: 'customer', opt_out: false },
    { phone: '+56912345678', contact_type: 'lead', opt_out: true },
    { phone: '987654321', contact_type: 'lead' },
    { phone: '922222222', contact_type: 'customer' },
  ], [order(1, '2026-10-01')], today);
  assert.equal(result.length, 2);
  assert.equal(result.find(customer => customer.phone === '56912345678').optedOut, true);
  assert.equal(result.find(customer => customer.phone === '56922222222').purchaseCount, 0);
});

test('consulta SQL real aísla empresa y transforma fechas a Chile en verano e invierno', async () => {
  const pool = new PGlite();
  try {
    await pool.exec(`
      CREATE TABLE contacts (id serial, organization_id integer, phone text, name text, contact_type text, shopify_id text, opt_out boolean, updated_at timestamp);
      CREATE TABLE conversations (id serial, organization_id integer, phone_number text);
      CREATE TABLE orders (id serial, conversation_id integer, organization_id integer, shopify_order_id text, customer_phone text, customer_name text, status text, created_at timestamp, items text, total_price text, delivery_date date, delivered_at timestamp, payment_marked_at timestamp);
      CREATE TABLE shopify_orders (id serial, organization_id integer, shopify_order_id text, customer_phone text, customer_name text, crm_status text, financial_status text, fulfillment_status text, raw_json jsonb, shopify_created_at timestamp, items jsonb, total_price numeric, delivery_date date, delivered_at timestamp, dispatch_count integer, last_attempt_at timestamp, last_attempt_status text, delivery_note text);
      INSERT INTO contacts (organization_id, phone, name, contact_type) VALUES (1, '912345678', 'Propio', 'customer'), (2, '987654321', 'Ajeno', 'customer');
      INSERT INTO orders (organization_id, customer_phone, status, created_at) VALUES
        (1, '912345678', 'paid', '2026-07-02 03:30:00'),
        (2, '912345678', 'paid', '2026-11-05 12:00:00');
      INSERT INTO shopify_orders (organization_id, shopify_order_id, customer_phone, financial_status, shopify_created_at) VALUES
        (1, '1', '56912345678', 'PAID', '2026-11-02 02:30:00'),
        (2, '2', '912345678', 'PAID', '2026-11-06 12:00:00');
      INSERT INTO orders (organization_id, shopify_order_id, customer_phone, status, created_at) VALUES
        (1, 'gid://shopify/Order/1', '912345678', 'paid', '2026-11-03 12:00:00'),
        (1, 'gid://shopify/Order/3', '912345678', 'paid', '2026-11-04 12:00:00');
      INSERT INTO shopify_orders (organization_id, shopify_order_id, customer_phone, financial_status, shopify_created_at) VALUES
        (1, '3', '912345678', 'REFUNDED', '2026-11-04 12:00:00');
    `);
    await pool.exec("UPDATE shopify_orders SET crm_status='por_despachar' WHERE organization_id=1 AND shopify_order_id='1'");
    const result = await frequency.getPurchaseFrequency(pool, 1, today);
    assert.equal(result.customers.length, 1);
    assert.equal(result.customers[0].name, 'Propio');
    assert.equal(result.customers[0].purchaseCount, 2);
    assert.deepEqual(result.customers[0].recentDates, ['2026-11-01', '2026-07-01']);
    assert.equal(result.customers[0].intervalDays, 123);
    assert.equal(result.customers[0].status, 'pending_dispatch');
    await pool.exec(`UPDATE orders SET delivered_at=NOW() WHERE organization_id=1;
      UPDATE shopify_orders SET fulfillment_status='FULFILLED', crm_status='nuevo' WHERE organization_id=1;
      INSERT INTO orders (organization_id,customer_phone,status,created_at)
      VALUES (1,'+56 9 1234 5678','nuevo','2026-11-06'),(2,'912345678','nuevo','2026-11-06')`);
    const current = async () => (await frequency.getPurchaseFrequency(pool, 1, today, ['912345678'])).customers[0];
    assert.equal((await current()).status, 'pending_dispatch');
    await pool.exec("UPDATE orders SET status='cancelled' WHERE organization_id=1 AND status='nuevo'");
    assert.equal((await current()).status, 'upcoming');
    await pool.exec("UPDATE shopify_orders SET crm_status='en_camino' WHERE organization_id=1 AND shopify_order_id='1'");
    assert.equal((await current()).status, 'pending_dispatch');
    await pool.exec("UPDATE shopify_orders SET delivered_at=NOW() WHERE organization_id=1");
    assert.equal((await current()).status, 'upcoming');
    assert.equal(todayISOChile(new Date('2026-11-07T02:59:00Z')), today);
  } finally { await pool.close(); }
});

test('ruta conserva sesión, roles, organización del token, valida vista y no llama Shopify', async () => {
  let reads = 0;
  let failRead = false;
  const users = new Map([
    [1, { id: 1, organization_id: 7, role: 'owner' }],
    [2, { id: 2, organization_id: 7, role: 'repartidor' }],
    [3, { id: 3, organization_id: 7, role: 'coordinador' }],
    [4, { id: 4, organization_id: 7, role: 'agent' }],
  ]);
  const db = { getPool: () => ({ query: async () => ({ rows: [] }) }), getUserById: async id => users.get(id) };
  const auth = load('src/middleware/auth.js', { '../db/database': db }, { process: { env: { JWT_SECRET: randomBytes(32).toString('hex') } } });
  const router = load('src/routes/clientes.js', {
    '../db/database': db, '../middleware/auth': auth,
    '../services/shopify-api': new Proxy({}, { get() { throw new Error('No Shopify'); } }),
    '../services/purchase-frequency': { getPurchaseFrequency: async (_pool, orgId) => {
      if (failRead) throw new Error('Internal database detail');
      assert.equal(orgId, 7); reads++; return { success: true, customers: [], asOf: today };
    } },
  });
  const app = express(); app.use('/api/clientes', router);
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}/api/clientes/all`;
  const headers = id => ({ Authorization: `Bearer ${auth.generateToken(users.get(id))}` });
  try {
    assert.equal((await fetch(`${base}?view=frequency`)).status, 401);
    for (const id of [2, 3, 4]) assert.equal((await fetch(`${base}?view=frequency`, { headers: headers(id) })).status, 403);
    for (const query of ['view=invalid', 'view[]=frequency', 'view=frequency&view=frequency']) assert.equal((await fetch(`${base}?${query}`, { headers: headers(1) })).status, 400);
    assert.equal(reads, 0);
    const response = await fetch(`${base}?view=frequency&organization_id=999`, { headers: headers(1) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).asOf, today);
    assert.equal(reads, 1);
    const legacy = await fetch(base, { headers: headers(1) });
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).needsSync, true);
    failRead = true;
    const failure = await fetch(`${base}?view=frequency`, { headers: headers(1) });
    assert.equal(failure.status, 500);
    assert.equal((await failure.json()).error, 'No se pudo cargar la frecuencia de compra.');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
