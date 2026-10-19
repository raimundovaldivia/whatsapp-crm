const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

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
      assert.equal(org, 7); assert.equal(limit, 8); assert.equal(excludePersonal, true);
      return [{ direction: 'inbound', content: 'Gracias', created_at: '2026-10-06T12:00:00Z' }];
    },
  };
  const drafts = load('src/services/broadcast-drafts.js', {
    '../db/database': database,
    './ai-provider': { modelFor: tier => { assert.equal(tier, 'fast'); return 'configured-fast-model'; } },
    './customer-identity': { resolveCustomerPhones: async (_pool, org, phone) => { assert.equal(org, 7); return [phone]; } },
  });
  return { drafts, database, calls };
}

test('individual drafting uses scoped history and never queues or sends; unknown, business and opt-out contacts are excluded', async () => {
  const { drafts, calls } = setup();
  let generations = 0;
  const anthropic = { messages: { create: async request => {
    generations++;
    assert.equal(request.model, 'configured-fast-model');
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
  assert.equal(calls.length, 2);
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
