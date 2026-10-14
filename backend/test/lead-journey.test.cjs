const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyJourney, summarizeJourneys, explicitReason, isTrackableDestination, extractTrackingTokens, shouldCountTrackingRequest } = require('../src/services/lead-journey');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('marks an order as converted', () => {
  const result = classifyJourney({ orders_count: 1, silent_hours: 12, messages_count: 8 });
  assert.equal(result.stage, 'converted');
  assert.equal(result.outcome, 'converted');
  assert.equal(result.reason_source, 'observed');
});

test('distinguishes observed price objection from inferred silence', () => {
  const observed = classifyJourney({ pipeline_state: 'interested', recent_inbound_text: 'Gracias, pero está muy caro', silent_hours: 5 });
  assert.equal(observed.reason_code, 'price');
  assert.equal(observed.reason_source, 'observed');

  const inferred = classifyJourney({ pipeline_state: 'interested', recent_inbound_text: 'Quiero XL', silent_hours: 5 });
  assert.equal(inferred.reason_code, 'no_reply_after_offer');
  assert.equal(inferred.reason_source, 'inferred');
});

test('manual reason overrides an inference without changing a conversion', () => {
  const result = classifyJourney({ pipeline_state: 'interested', silent_hours: 6, limbo_reason_code: 'competitor' });
  assert.equal(result.reason_code, 'competitor');
  assert.equal(result.reason_source, 'manual');
});

test('keeps recent conversations active instead of calling them abandoned', () => {
  const result = classifyJourney({ pipeline_state: 'exploring', silent_hours: 1.5 });
  assert.equal(result.outcome, 'active');
  assert.equal(result.reason_code, 'active');
});

test('clasifica los motivos explícitos de no compra y prioriza la respuesta más reciente', () => {
  assert.equal(explicitReason('Disculpe pero no necesito... Gracias').code, 'no_need');
  assert.equal(explicitReason('YA NO NECESITO., YA COMPRÉ POR OTRO MEDIO').code, 'competitor');
  assert.equal(explicitReason('No necesito\nNo\nFue por precio').code, 'price');
});

test('cierra el análisis al completar la consulta y muestra la intención futura', () => {
  const result = classifyJourney({
    pipeline_state: 'future_interest',
    recent_inbound_text: 'No necesito\nSí, claro',
    silent_hours: 0.1,
    order_draft: JSON.stringify({
      purchase_feedback: { status: 'completed', future_consideration: true, reason: 'no_need' },
    }),
  });
  assert.equal(result.outcome, 'limbo');
  assert.equal(result.reason_code, 'no_need');
  assert.equal(result.future_purchase_intent, true);
});

test('prioriza el motivo confirmado por la consulta sobre el rechazo inicial', () => {
  const result = classifyJourney({
    pipeline_state: 'future_interest',
    recent_inbound_text: 'Ya no necesito\nNo\nFue por la atención',
    silent_hours: 0.1,
    order_draft: JSON.stringify({
      purchase_feedback: { status: 'completed', future_consideration: false, reason: 'service' },
    }),
  });
  assert.equal(result.reason_code, 'service');
  assert.equal(result.reason_label, 'Atención o servicio');
  assert.equal(result.future_purchase_intent, false);
});

test('summarizes funnel and response-time cohorts', () => {
  const data = summarizeJourneys([
    { orders_count: 1, first_response_at: '2026-10-13', first_response_minutes: 2, customer_reply_minutes: 5, messages_count: 8 },
    { pipeline_state: 'interested', first_response_at: '2026-10-13', first_response_minutes: 12, customer_reply_minutes: 20, messages_count: 4, silent_hours: 6 },
  ]);
  assert.equal(data.totals.contacts, 2);
  assert.equal(data.totals.converted, 1);
  assert.equal(data.totals.limbo, 1);
  assert.equal(data.totals.conversion_rate, 50);
  assert.equal(data.cohorts.converted.median_first_response_minutes, 2);
  assert.equal(data.cohorts.limbo.median_first_response_minutes, 12);
});

test('accepts only credential-free http(s) tracking destinations', () => {
  assert.equal(isTrackableDestination('https://diezrios.cl/producto/xl'), true);
  assert.equal(isTrackableDestination('javascript:alert(1)'), false);
  assert.equal(isTrackableDestination('https://user:secret@example.com/path'), false);
});

test('extracts sent tracking codes and excludes link-preview robots', () => {
  assert.deepEqual(extractTrackingTokens('Mira https://crm.test/r/abcdefghijkl y https://crm.test/r/abcdefghijkl.'), ['abcdefghijkl']);
  assert.equal(shouldCountTrackingRequest('GET', 'Mozilla/5.0'), true);
  assert.equal(shouldCountTrackingRequest('GET', 'facebookexternalhit/1.1'), false);
  assert.equal(shouldCountTrackingRequest('HEAD', 'Mozilla/5.0'), false);
});

test('journey query and tracking links preserve organization isolation', async () => {
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
      CREATE TABLE conversations (id SERIAL PRIMARY KEY, organization_id INT, contact_name TEXT, phone_number TEXT, pipeline_state TEXT, order_draft TEXT, limbo_reason_code TEXT, limbo_reason_note TEXT, limbo_reason_updated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
      CREATE TABLE messages (id SERIAL PRIMARY KEY, conversation_id INT, direction TEXT, content TEXT, created_at TIMESTAMP);
      CREATE TABLE orders (id SERIAL PRIMARY KEY, organization_id INT, conversation_id INT, status TEXT, created_at TIMESTAMP);
      CREATE TABLE whatsapp_attributions (
        id SERIAL PRIMARY KEY, organization_id INT, conversation_id INT, provider TEXT,
        source_url TEXT, headline TEXT, campaign_id TEXT, campaign_name TEXT, adset_name TEXT,
        ad_id TEXT, ad_name TEXT, first_seen_at TIMESTAMPTZ
      );
      CREATE TABLE conversation_tracking_links (
        id SERIAL PRIMARY KEY, organization_id INT, conversation_id INT, message_id INT,
        token TEXT UNIQUE, destination_url TEXT, link_kind TEXT, created_by INT,
        click_count INT DEFAULT 0, first_clicked_at TIMESTAMPTZ, last_clicked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO conversations VALUES
        (1,1,'Ana','56911111111','interested','{}'),
        (2,2,'Otra empresa','56922222222','interested','{}');
      INSERT INTO whatsapp_attributions
        (organization_id,conversation_id,provider,campaign_name,first_seen_at)
        VALUES (1,1,'kapso','Campaña XL','2026-10-13T10:00:00Z'),(2,2,'kapso','Ajena','2026-10-13T10:00:00Z');
      INSERT INTO messages (conversation_id,direction,content,created_at) VALUES
        (1,'inbound','Quiero XL','2026-10-13 10:00:00'),
        (1,'outbound','Tenemos bandejas XL','2026-10-13 10:03:00');
    `);
    const own = await db.createConversationTrackingLink({ organizationId: 1, conversationId: 1, token: 'abcdefghijkl', destinationUrl: 'https://diezrios.cl/xl', linkKind: 'product', createdBy: null });
    const foreign = await db.createConversationTrackingLink({ organizationId: 1, conversationId: 2, token: 'mnopqrstuvwx', destinationUrl: 'https://diezrios.cl/xl', linkKind: 'product', createdBy: null });
    assert.ok(own);
    assert.equal(foreign, null);
    assert.ok(await db.setConversationLimboReason(1, 1, 'price'));
    assert.equal(await db.setConversationLimboReason(1, 2, 'price'), null);
    const beforeSend = await db.getLeadJourneyRows(1, { from: '2026-10-13', to: '2026-10-13', provider: 'kapso' });
    assert.equal(beforeSend[0].tracked_links, 0);
    await db.attachConversationTrackingLinksToMessage(1, 1, 2, ['abcdefghijkl']);
    await db.recordConversationTrackingClick(own.id);
    const rows = await db.getLeadJourneyRows(1, { from: '2026-10-13', to: '2026-10-13', provider: 'kapso' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].conversation_id, 1);
    assert.equal(Number(rows[0].first_response_minutes), 3);
    assert.equal(rows[0].tracked_clicks, 1);
  } finally {
    await engine.close();
  }
});
