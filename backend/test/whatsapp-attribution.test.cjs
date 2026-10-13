const test = require('node:test');
const assert = require('node:assert/strict');
const attribution = require('../src/services/whatsapp-attribution');
const evolution = require('../src/services/evolution-whatsapp');
const whatsapp = require('../src/services/whatsapp');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('normaliza la referencia Click-to-WhatsApp recibida por Evolution', () => {
  const parsed = evolution.parseWebhookMessage({
    event: 'messages.upsert',
    data: {
      key: { id: 'AD-1', remoteJid: '56911112222@s.whatsapp.net', fromMe: false },
      message: { extendedTextMessage: {
        text: 'Hola, quiero información',
        contextInfo: { externalAdReply: {
          title: 'Huevos frescos en La Serena',
          body: 'Despacho durante el día',
          sourceUrl: 'https://fb.me/ad/123',
          sourceId: '123',
          mediaType: 1,
          thumbnailUrl: 'https://cdn.example/ad.jpg',
        }, ctwaClid: 'clid-123' },
      } },
    },
  });
  assert.equal(parsed.attribution.sourceId, '123');
  assert.equal(parsed.attribution.sourceUrl, 'https://fb.me/ad/123');
  assert.equal(parsed.attribution.ctwaClid, 'clid-123');
  assert.equal(parsed.attribution.headline, 'Huevos frescos en La Serena');
});

test('normaliza referral de Meta y conserva identificadores de campaña', () => {
  const parsed = whatsapp.parseWebhookMessage({ entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: 'Ana' } }],
    messages: [{ id: 'META-1', from: '56922223333', type: 'text', text: { body: 'Precio' }, referral: {
      source_type: 'ad', source_id: 'ad-44', source_url: 'https://facebook.com/ads/44',
      headline: 'Promo Jumbo', ctwa_clid: 'click-44', campaign_id: 'campaign-9', campaign_name: 'Octubre',
    } }],
  } }] }] });
  assert.equal(parsed.attribution.adId, 'ad-44');
  assert.equal(parsed.attribution.campaignId, 'campaign-9');
  assert.equal(parsed.attribution.campaignName, 'Octubre');
});

test('no inventa atribución cuando el proveedor no entrega referencia publicitaria', () => {
  assert.equal(attribution.fromEvolution({ conversation: 'Hola' }, {}, {}), null);
  assert.equal(attribution.fromKapso({}, { type: 'text', text: { body: 'Hola' } }, {}), null);
});

test('el reporte asigna cada pedido solo a la última campaña que lo precede', async () => {
  const engine = new PGlite();
  class Pool {
    async query(sql, params) {
      const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    }
  }
  const db = load('src/db/database.js', { pg: { Pool } });
  try {
    await engine.exec(`
      CREATE TABLE conversations (
        id SERIAL PRIMARY KEY, organization_id INT, contact_name TEXT, phone_number TEXT,
        attribution_source_type TEXT, attribution_source_id TEXT, attribution_source_url TEXT,
        attribution_headline TEXT, attribution_campaign_id TEXT, attribution_campaign_name TEXT,
        attribution_ad_id TEXT, attribution_ad_name TEXT, attribution_first_seen_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY, organization_id INT, conversation_id INT, total_price TEXT,
        status TEXT, items TEXT, created_at TIMESTAMP
      );
      CREATE TABLE whatsapp_attributions (
        id SERIAL PRIMARY KEY, organization_id INT NOT NULL, conversation_id INT NOT NULL,
        message_id INT, whatsapp_message_id TEXT NOT NULL, provider TEXT NOT NULL,
        source_type TEXT, source_id TEXT, source_url TEXT, ctwa_clid TEXT,
        headline TEXT, body TEXT, media_type TEXT, media_url TEXT,
        campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT,
        ad_id TEXT, ad_name TEXT, raw_json JSONB,
        first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
        UNIQUE (organization_id, provider, whatsapp_message_id)
      );
      INSERT INTO conversations (organization_id, contact_name, phone_number)
      VALUES (1, 'Carolina', '56911112222');
    `);
    const base = {
      organizationId: 1, conversationId: 1, provider: 'evolution',
      attribution: { sourceType: 'ad', sourceId: 'ad', headline: 'Promo', raw: {} },
    };
    await db.saveWhatsappAttribution({ ...base, whatsappMessageId: 'ad-1', receivedAt: new Date('2026-10-01T10:00:00Z'),
      attribution: { ...base.attribution, campaignId: 'campaign-1', campaignName: 'Campaña 1' } });
    await db.saveWhatsappAttribution({ ...base, whatsappMessageId: 'ad-2', receivedAt: new Date('2026-10-02T10:00:00Z'),
      attribution: { ...base.attribution, campaignId: 'campaign-2', campaignName: 'Campaña 2' } });
    await engine.exec(`INSERT INTO orders (organization_id, conversation_id, total_price, status, created_at)
      VALUES (1, 1, '$27.000', 'confirmed', '2026-10-02T11:00:00Z')`);

    const report = await db.getWhatsappAttributionReport(1);
    assert.equal(Number(report.totals.revenue), 27000);
    assert.equal(report.totals.orders, 1);
    assert.equal(report.summary.find(row => row.campaign_key === 'campaign-1').orders, 0);
    assert.equal(report.summary.find(row => row.campaign_key === 'campaign-2').orders, 1);
    assert.equal(report.records.find(row => row.campaign_id === 'campaign-1').orders, 0);
    assert.equal(report.records.find(row => row.campaign_id === 'campaign-2').orders, 1);

    await engine.exec(`
      INSERT INTO orders (organization_id, conversation_id, total_price, status, items, created_at)
      VALUES
        (1, 1, '$27.000', 'entregado', '[{"name":"Huevos XL","quantity":2}]', '2026-10-03 01:00:00'),
        (1, 1, '$99.000', 'cancelled', '[]', '2026-10-02 18:00:00')
    `);
    const buyers = await db.getWhatsappBuyerReport(1, { from: '2026-10-02', to: '2026-10-02' });
    assert.equal(buyers.basis, 'purchase');
    assert.equal(buyers.totals.contacts, 1);
    assert.equal(buyers.totals.orders, 2);
    assert.equal(Number(buyers.totals.revenue), 54000);
    assert.equal(buyers.totals.ordersPerBuyer, 2);
    assert.equal(buyers.summary.length, 1);
    assert.equal(buyers.summary[0].campaign_key, 'campaign-2');
    assert.equal(buyers.records.length, 1);
    assert.equal(buyers.records[0].orders, 2);
    assert.match(buyers.records[0].latest_order_items, /Huevos XL/);
  } finally {
    await engine.close();
  }
});

test('recupera pedidos manuales de una incidencia por canal sin cruzar organizaciones', async () => {
  const engine = new PGlite();
  class Pool {
    async query(sql, params) {
      const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    }
  }
  const db = load('src/db/database.js', { pg: { Pool } });
  try {
    await engine.exec(`
      CREATE TABLE whatsapp_channels (
        id INT PRIMARY KEY, organization_id INT NOT NULL, provider TEXT NOT NULL
      );
      CREATE TABLE conversations (
        id INT PRIMARY KEY, organization_id INT NOT NULL, whatsapp_channel_id INT,
        contact_name TEXT, phone_number TEXT
      );
      CREATE TABLE orders (
        id INT PRIMARY KEY, organization_id INT NOT NULL, conversation_id INT NOT NULL,
        customer_phone TEXT, total_price TEXT, status TEXT, items TEXT, created_at TIMESTAMP
      );
      CREATE TABLE shopify_orders (
        id INT PRIMARY KEY, organization_id INT NOT NULL, customer_phone TEXT,
        financial_status TEXT, shopify_created_at TIMESTAMP
      );
      CREATE TABLE whatsapp_attributions (
        id SERIAL PRIMARY KEY, organization_id INT NOT NULL, conversation_id INT NOT NULL,
        message_id INT, whatsapp_message_id TEXT NOT NULL, provider TEXT NOT NULL,
        source_type TEXT, source_id TEXT, source_url TEXT, ctwa_clid TEXT,
        headline TEXT, body TEXT, media_type TEXT, media_url TEXT,
        campaign_id TEXT, campaign_name TEXT, adset_id TEXT, adset_name TEXT,
        ad_id TEXT, ad_name TEXT, raw_json JSONB,
        first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
        UNIQUE (organization_id, provider, whatsapp_message_id)
      );
      INSERT INTO whatsapp_channels VALUES (10, 1, 'evolution'), (20, 2, 'evolution');
      INSERT INTO conversations VALUES
        (1, 1, 10, 'Primera compra', '56911112222'),
        (2, 1, 10, 'Cliente anterior', '56933334444'),
        (3, 2, 20, 'Otra empresa', '56911112222');
      INSERT INTO orders VALUES
        (1, 1, 1, '56911112222', '$12.000', 'entregado', '[]', '2026-10-12 15:00:00'),
        (2, 1, 2, '56933334444', '$10.000', 'entregado', '[]', '2026-10-11 12:00:00'),
        (3, 1, 2, '56933334444', '$11.000', 'entregado', '[]', '2026-10-12 16:00:00'),
        (4, 2, 3, '56911112222', '$99.000', 'entregado', '[]', '2026-10-12 17:00:00');
    `);

    const recovered = await db.recoverWhatsappAttributionsFromOrders(1, 7, {
      from: '2026-10-12', to: '2026-10-13', provider: 'evolution',
      campaignName: 'Recuperación Evolution', firstPurchaseOnly: true,
    });
    assert.equal(recovered.recovered, 1);
    assert.equal(recovered.revenue, 12000);
    assert.equal(recovered.records[0].order_id, 1);

    const repeated = await db.recoverWhatsappAttributionsFromOrders(1, 7, {
      from: '2026-10-12', to: '2026-10-13', provider: 'evolution',
      campaignName: 'Recuperación Evolution', firstPurchaseOnly: true,
    });
    assert.equal(repeated.recovered, 0);

    const report = await db.getWhatsappBuyerReport(1, {
      from: '2026-10-12', to: '2026-10-13', provider: 'evolution',
    });
    assert.equal(report.totals.buyers, 1);
    assert.equal(report.totals.orders, 1);
    assert.equal(Number(report.totals.revenue), 12000);
    assert.equal(report.records[0].precision, 'recuperada');

    const crossTenant = await engine.query('SELECT COUNT(*)::int AS count FROM whatsapp_attributions WHERE organization_id = 2');
    assert.equal(crossTenant.rows[0].count, 0);
  } finally {
    await engine.close();
  }
});
