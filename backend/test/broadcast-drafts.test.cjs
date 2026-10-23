const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

test('transactional messages, failures and old temporary declines preserve customers; true opt-outs remain blocked', () => {
  const { drafts } = setup();
  const today = '2026-10-22';
  const recent = '2026-10-21T15:00:00Z';
  assert.equal(drafts.messageSafety([{ direction: 'outbound', content: 'Pedido entregado', created_at: recent }], today).unansweredRecentOutreach, false);
  for (const campaign of [{ result_status: 'failed' }, { result_status: 'accepted', status: 'failed' }]) {
    assert.equal(drafts.messageSafety([], today, [{ ...campaign, created_at: recent }]).unansweredRecentOutreach, false);
  }
  for (const content of ['No gracias, esta semana no necesito huevos.', 'No quiero comprar ahora.']) {
    const old = { direction: 'inbound', content, created_at: '2026-09-01T15:00:00Z' };
    assert.equal(drafts.messageSafety([old], today).explicitDecline, false);
    assert.equal(drafts.messageSafety([old], today).recentDecline, false);
    assert.equal(drafts.messageSafety([{ ...old, created_at: recent }], today).recentDecline, true);
    assert.equal(drafts.messageSafety([{ ...old, created_at: recent }, { direction: 'inbound', content: 'Ahora quiero dos bandejas.', created_at: '2026-10-21T16:00:00Z' }], today).recentDecline, false);
  }
  for (const content of ['No me escriban más.', 'No quiero recibir más mensajes.', 'STOP', 'Darme de baja']) {
    assert.equal(drafts.messageSafety([{ direction: 'inbound', content, created_at: '2026-09-01T15:00:00Z' }], today).explicitDecline, true);
  }
  assert.equal(drafts.messageSafety([], today, [{ result_status: 'unknown', created_at: recent }]).unansweredRecentOutreach, true);
});

test('100 selected customers keep 80 valid drafts and report 20 real exclusions', async () => {
  const { drafts, database } = setup();
  const day = require('../src/services/business-date').todayISOChile();
  database.getContact = async (_org, phone) => ({ name: 'Cliente', opt_out: phone.endsWith('4') });
  database.getMessagesByCustomerPhone = async () => [
    { direction: 'inbound', content: 'No gracias, esta semana no necesito.', created_at: '2020-01-01T15:00:00Z' },
    { direction: 'outbound', content: 'Tu pedido fue entregado.', created_at: day + 'T15:00:00Z' },
  ];
  database.getPool = () => ({ query: async (sql, params) => {
    assert.equal(params[0], 7);
    if (!sql.includes('broadcast_campaign_recipients')) return { rows: [] };
    assert.match(sql, /r.organization_id = \$1/);
    assert.match(sql, /destination_phone = ANY/);
    const phone = params[1][0];
    return { rows: phone.endsWith('5') ? [{ result_status: 'accepted', created_at: day + 'T15:00:00Z' }] :
      phone.endsWith('6') ? [{ result_status: 'accepted', status: 'failed', created_at: day + 'T15:00:00Z' }] : [] };
  } });
  const ai = { messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'customer_draft', input: {
    decision: 'draft', message: 'Hola, ¿quieres conocer nuestros productos?', reason: 'Consulta de interés.',
  } }] }) } };
  const phones = Array.from({ length: 100 }, (_, i) => String(56910000000 + i));
  const all = [];
  for (let i = 0; i < phones.length; i += 10) {
    const result = await drafts.generateDrafts(7, { instruction: 'Consulta interés en productos disponibles.', phones: phones.slice(i, i + 10) }, ai);
    all.push(...result.drafts);
  }
  assert.equal(all.length, 100);
  assert.equal(all.filter(d => d.decision === 'draft').length, 80);
  assert.equal(all.filter(d => d.reasonCode === 'opt_out').length, 10);
  assert.equal(all.filter(d => d.reasonCode === 'recent_campaign').length, 10);
});

test('campaign lookup executes in SQL and isolates tenant, phone, personal channels and failed deliveries', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const engine = new PGlite();
  const { drafts, calls } = setup();
  try {
    await drafts.generateDrafts(7, { instruction: 'Consulta interés en productos.', phones: ['56911111111'] }, {
      messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'customer_draft', input: {
        decision: 'draft', message: 'Hola, ¿necesitas huevos?', reason: 'Consulta de interés.',
      } }] }) },
    });
    const sql = calls.find(call => call.sql.includes('broadcast_campaign_recipients')).sql;
    await engine.exec(`CREATE TABLE broadcast_campaigns(id INT, organization_id INT, sending_channel_id INT);
      CREATE TABLE whatsapp_channels(id INT, organization_id INT, assigned_user_id INT);
      CREATE TABLE conversations(id INT, organization_id INT);
      CREATE TABLE messages(conversation_id INT, whatsapp_message_id TEXT, status TEXT);
      CREATE TABLE broadcast_campaign_recipients(campaign_id INT, organization_id INT, destination_phone TEXT,
        whatsapp_message_id TEXT, template_name TEXT, result_status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO whatsapp_channels VALUES(1,7,NULL),(2,7,99);
      INSERT INTO conversations VALUES(1,7),(2,8);
      INSERT INTO broadcast_campaigns VALUES(1,7,1),(2,7,2),(3,8,NULL),(4,7,NULL);
      INSERT INTO messages VALUES(1,'failed','failed'),(2,'other-tenant','failed');
      INSERT INTO broadcast_campaign_recipients(campaign_id,organization_id,destination_phone,whatsapp_message_id,result_status)
        VALUES(1,7,'56911111111','accepted','accepted'),(1,7,'56911111111','failed','accepted'),
        (1,7,'56911111111','other-tenant','unknown'),(2,7,'56911111111','personal','accepted'),
        (3,8,'56911111111','other','accepted'),(1,7,'56922222222','other-phone','accepted'),
        (1,7,'56911111111','definite-failure','failed'),(4,7,'56911111111','official','accepted');`);
    const { rows } = await engine.query(sql, [7, ['56911111111']]);
    assert.equal(rows.length, 4);
    assert.equal(rows.filter(row => row.status === 'failed').length, 1);
    assert.equal(rows.find(row => row.result_status === 'unknown').status, null);
  } finally { await engine.close(); }
});

function setup() {
  const calls = [];
  const database = {
    normalizePhone: phone => String(phone).replace(/\D/g, ''),
    getSetting: async org => { assert.equal(org, 7); return 'Aceitunas verdes 500 g $3.700'; },
    getOrgById: async org => { assert.equal(org, 7); return { name: 'Negocio de prueba' }; },
    getProducts: async () => [],
    getContact: async (org, phone) => { assert.equal(org, 7); return phone === '56999999999' ? null : { name: 'Ana', client_type: phone === '56922222222' ? 'empresa' : 'natural', opt_out: phone === '56933333333' }; },
    getPool: () => ({ query: async (sql, params) => {
      assert.match(sql, /organization_id = \$1/);
      assert.equal(params[0], 7);
      calls.push({ sql, params });
      return { rows: sql.includes('shopify_orders') ? [{ date: '2026-10-06T12:00:00Z', items: [{ title: 'JUMBO20', quantity: 1 }], status: 'PAID' }] : [] };
    } }),
    getMessagesByCustomerPhone: async (org, phone, limit, excludePersonal) => {
      assert.equal(org, 7); assert.equal(limit, 80); assert.equal(excludePersonal, true);
      return [{ direction: 'inbound', content: 'Gracias', created_at: '2026-10-06T12:00:00Z' }];
    },
  };
  const drafts = load('src/services/broadcast-drafts.js', {
    '../db/database': database,
    './ai-provider': { modelFor: tier => { assert.equal(tier, 'smart'); return 'configured-smart-model'; } },
    './customer-identity': { resolveCustomerPhones: async (_pool, org, phone) => { assert.equal(org, 7); return [phone]; } },
  });
  return { drafts, database, calls };
}

test('individual drafting uses scoped history and never queues or sends; unknown, business and opt-out contacts are excluded', async () => {
  const { drafts, calls } = setup();
  let generations = 0;
  const anthropic = { messages: { create: async request => {
    generations++;
    assert.equal(request.model, 'configured-smart-model');
    const payload = JSON.parse(request.messages[0].content);
    assert.equal(payload.cliente.compras.intervaloMedianoDias, null);
    assert.equal(payload.cliente.compras.pedidos[0].productos[0].cantidad, 1);
    assert.equal(payload.cliente.conversacionReciente[0].texto, 'Gracias');
    assert.equal(payload.cliente.phone, undefined);
    assert.match(request.system, /Nunca envías ni autorizas/);
    return { content: [{ type: 'tool_use', name: 'customer_draft', input: {
      decision: 'draft', message: 'Ana, ¿cómo te resultó tu bandeja? También tenemos aceitunas verdes.', reason: 'Una compra; consultar experiencia, sin asumir frecuencia.',
    } }] };
  } } };
  const result = await drafts.generateDrafts(7, { phones: ['56911111111', '56922222222', '56933333333', '56999999999'], instruction: 'Consulta reposición e incluye aceitunas.', audienceType: 'natural' }, anthropic);
  assert.equal(generations, 1);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.drafts.filter(d => d.decision === 'skip').length, 3);
  assert.equal(result.drafts[0].message.includes('aceitunas'), true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => /^SELECT/.test(call.sql)));
});

test('invalid inputs and malformed AI outputs fail closed', async () => {
  const { drafts } = setup();
  for (const body of [null, { instruction: 'ok', phones: [] }, { instruction: 'Oferta de mañana', phones: ['56911111111', '+56911111111'] },
    { instruction: 'Oferta de mañana', phones: ['phone; SELECT'] }, { instruction: 'Oferta de mañana', phones: Array(13).fill('56911111111') }]) {
    assert.throws(() => drafts.validateRequest(body));
  }
  for (const raw of [{ decision: 'draft', reason: 'bien', message: '{{nombre}}' }, { decision: 'send', reason: 'bien', message: 'Hola' },
    { decision: 'draft', reason: 'bien', message: '' }, { decision: 'draft', reason: 'bien', message: 'x'.repeat(1201) }]) {
    assert.throws(() => drafts.validateDraft(raw, {}));
  }
  await assert.rejects(drafts.generateDrafts(7, { instruction: 'Reponer huevos mañana', phones: ['56911111111'] }, { messages: { create: async () => ({ content: [] }) } }), /incompleto/);
});

test('purchase cycle uses distinct Chile business dates and excludes cancelled orders', () => {
  const { drafts } = setup();
  const result = drafts.purchaseSummary([
    { date: '2026-10-19T01:00:00Z', status: 'PAID', items: [] }, // Chile: October 18
    { date: '2026-10-18T15:00:00Z', status: 'PAID', items: [] },
    { date: '2026-10-08T15:00:00Z', status: 'PAID', items: [] },
    { date: '2026-10-20T15:00:00Z', status: 'CANCELLED', items: [] },
  ], '2026-10-19');
  assert.equal(result.fechasDistintas, 2);
  assert.equal(result.ultimaCompra, '2026-10-18');
  assert.equal(result.intervaloMedianoDias, 10);
  assert.equal(result.diasDesdeCompra, 1);
});

test('old unanswered campaigns do not exclude a re-engagement draft, while a recent contact or explicit decline does', () => {
  const { drafts } = setup();
  const oldOutbound = drafts.messageSafety([], '2026-10-22', [{ result_status: 'accepted', created_at: '2026-10-03T15:00:00Z' }]);
  assert.equal(oldOutbound.unansweredRecentOutreach, false);
  assert.equal(oldOutbound.explicitDecline, false);

  const recentOutbound = drafts.messageSafety([], '2026-10-22', [{ result_status: 'accepted', created_at: '2026-10-21T15:00:00Z' }]);
  assert.equal(recentOutbound.unansweredRecentOutreach, true);

  const answeredOutreach = drafts.messageSafety([
    { direction: 'outbound', content: 'Oferta anterior', created_at: '2026-10-20T15:00:00Z' },
    { direction: 'outbound', content: 'Oferta reciente', created_at: '2026-10-21T15:00:00Z' },
    { direction: 'inbound', content: 'Hola, lo reviso', created_at: '2026-10-21T16:00:00Z' },
  ], '2026-10-22', [{ result_status: 'accepted', created_at: '2026-10-21T15:00:00Z' }]);
  assert.equal(answeredOutreach.unansweredRecentOutreach, false);

  const decline = drafts.messageSafety([{ direction: 'inbound', content: 'No gracias, no me escriban más.', created_at: '2026-09-01T15:00:00Z' }], '2026-10-22');
  assert.equal(decline.explicitDecline, true);
});

test('approval binds exact message, recipient and order; generation cannot authorize', async () => {
  const { drafts } = setup();
  const items = [{ phone: '56911111111', message: 'Hola Ana, ¿necesitas huevos?' }];
  const approval = { confirmed: true, fingerprint: drafts.fingerprint(items) };
  assert.doesNotThrow(() => drafts.validateApproval(items, approval));
  assert.throws(() => drafts.validateApproval(items, { ...approval, confirmed: false }));
  assert.throws(() => drafts.validateApproval([{ ...items[0], message: 'Otro precio' }], approval));
  assert.throws(() => drafts.validateApproval([{ ...items[0], phone: '56922222222' }], approval));
  const ui = await import('../../frontend/src/utils/broadcast-drafts.mjs');
  const entries = items.map(item => ({ item }));
  assert.equal(await ui.reviewFingerprint(entries), approval.fingerprint);
  assert.equal(ui.canApproveDrafts({ entries }, new Set()), false);
  assert.equal(ui.canApproveDrafts({ entries }, new Set([0])), true);
  const edited = ui.editReviewedEntry({ entries }, 0, 'Texto corregido');
  assert.notEqual(await ui.reviewFingerprint(edited.entries), approval.fingerprint);
  assert.equal(edited.entries[0].item.message, edited.entries[0].previewText);
});

test('generate route preserves role guard and returns drafts without starting a campaign', async () => {
  const { drafts } = setup();
  let generated = 0;
  let checked = 0;
  const router = load('src/routes/reengagement.js', {
    '@anthropic-ai/sdk': class {},
    '../middleware/auth': { requireAuth: noop, requireRole: (...roles) => { assert.deepEqual(roles, ['owner', 'admin', 'supervisor']); checked++; return noop; } },
    '../services/commercial': { assertModule: async (org, module) => { assert.equal(org, 7); assert.equal(module, 'marketing'); } },
    '../services/broadcast-drafts': { ...drafts, generateDrafts: async (org) => { assert.equal(org, 7); generated++; return { drafts: [], requiresApproval: true }; } },
  });
  let res = response();
  await handler(router, 'post', '/generate')({ orgId: 7, body: { phones: ['bad'], instruction: 'Oferta de mañana' } }, res);
  assert.equal(res.code, 400); assert.equal(generated, 0);
  res = response();
  await handler(router, 'post', '/generate')({ orgId: 7, body: { phones: ['56911111111'], instruction: 'Oferta de mañana' } }, res);
  assert.equal(res.code, 200); assert.equal(generated, 1); assert.equal(checked, 1);
  assert.equal(res.body.requiresApproval, true);
});

test('instruction campaigns reject unapproved or changed texts, isolate tenants and enqueue only the authorized snapshot', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const engine = new PGlite();
  const { drafts } = setup();
  try {
    await engine.exec(`CREATE TABLE broadcast_campaigns (id BIGINT PRIMARY KEY, organization_id INT, total_count INT,
      sending_provider TEXT, sending_channel_id INT, server_managed BOOLEAN DEFAULT FALSE, status TEXT DEFAULT 'processing',
      pacing_settings JSONB, completed_at TIMESTAMPTZ);
      CREATE TABLE broadcast_jobs (id SERIAL, campaign_id BIGINT, organization_id INT, position INT, item JSONB);
      CREATE TABLE broadcast_campaign_recipients(campaign_id BIGINT);
      INSERT INTO broadcast_campaigns(id,organization_id,total_count,sending_provider,sending_channel_id,pacing_settings)
      VALUES(1,7,1,'evolution',3,'{"generationMode":"instruction"}');`);
    const pool = { query: (...args) => engine.query(...args), connect: async () => ({ query: (...args) => engine.query(...args), release() {} }) };
    const router = load('src/routes/reengagement.js', {
      '@anthropic-ai/sdk': class {}, '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
      '../db/database': { getPool: () => pool, normalizePhone: phone => phone },
      '../services/broadcast-sender': { resolveSender: async () => ({}) },
      '../services/broadcast-drafts': drafts,
    });
    const start = handler(router, 'post', '/campaigns/1/start');
    const items = [{ phone: '56911111111', message: 'Ana, ¿te sirven los huevos mañana?', contactName: 'Ana' }];
    const req = { orgId: 7, userId: 2, params: { id: 1 }, body: { items } };
    let res = response(); await start(req, res); assert.equal(res.code, 409);
    res = response(); await start({ ...req, orgId: 8 }, res); assert.equal(res.code, 404);
    const approval = { confirmed: true, fingerprint: drafts.fingerprint(items) };
    res = response(); await start({ ...req, body: { items: [{ ...items[0], message: 'Texto cambiado' }], approval } }, res);
    assert.equal(res.code, 409);
    res = response(); await handler(router, 'post', '/send-bulk')({ ...req, body: { items, campaignId: 1 } }, res);
    assert.equal(res.code, 409);
    assert.equal((await engine.query('SELECT * FROM broadcast_jobs')).rows.length, 0);
    res = response(); await start({ ...req, body: { items, approval } }, res); assert.equal(res.code, 200, JSON.stringify(res.body));
    res = response(); await start({ ...req, body: { items, approval } }, res); assert.equal(res.code, 200);
    const jobs = (await engine.query('SELECT * FROM broadcast_jobs')).rows;
    assert.equal(jobs.length, 1); assert.equal(jobs[0].item.message, items[0].message);
    const campaign = (await engine.query('SELECT * FROM broadcast_campaigns')).rows[0];
    assert.equal(campaign.pacing_settings.approval.approvedBy, 2);
    assert.equal(campaign.pacing_settings.approval.fingerprint, approval.fingerprint);
    res = response(); await handler(router, 'post', '/campaigns/1/stop')(req, res);
    assert.equal(res.body.campaign.status, 'interrupted');
  } finally { await engine.close(); }
});

test('drafts are checked against the operator price table and get the NO opt-out', () => {
  const { reviewDraftAgainstInstruction } = load('src/services/broadcast-drafts.js', {
    '@anthropic-ai/sdk': class {},
  });
  const instruction = 'Totales: XL 30 cafés: 1 $12.990, 2 $23.800, 3 $32.500. Jumbo 20 cafés: 1 $10.990, 2 $20.100, 3 $27.500. Una pregunta al final y la oferta de NO.';
  const base = { decision: 'draft', reason: 'ok', phone: '569', name: 'A' };
  const wrong = reviewDraftAgainstInstruction({ ...base, message: 'Hola, las 2 bandejas de XL cafés de 30 te quedan en $25.000 (ahorras $4.980). ¿Repetimos?' }, instruction);
  assert.equal(wrong.warnings.length, 2);
  assert.match(wrong.reason, /\$23\.800/);
  assert.match(wrong.reason, /\$2\.180/);
  assert.match(wrong.message, /responde NO\.$/);
  const right = reviewDraftAgainstInstruction({ ...base, message: 'Hola, 3 bandejas Jumbo cafés de 20 te quedan en $27.500 (ahorras $5.470). ¿Te preparo 3? Si no quieres más mensajes, responde NO.' }, instruction);
  assert.equal(right.warnings.length, 0);
  assert.equal(right.reason, 'ok');
  assert.equal(reviewDraftAgainstInstruction({ ...base, decision: 'skip' }, instruction).decision, 'skip');
});
