const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifyLead } = require('../src/services/lead-qualification');
const { load, handler, response, noop } = require('./helpers.cjs');

const inbound = content => [{ direction: 'inbound', content }];

test('una consulta de precio queda explorando aunque mencione el producto', () => {
  const result = qualifyLead({ messages: inbound('¿Cuánto cuesta la bandeja XL?') });
  assert.equal(result.temperature, 'exploring');
  assert.equal(result.score, 15);
  assert.equal(result.veryHotGate, false);
});

test('una cotización con cantidad no se confunde con intención explícita de compra', () => {
  const result = qualifyLead({ messages: inbound('Quiero una cotización de 2 bandejas XL') });
  assert.notEqual(result.temperature, 'very_hot');
  assert.equal(result.signals.quantity, true);
  assert.equal(result.signals.explicitPurchase, false);
});

test('muy caliente exige compra explícita, producto y cantidad concreta', () => {
  const result = qualifyLead({ messages: inbound('Quiero 2 bandejas XL') });
  assert.equal(result.temperature, 'very_hot');
  assert.equal(result.score, 65);
  assert.equal(result.veryHotGate, true);
});

test('distingue interés futuro, rechazo y pedido ganado', () => {
  assert.equal(qualifyLead({ messages: inbound('Quiero tres bandejas próximamente') }).temperature, 'future');
  assert.equal(qualifyLead({ messages: inbound('No gracias, ya no quiero comprar') }).temperature, 'discarded');
  assert.equal(qualifyLead({ messages: inbound('precio'), hasOrder: true }).temperature, 'won');
});

test('la evaluación guarda el estado anterior sin aplicar ni cruzar organizaciones', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT c\.id/.test(sql)) return { rows: [{ id: 11 }, { id: 12 }] };
    return { rows: [] };
  } };
  let applied = 0;
  const db = {
    getPool: () => pool,
    calculateLeadQualification: async (id, orgId) => ({
      conversation: {
        id, organization_id: orgId,
        pipeline_state: id === 11 ? 'interested' : 'exploring',
        lead_temperature: null, lead_score: 0, hot_lead_excluded: false,
        qualification_reasons: [], lead_signals: {}, updated_at: '2026-10-15T10:00:00Z',
      },
      qualification: {
        temperature: id === 11 ? 'very_hot' : 'exploring',
        score: id === 11 ? 65 : 15,
        reasons: ['evidencia'], signals: {}, veryHotGate: id === 11,
      },
    }),
    applyLeadQualification: async () => { applied++; },
  };
  const router = load('src/routes/conversations.js', {
    '../db/database': db,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const res = response();
  await handler(router, 'post', '/scan-hot-leads')({ orgId: 77, userId: 5, body: { limit: 200 } }, res);

  assert.equal(res.code, 200);
  assert.equal(applied, 0);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.summary.legacyHot, 1);
  assert.equal(res.body.veryHotLeadsFound, 1);
  const candidateQuery = calls.find(call => /SELECT c\.id/.test(call.sql));
  assert.deepEqual(Array.from(candidateQuery.params), [77, 200]);
  assert.equal(calls.filter(call => /INSERT INTO lead_qualification_audits/.test(call.sql)).length, 2);
});

test('la exclusión manual valida entrada y filtra por organización', async () => {
  const writes = [];
  const pool = { query: async (sql, params) => {
    writes.push({ sql, params });
    return { rows: [{ id: params[1], hot_lead_excluded: params[0] }] };
  } };
  const router = load('src/routes/conversations.js', {
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const route = handler(router, 'patch', '/:id/hot-lead-exclusion');
  const invalid = response();
  await route({ params: { id: '4' }, orgId: 8, body: { excluded: 'true' } }, invalid);
  assert.equal(invalid.code, 400);
  assert.equal(writes.length, 0);

  const valid = response();
  await route({ params: { id: '4' }, orgId: 8, body: { excluded: true } }, valid);
  assert.equal(valid.code, 200);
  assert.deepEqual(Array.from(writes[0].params), [true, 4, 8]);
  assert.match(writes[0].sql, /organization_id = \$3/);
});

test('aplicar una evaluación omite conversaciones que cambiaron desde el snapshot', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT \* FROM lead_qualification_runs/.test(sql)) {
        return { rows: [{ run_id: 'run-1', status: 'completed', applied: false, conversation_count: 2 }] };
      }
      if (/UPDATE conversations c/.test(sql)) return { rows: [{ id: 11 }] };
      return { rows: [] };
    },
    release() {},
  };
  const router = load('src/routes/conversations.js', {
    '../db/database': { getPool: () => ({ connect: async () => client }) },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const res = response();
  await handler(router, 'post', '/lead-qualification-runs/:runId/apply')({
    params: { runId: 'run-1' }, orgId: 77,
  }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.applied, 1);
  assert.equal(res.body.skippedChanged, 1);
  const applyQuery = calls.find(call => /UPDATE conversations c/.test(call.sql));
  assert.match(applyQuery.sql, /c\.organization_id = a\.organization_id/);
  assert.match(applyQuery.sql, /c\.updated_at IS NOT DISTINCT FROM a\.before_updated_at/);
});
