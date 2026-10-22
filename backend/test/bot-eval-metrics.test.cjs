const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response } = require('./helpers.cjs');

test('las métricas leen la baja desde contactos sin consultar una columna inexistente', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [{
      id: 1, pipeline_state: 'interested', agent_mode: 'ai', opted_out: true,
      inbound_in: 1, orders_in: 0, last_dir: 'inbound', last_by: 'client',
    }] };
  } };
  const router = load('src/routes/bot-eval.js', {
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next() },
  });
  const res = response();
  await handler(router, 'get', '/metrics')({ orgId: 7, query: { from: '2026-10-12', to: '2026-10-14' } }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.current.baja, 1);
  assert.equal(res.body.previous.baja, 1);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.doesNotMatch(query.sql, /c\.opted_out/);
    assert.match(query.sql, /ct\.organization_id = c\.organization_id/);
    assert.match(query.sql, /ct\.opt_out = TRUE/);
    assert.equal(query.params[0], 7);
  }
});
