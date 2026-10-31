const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response } = require('./helpers.cjs');
const rules = require('../src/services/conversation-review-rules');
const store = require('../src/services/conversation-review-store');
const { loadContext } = require('../src/services/conversation-review-context');
const { analyzeStep, finalize } = require('../src/services/conversation-review');
const now = new Date('2026-10-31T15:00:00Z');
const msg = (id, content, extra = {}) => ({ id, direction: 'inbound', content, type: 'text', created_at: `2026-10-30T12:${String(id % 60).padStart(2, '0')}:00Z`, ...extra });
const context = messages => ({ contacts: [{ name: 'Cliente', opt_out: false, client_type: 'personal' }], messages, totalMessages: messages.length, orderEvents: [], campaigns: [] });

test('uses Chile calendar week; a pending or cancelled order excludes without fabricating a paid purchase', () => {
  assert.deepEqual(rules.businessWeek(new Date('2026-11-02T01:00:00Z')), { today: '2026-11-01', start: '2026-10-26' });
  const c = context([msg(1, 'Hola')]);
  for (const status of ['nuevo', 'cancelled', 'paid']) {
    c.orderEvents = [{ date: '2026-10-26T05:00:00Z', status }];
    assert.ok(rules.eligibility(c, now).reasons.some(r => r.code === 'ordered_this_week'));
  }
  c.orderEvents = [{ date: '2026-10-26T01:00:00Z', status: 'paid' }];
  assert.equal(rules.eligibility(c, now).eligible, true);
});
test('product negation is not a refusal; thanks after a refusal does not resurrect intent', () => {
  for (const content of ['NO huevos blancos', 'No necesito factura', 'No quiero queso', 'No quiero huevos blancos', 'No quiero recibir huevos blancos']) {
    assert.equal(rules.eligibility(context([msg(1, content)]), now).eligible, true, content);
  }
  const c = context([msg(1, 'Quiero dos bandejas'), msg(2, 'Ya no necesito'), msg(3, 'Gracias')]);
  assert.equal(rules.eligibility(c, now).eligible, false);
  c.messages.push(msg(4, 'Ahora quiero dos bandejas XL'));
  assert.equal(rules.eligibility(c, now).eligible, true);
});
test('old opt-out survives more than 80 messages and personal campaign refusal is contextual', () => {
  const messages = [msg(1, 'No me escriban más', { created_at: '2026-01-01T12:00:00Z' }), ...Array.from({ length: 100 }, (_, i) => msg(i + 2, 'Gracias'))];
  assert.ok(rules.eligibility(context(messages), now).reasons.some(r => r.code === 'opt_out'));
  assert.equal(rules.eligibility(context([msg(1, 'NO')]), now).eligible, true);
  assert.equal(rules.eligibility(context([msg(1, 'Si no quieres recibir promociones, responde NO', { direction: 'outbound' }), msg(2, 'NO')]), now).eligible, false);
});
test('chunks preserve the whole history, including a long message and exact cited inbound evidence', () => {
  const messages = [msg(1, 'a'.repeat(30000) + ' No quiero blancos.'), msg(2, 'Gracias')];
  const parts = rules.messageChunks(messages).flat();
  assert.equal(parts.filter(p => p.id === '1').map(p => p.text).join(''), messages[0].content);
  assert.ok(rules.messageChunks(messages).length > 1);
  const fact = { kind: 'preference', value: 'Evitar blancos', messageId: '1', quote: 'No quiero blancos.' };
  assert.equal(rules.evidenceFacts([fact], messages)[0].quote, fact.quote);
  assert.throws(() => rules.evidenceFacts([{ ...fact, quote: 'Quiere blancos' }], messages), /evidencia/);
  assert.throws(() => rules.evidenceFacts([fact], [{ ...messages[0], direction: 'outbound' }]), /evidencia/);
});
test('incomplete media, invented citations, uncited boxes and unvalidated prices never become usable drafts', () => {
  const facts = [{ kind: 'product', value: 'XL', messageId: '1', quote: 'XL' }];
  const raw = { decision: 'draft', priority: 'high', action: 'ask_interest', reason: 'Consultó XL', message: '¿Sigues buscando XL?', evidenceIds: ['1'] };
  const base = { coverage: { complete: true, mediaPending: 0 } };
  assert.equal(finalize(raw, facts, base).sendAllowed, false);
  assert.equal(finalize(raw, facts, base).probability, null);
  assert.equal(finalize(raw, facts, { coverage: { complete: false, mediaPending: 0 } }).message, '');
  assert.equal(finalize(raw, facts, { coverage: { complete: true, mediaPending: 1 } }).decision, 'manual');
  assert.equal(finalize({ ...raw, action: 'offer_box' }, facts, base).decision, 'manual');
  assert.equal(finalize({ ...raw, message: 'Te dejo una oferta por $9.000' }, facts, base).message, '');
  assert.throws(() => finalize({ ...raw, evidenceIds: ['999'] }, facts, base), /inexistente/);
});
test('phone imports validate each line and distinguish completed, stale and failed reviews', async () => {
  const ui = await import('../../frontend/src/utils/conversation-review.mjs');
  assert.deepEqual(ui.parseReviewPhones('+56 9 1111 1111\n911111111\n56922222222'), ['56911111111', '56922222222']);
  assert.throws(() => ui.parseReviewPhones('Ana 56911111111'), /teléfonos/);
  assert.throws(() => store.validateInput({ phones: ['56911111111', '911111111'], instruction: 'Revisar evidencia de compra' }), /duplicados/);
  assert.deepEqual(ui.reviewCounts([{ state: 'done', result: { decision: 'draft' } }, { state: 'stale' }, { state: 'error' }]),
    { total: 3, completed: 1, drafts: 1, excluded: 0, manual: 0, errors: 1, pending: 0, stale: 1 });
});

test('tenant-scoped history, durable claims, read-only analysis, invalidation and personal offer guard', async () => {
  const engine = new PGlite();
  const pool = { async query(sql, params) {
    const r = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...r, rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
  } };
  class Pool { query(...args) { return pool.query(...args); } async connect() { return { ...pool, release() {} }; } async end() {} }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
      INSERT INTO contacts(organization_id,phone,name,email) VALUES(1,'56911111111','Ana','a@example.com'),(1,'56922222222','Ana','a@example.com'),(2,'56911111111','Otra persona',NULL);
      INSERT INTO conversations(id,organization_id,phone_number) VALUES(1,1,'911111111'),(2,1,'56922222222'),(3,2,'56911111111');
      INSERT INTO messages(conversation_id,direction,content,created_at) VALUES
        (1,'inbound','Quisiera huevos XL','2026-10-30T12:00:00Z'),(2,'inbound','No huevos blancos','2026-10-30T12:01:00Z'),(3,'inbound','Dato de otra tienda','2026-10-30T12:02:00Z');
      INSERT INTO products(id,organization_id,title,price,stock,unit_cost,min_margin_pct) VALUES(1,1,'Bandeja XL café',10000,10,6000,25);
      INSERT INTO orders(organization_id,customer_phone,created_at,status,items) VALUES(2,'56911111111','2026-10-30T12:00:00Z','paid','[]');`);
    const c = await loadContext(pool, 1, '56911111111', now);
    assert.equal(c.messages.length, 2);
    assert.equal(c.orderEvents.length, 0);
    assert.equal(c.messages.some(m => m.content.includes('otra tienda')), false);
    await engine.exec(`INSERT INTO users(id,organization_id,email,password_hash,name,role) VALUES(99,1,'staff@example.com','test','Staff','agent');
      INSERT INTO whatsapp_channels(id,organization_id,name,provider,assigned_user_id,evolution_api_url,evolution_instance,webhook_token)
        VALUES(99,1,'Personal','evolution',99,'https://example.com','personal','test');
      INSERT INTO conversations(id,organization_id,phone_number,whatsapp_channel_id) VALUES(99,1,'56911111111',99);
      INSERT INTO messages(conversation_id,direction,content) VALUES(99,'inbound','Conversación personal excluida');`);
    assert.equal((await loadContext(pool, 1, '56911111111', now)).messages.length, 2);
    const id = await store.create(pool, 1, 1, { phones: ['56911111111'], instruction: 'Revisar interés real, sin enviar mensajes.' });
    await assert.rejects(() => store.get(pool, 2, id), /no encontrada/);
    assert.equal((await store.list(pool, 2)).length, 0);
    const first = await store.claim(pool, 1, id);
    assert.equal(await store.claim(pool, 1, id), null, 'an in-flight step is not duplicated');
    assert.equal(await store.claim(pool, 2, id), null);
    let calls = 0;
    const ai = { messages: { create: async request => {
      calls++;
      const isExtraction = !!request.tools[0].input_schema.properties.facts;
      const input = isExtraction ? { facts: [{ kind: 'product', value: 'Interés por XL', messageId: String(c.messages[0].id), quote: 'Quisiera huevos XL' }] }
        : { decision: 'draft', priority: 'medium', action: 'clarify_product', reason: 'Interés por XL con color pendiente', message: 'Hola Ana, ¿te interesan huevos XL cafés?', evidenceIds: [String(c.messages[0].id)] };
      return { content: [{ type: 'tool_use', name: 'review', input }] };
    } } };
    const step1 = await analyzeStep(pool, 1, first.phone, 'Revisar interés real, sin enviar mensajes.', null, ai, now);
    assert.equal(step1.done, false);
    await store.finish(pool, 1, first, step1);
    const second = await store.claim(pool, 1, id);
    const step2 = await analyzeStep(pool, 1, second.phone, 'Revisar interés real, sin enviar mensajes.', second.result, ai, now);
    await store.finish(pool, 1, second, step2);
    assert.equal(calls, 2); assert.equal(step2.done, true); assert.equal(step2.result.decision, 'draft');
    assert.equal(step2.result.sendAllowed, false);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM broadcast_jobs')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM campaign_offers')).rows[0].n, 0);
    const router = load('src/routes/conversation-reviews.js', {
      '../db/database': { getPool: () => pool }, '../services/conversation-review-store': store,
      '../services/conversation-review': { analyzeStep }, '../services/conversation-review-context': { loadContext },
      '../services/conversation-review-rules': rules,
      '../services/campaign-offers': require('../src/services/campaign-offers'),
    });
    await pool.query(`UPDATE conversation_review_contacts SET result = result || $3::jsonb WHERE organization_id = $1 AND run_id = $2`,
      [1, id, JSON.stringify({ businessDate: rules.businessWeek().today })]);
    const offerHandler = handler(router, 'post', `/${id}/offer`);
    const offerRequest = { orgId: 1, params: { id }, body: { phone: first.phone, productId: '1', price: 8000, quantity: 2, expiresAt: '2100-01-01T13:00' } };
    let offered = response(); await offerHandler(offerRequest, offered);
    assert.equal(offered.code, 200, JSON.stringify(offered.body));
    assert.equal(offered.body.offer.active, false);
    assert.match(offered.body.message, /únicamente para tu número de WhatsApp \+56911111111/);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM campaign_offers')).rows[0].n, 0);
    offered = response(); await offerHandler({ ...offerRequest, body: { ...offerRequest.body, price: 7500 } }, offered);
    assert.equal(offered.code, 400, '25% gross margin needs a price of at least 8000 for cost 6000');
    offered = response(); await offerHandler({ ...offerRequest, body: { ...offerRequest.body, quantity: 11 } }, offered);
    assert.equal(offered.code, 400);
    offered = response(); await offerHandler({ ...offerRequest, orgId: 2 }, offered);
    assert.equal(offered.code, 404);
    const original = rules.snapshot(c, 'objective');
    await engine.exec("INSERT INTO messages(conversation_id,direction,content) VALUES(1,'inbound','Ya no necesito')");
    const changed = await loadContext(pool, 1, first.phone, now);
    assert.notEqual(rules.snapshot(changed, 'objective'), original);
    await store.invalidate(pool, 2, id, first.phone, step2.result.sourceHash);
    assert.equal((await store.get(pool, 1, id)).contacts[0].state, 'done');
    await store.invalidate(pool, 1, id, first.phone, step2.result.sourceHash);
    const invalid = (await store.get(pool, 1, id)).contacts[0];
    assert.equal(invalid.state, 'stale'); assert.equal(invalid.result.message, '');
    await store.retry(pool, 1, id);
    assert.equal((await store.get(pool, 1, id)).contacts[0].state, 'pending');
  } finally { await engine.close(); }
});

test('review implementation has no transport or campaign enqueue capability', () => {
  for (const file of ['conversation-review.js', 'conversation-review-store.js', 'conversation-review-rules.js']) {
    const source = fs.readFileSync(require.resolve(`../src/services/${file}`), 'utf8');
    assert.doesNotMatch(source, /require\(['"].*(?:whatsapp|broadcast-worker|outbound-message-queue)/);
    assert.doesNotMatch(source, /INSERT INTO (?:broadcast_jobs|broadcast_campaigns|campaign_offers)/);
  }
});
