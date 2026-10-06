const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
  buildCustomerIdentityMap,
  consolidateCustomerCandidates,
  loadCustomerIdentityMap,
  resolveCustomerPhones,
} = require('../src/services/customer-identity');

test('customer order identity joins strong aliases and chooses the most recent phone', () => {
  const map = buildCustomerIdentityMap([
    { phone: '56982295945', name: 'Denisse Duhalde', email: 'denisse@example.com', orderDate: '2026-04-06' },
    { phone: '56982294847', name: 'Denisse Duhalde', email: 'DENISSE@example.com', orderDate: '2026-09-21' },
    { phone: '56911111111', name: 'Denisse Duhalde', orderDate: '2026-10-01' },
  ]);
  assert.equal(map.get('56982295945'), '56982294847');
  assert.equal(map.get('56982294847'), '56982294847');
  assert.equal(map.get('56911111111'), '56911111111', 'same name alone must never merge customers');
});

test('cached campaign candidates collapse into the current phone and combined history', () => {
  const staleCandidates = [
    { phone: '56982295945', name: 'Denisse Duhalde', lastOrderDate: '2026-04-06', totalOrders: 5, totalSpent: 130000, recentOrders: [] },
    { phone: '56982294847', name: 'Denisse Duhalde', lastOrderDate: '2026-09-21', totalOrders: 14, totalSpent: 266000, recentOrders: [] },
  ];
  const identityMap = buildCustomerIdentityMap(staleCandidates.map(candidate => ({ ...candidate, email: 'denisse@example.com', orderDate: candidate.lastOrderDate })));
  const candidates = consolidateCustomerCandidates(staleCandidates, identityMap);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].phone, '56982294847');
  assert.equal(candidates[0].totalOrders, 19);
  assert.equal(candidates[0].totalSpent, 396000);
  assert.equal(candidates[0].lastOrderDate, '2026-09-21');
});

test('customer order identity can join an old phone by exact name and address', () => {
  const map = buildCustomerIdentityMap([
    { phone: '56910000001', name: 'María Pérez', address1: 'Los Aromos 123', city: 'La Serena' },
    { phone: '56910000002', name: 'Maria Perez', address: 'Los Aromos 123', city: 'La Serena' },
    { phone: '56910000003', name: 'Maria Perez', address: 'Otra calle 9', city: 'La Serena' },
  ]);
  assert.equal(map.get('56910000001'), map.get('56910000002'));
  assert.notEqual(map.get('56910000001'), map.get('56910000003'));
});

test('history resolver returns every phone belonging to the same strong identity', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(`
      CREATE TABLE contacts (organization_id INT, phone TEXT, name TEXT, email TEXT, address TEXT,
        address1 TEXT, city TEXT, shopify_id TEXT, last_order_at TIMESTAMP);
      CREATE TABLE shopify_orders (organization_id INT, customer_phone TEXT, customer_name TEXT,
        customer_email TEXT, shipping_address1 TEXT, shipping_city TEXT, raw_json JSONB,
        shopify_created_at TIMESTAMP);
      INSERT INTO contacts VALUES
        (1,'56982295945','Denisse Duhalde','denisse@example.com',NULL,NULL,'La Serena','gid://shopify/Customer/1','2026-04-06'),
        (1,'56982294847','Denisse Duhalde','denisse@example.com',NULL,NULL,'La Serena','gid://shopify/Customer/1','2026-09-21'),
        (1,'56911111111','Denisse Duhalde',NULL,NULL,NULL,'La Serena',NULL,'2026-10-01'),
        (2,'56982295945','Otra organización','denisse@example.com',NULL,NULL,'La Serena','gid://shopify/Customer/1','2026-09-21');
    `);
    const pool = { query: (sql, params) => engine.query(sql, params) };
    const phones = await resolveCustomerPhones(pool, 1, '56982294847');
    assert.ok(phones.includes('56982294847'));
    assert.ok(phones.includes('56982295945'));
    assert.ok(!phones.includes('56911111111'));
  } finally {
    await engine.close();
  }
});

test('cached candidates inherit the Shopify email and consolidate even when cache omitted it', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(`
      CREATE TABLE contacts (organization_id INT, phone TEXT, name TEXT, email TEXT, address TEXT,
        address1 TEXT, city TEXT, shopify_id TEXT, last_order_at TIMESTAMP);
      CREATE TABLE shopify_orders (organization_id INT, customer_phone TEXT, customer_name TEXT,
        customer_email TEXT, shipping_address1 TEXT, shipping_city TEXT, raw_json JSONB,
        shopify_created_at TIMESTAMP);
      INSERT INTO contacts VALUES
        (1,'56982295945','Denisse Duhalde','denisseduhalde@gmail.com',NULL,NULL,'La Serena',NULL,'2026-04-06'),
        (1,'56982294847','Denisse Duhalde','denisseduhalde@gmail.com',NULL,NULL,'La Serena',NULL,'2026-09-21');
    `);
    const pool = { query: (sql, params) => engine.query(sql, params) };
    const stale = [
      { phone: '56982295945', name: 'Denisse Duhalde', lastOrderDate: '2026-04-06', totalOrders: 5, totalSpent: 130000 },
      { phone: '56982294847', name: 'Denisse Duhalde', lastOrderDate: '2026-09-21', totalOrders: 14, totalSpent: 266000 },
    ];
    const identityMap = await loadCustomerIdentityMap(pool, 1, stale);
    const consolidated = consolidateCustomerCandidates(stale, identityMap);
    assert.equal(consolidated.length, 1);
    assert.equal(consolidated[0].phone, '56982294847');
    assert.equal(consolidated[0].email, 'denisseduhalde@gmail.com');
    assert.equal(consolidated[0].totalOrders, 19);
    assert.equal(consolidated[0].totalSpent, 396000);
  } finally {
    await engine.close();
  }
});
