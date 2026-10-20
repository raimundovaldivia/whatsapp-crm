const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const purchaseSync = require('../src/services/meta-purchase-sync');

function pglitePool(engine) {
  return {
    async query(sql, params) {
      const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    },
  };
}

test('construye Purchase con ctwa_clid y teléfono cifrado, nunca en texto plano', () => {
  const hash = purchaseSync.phoneHash('9 1234 5678');
  assert.equal(hash, crypto.createHash('sha256').update('56912345678').digest('hex'));
  const payload = purchaseSync.buildPurchasePayload({
    ctwa_clid: 'click-real',
    phone_hash: hash,
    event_time: '2026-10-15T12:00:00Z',
    event_id: 'purchase:1:bot:7',
    currency: 'CLP',
    value_amount: '18990',
  }, { businessAccountId: '123456' });
  assert.equal(payload.data[0].event_name, 'Purchase');
  assert.equal(payload.data[0].action_source, 'business_messaging');
  assert.equal(payload.data[0].messaging_channel, 'whatsapp');
  assert.equal(payload.data[0].user_data.ctwa_clid, 'click-real');
  assert.deepEqual(payload.data[0].user_data.ph, [hash]);
  assert.equal(JSON.stringify(payload).includes('56912345678'), false);
});

test('descubre por organización, envía Purchase reciente y agrega compradores a la audiencia una sola vez', async () => {
  const engine = new PGlite();
  const pool = pglitePool(engine);
  try {
    await engine.exec(`
      CREATE TABLE meta_connections (
        organization_id INTEGER PRIMARY KEY, status TEXT, purchase_sync_enabled BOOLEAN,
        user_access_token TEXT, conversion_dataset_id TEXT, purchase_audience_id TEXT,
        purchase_sync_since TIMESTAMPTZ
      );
      CREATE TABLE whatsapp_configs (organization_id INTEGER PRIMARY KEY, business_account_id TEXT);
      CREATE TABLE conversations (id INTEGER PRIMARY KEY, organization_id INTEGER, phone_number TEXT);
      CREATE TABLE contacts (id INTEGER PRIMARY KEY, organization_id INTEGER, phone TEXT, opt_out BOOLEAN DEFAULT FALSE);
      CREATE TABLE orders (
        id INTEGER, organization_id INTEGER, conversation_id INTEGER, shopify_order_id TEXT,
        customer_phone TEXT, total_price NUMERIC, status TEXT,
        payment_marked_at TIMESTAMPTZ, created_at TIMESTAMPTZ
      );
      CREATE TABLE shopify_orders (
        organization_id INTEGER, shopify_order_id TEXT, customer_phone TEXT, total_price NUMERIC,
        financial_status TEXT, payment_marked_at TIMESTAMPTZ, shopify_created_at TIMESTAMPTZ,
        synced_at TIMESTAMPTZ
      );
      CREATE TABLE whatsapp_attributions (
        id INTEGER, organization_id INTEGER, conversation_id INTEGER,
        ctwa_clid TEXT, first_seen_at TIMESTAMPTZ
      );
      CREATE TABLE meta_purchase_deliveries (
        id BIGSERIAL PRIMARY KEY, organization_id INTEGER, contact_id INTEGER, source TEXT, order_key TEXT,
        destination TEXT, event_id TEXT, ctwa_clid TEXT, phone_hash TEXT,
        value_amount NUMERIC, currency TEXT, event_time TIMESTAMPTZ,
        status TEXT DEFAULT 'pending', attempt_count INTEGER DEFAULT 0,
        claimed_at TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
        last_error TEXT, response_json JSONB, created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(organization_id,source,order_key,destination)
      );
      INSERT INTO meta_connections VALUES
        (1,'connected',TRUE,'encrypted-1','dataset-1','audience-1',NOW()-INTERVAL '90 days'),
        (2,'connected',TRUE,'encrypted-2','dataset-2','audience-2',NOW()-INTERVAL '90 days');
      INSERT INTO whatsapp_configs VALUES (1,'waba-1'),(2,'waba-2');
      INSERT INTO conversations VALUES (10,1,'56912345678'),(20,2,'56912345678');
      INSERT INTO contacts VALUES (100,1,'56912345678',FALSE),(200,2,'56912345678',FALSE);
      INSERT INTO orders VALUES
        (7,1,10,NULL,'912345678',18990,'paid',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '2 hours'),
        (8,1,10,NULL,'912345678',9990,'paid',NOW()-INTERVAL '10 days',NOW()-INTERVAL '11 days'),
        (7,2,20,NULL,'912345678',28990,'paid',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '2 hours');
      INSERT INTO whatsapp_attributions VALUES
        (1,1,10,'click-org-1',NOW()-INTERVAL '2 days'),
        (2,2,20,'click-org-2',NOW()-INTERVAL '2 days');
    `);

    const discovered = await purchaseSync.discoverPurchaseDeliveries({ pool, organizationId: 1, now: new Date() });
    assert.equal(discovered, 3, 'la compra reciente genera Purchase y audiencia; la antigua solo audiencia');
    const beforeSend = (await engine.query('SELECT destination,order_key,status FROM meta_purchase_deliveries ORDER BY order_key,destination')).rows;
    assert.deepEqual(beforeSend.map(row => `${row.order_key}:${row.destination}`), ['7:audience', '7:purchase', '8:audience']);
    assert.equal((await engine.query('SELECT COUNT(*)::int AS count FROM meta_purchase_deliveries WHERE organization_id=2')).rows[0].count, 0);

    const calls = [];
    const processed = await purchaseSync.processPurchaseDeliveries({
      pool,
      organizationId: 1,
      decryptToken: value => `plain:${value}`,
      graphPost: async (path, token, payload) => {
        calls.push({ path, token, payload });
        return path.endsWith('/events') ? { events_received: 1 } : { num_received: 1 };
      },
    });
    assert.deepEqual(processed, { sent: 3, failed: 0, skipped: 0 });
    assert.equal(calls.filter(call => call.path === 'dataset-1/events').length, 1);
    assert.equal(calls.filter(call => call.path === 'audience-1/users').length, 2);
    assert.equal(calls.every(call => call.token === 'plain:encrypted-1'), true);
    assert.equal(JSON.stringify(calls).includes('56912345678'), false);
    assert.equal(await purchaseSync.discoverPurchaseDeliveries({ pool, organizationId: 1, now: new Date() }), 0);
    assert.equal((await engine.query('SELECT COUNT(*)::int AS count FROM meta_purchase_deliveries')).rows[0].count, 3);

    await engine.exec('UPDATE contacts SET opt_out=TRUE WHERE id=100');
    assert.equal(await purchaseSync.discoverPurchaseDeliveries({ pool, organizationId: 1, now: new Date() }), 1);
    const removals = [];
    const removalResult = await purchaseSync.processPurchaseDeliveries({
      pool,
      organizationId: 1,
      decryptToken: value => value,
      graphDelete: async (path, _token, payload) => { removals.push({ path, payload }); return { num_received: 1 }; },
    });
    assert.deepEqual(removalResult, { sent: 1, failed: 0, skipped: 0 });
    assert.equal(removals.length, 1);
    assert.equal(removals[0].path, 'audience-1/users');
  } finally {
    await engine.close();
  }
});

test('un Purchase sin confirmación de Meta queda fallido para reintento', async () => {
  const deliveries = [];
  const pool = {
    async query(sql) {
      if (sql.includes("status='processing'") && sql.includes("INTERVAL '10 minutes'")) return { rows: [] };
      if (sql.includes('WITH candidate AS')) {
        return { rows: deliveries.length ? [] : [{
          id: 1, organization_id: 1, destination: 'purchase', attempt_count: 1,
          ctwa_clid: 'click', phone_hash: null, value_amount: '1000', currency: 'CLP',
          event_time: new Date(), event_id: 'purchase:1:bot:1',
        }] };
      }
      if (sql.includes('SELECT connection.user_access_token')) {
        return { rows: [{ user_access_token: 'encrypted', conversion_dataset_id: 'dataset', business_account_id: 'waba' }] };
      }
      if (sql.includes("SET status='failed'")) {
        deliveries.push('failed');
        return { rows: [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  const result = await purchaseSync.processPurchaseDeliveries({
    pool,
    graphPost: async () => ({ events_received: 0 }),
    decryptToken: value => value,
    limit: 1,
  });
  assert.deepEqual(result, { sent: 0, failed: 1, skipped: 0 });
  assert.deepEqual(deliveries, ['failed']);
});
