const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
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
  const result = qualifyLead({ messages: inbound('¿A cuánto salen 2 bandejas XL?') });
  assert.equal(result.temperature, 'interested');
  assert.equal(result.signals.quantity, true);
  assert.equal(result.signals.explicitPurchase, false);

  const requestedQuote = qualifyLead({ messages: inbound('Quiero una cotización de 2 bandejas XL') });
  assert.notEqual(requestedQuote.temperature, 'very_hot');
  assert.equal(requestedQuote.signals.explicitPurchase, false);
});

test('muy caliente exige compra explícita, producto y cantidad concreta', () => {
  const result = qualifyLead({ messages: inbound('Quiero 2 bandejas XL') });
  assert.equal(result.temperature, 'very_hot');
  assert.equal(result.score, 65);
  assert.equal(result.veryHotGate, true);

  const progressed = qualifyLead({ messages: [
    { direction: 'inbound', content: 'Quiero saber el precio de las XL' },
    { direction: 'inbound', content: 'Perfecto, quiero 2 bandejas XL' },
  ] });
  assert.equal(progressed.temperature, 'very_hot');
});

test('distingue interés futuro, rechazo y pedido ganado', () => {
  assert.equal(qualifyLead({ messages: inbound('Quiero tres bandejas próximamente') }).temperature, 'future');
  assert.equal(qualifyLead({ messages: inbound('No gracias, ya no quiero comprar') }).temperature, 'discarded');
  assert.equal(qualifyLead({ messages: inbound('precio'), hasOrder: true }).temperature, 'won');
});

test('la recalificación persiste razones sin cruzar organizaciones', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool { query(...args) { return query(...args); } async end() {} }
  try {
    await engine.exec(`
      CREATE TABLE conversations (
        id INT PRIMARY KEY, organization_id INT NOT NULL, pipeline_state TEXT,
        order_draft TEXT DEFAULT '{}', lead_temperature TEXT, lead_score INT DEFAULT 0,
        qualification_reasons JSONB DEFAULT '[]', lead_signals JSONB DEFAULT '{}',
        qualified_at TIMESTAMPTZ, last_inbound_at TIMESTAMPTZ,
        last_message_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY, conversation_id INT, direction TEXT, content TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY, conversation_id INT, organization_id INT, status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO conversations (id, organization_id, pipeline_state) VALUES
        (1, 10, 'interested'), (2, 20, 'interested');
      INSERT INTO messages (conversation_id, direction, content) VALUES
        (1, 'inbound', '¿Cuánto cuesta la bandeja XL?'),
        (2, 'inbound', 'Quiero 2 bandejas XL');
      INSERT INTO orders (conversation_id, organization_id, status, created_at)
        VALUES (1, 10, 'delivered', NOW() - INTERVAL '30 days');
    `);
    const db = load('src/db/database.js', {
      pg: { Pool },
      '../services/lead-qualification': require('../src/services/lead-qualification'),
    });

    await db.updatePipelineState(1, 'interested');
    const untouched = (await engine.query('SELECT lead_temperature FROM conversations WHERE id = 1')).rows[0];
    assert.equal(untouched.lead_temperature, null, 'el baseline legado permanece intacto hasta evaluarlo');

    const own = await db.refreshLeadQualification(1, 10);
    assert.equal(own.lead_temperature, 'exploring');
    assert.deepEqual(Array.from(own.qualification_reasons), ['Consultó precio', 'Definió un producto']);
    assert.equal(await db.refreshLeadQualification(2, 10), null);
    const foreign = (await engine.query('SELECT lead_temperature FROM conversations WHERE id = 2')).rows[0];
    assert.equal(foreign.lead_temperature, null);
  } finally {
    await engine.close();
  }
});

test('la evaluación guarda el estado anterior sin aplicar cambios ni cruzar organizaciones', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT c\.id/.test(sql)) return { rows: [{ id: 11 }, { id: 12 }] };
    return { rows: [] };
  } };
  const calculated = [];
  let applied = 0;
  const db = {
    getPool: () => pool,
    calculateLeadQualification: async (id, orgId) => {
      calculated.push({ id, orgId });
      return {
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
      };
    },
    applyLeadQualification: async () => { applied++; },
  };
  const router = load('src/routes/conversations.js', {
    '../db/database': db,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const res = response();
  await handler(router, 'post', '/scan-hot-leads')({ orgId: 77, userId: 5, body: { limit: 200 } }, res);

  assert.equal(res.code, 200);
  assert.deepEqual(calculated, [{ id: 11, orgId: 77 }, { id: 12, orgId: 77 }]);
  assert.equal(applied, 0);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.summary.legacyHot, 1);
  assert.equal(res.body.veryHotLeadsFound, 1);
  const candidateQuery = calls.find(call => /SELECT c\.id/.test(call.sql));
  assert.deepEqual(Array.from(candidateQuery.params), [77, 200]);
  const audits = calls.filter(call => /INSERT INTO lead_qualification_audits/.test(call.sql));
  assert.equal(audits.length, 2);
  assert.equal(audits[0].params[3], 'interested');
  assert.equal(audits[0].params[7], true);
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

test('aplicar una evaluación usa el snapshot y omite conversaciones que cambiaron', async () => {
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
  const pool = { connect: async () => client };
  const router = load('src/routes/conversations.js', {
    '../db/database': { getPool: () => pool },
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
  assert.deepEqual(Array.from(applyQuery.params), ['run-1', 77]);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});
