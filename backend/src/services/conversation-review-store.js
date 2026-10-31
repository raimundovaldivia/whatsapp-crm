'use strict';
const { randomUUID } = require('node:crypto');
const { normalizePhone } = require('./customer-identity');
const schemas = new WeakMap();

function ensureSchema(pool) {
  if (!schemas.has(pool)) schemas.set(pool, pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_review_runs (
      id UUID PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id),
      created_by INTEGER NOT NULL, instruction TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS conversation_review_runs_org ON conversation_review_runs(organization_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_review_contacts (
      run_id UUID NOT NULL REFERENCES conversation_review_runs(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id), phone TEXT NOT NULL, position INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','done','error','stale')),
      claim UUID, claimed_at TIMESTAMPTZ, result JSONB, error TEXT,
      PRIMARY KEY(run_id, phone)
    );`).catch(error => { schemas.delete(pool); throw error; }));
  return schemas.get(pool);
}

function validateInput(body) {
  if (!Array.isArray(body?.phones) || !body.phones.length || body.phones.length > 500) throw Object.assign(new Error('Selecciona entre 1 y 500 teléfonos.'), { status: 400 });
  const phones = body.phones.map(p => typeof p === 'string' ? normalizePhone(p) : null);
  if (phones.some(p => !/^569\d{8}$/.test(p || '')) || new Set(phones).size !== phones.length) throw Object.assign(new Error('Usa teléfonos móviles chilenos válidos, sin duplicados.'), { status: 400 });
  if (typeof body.instruction !== 'string' || body.instruction.trim().length < 10 || body.instruction.length > 4000) throw Object.assign(new Error('Escribe un objetivo de entre 10 y 4.000 caracteres.'), { status: 400 });
  return { phones, instruction: body.instruction.trim() };
}

async function create(pool, orgId, userId, input) {
  const { phones, instruction } = validateInput(input);
  await ensureSchema(pool);
  const id = randomUUID();
  // One statement: a run can never be left without its contacts on failure.
  await pool.query(`WITH run AS (
      INSERT INTO conversation_review_runs(id, organization_id, created_by, instruction) VALUES($2, $1, $3, $4) RETURNING id
    ) INSERT INTO conversation_review_contacts(run_id, organization_id, phone, position)
      SELECT run.id, $1, phone, n FROM run, unnest($5::text[]) WITH ORDINALITY AS targets(phone, n)`, [orgId, id, userId, instruction, phones]);
  return id;
}

async function list(pool, orgId) {
  await ensureSchema(pool);
  return (await pool.query(`SELECT r.*, COUNT(c.phone)::int AS total,
      COUNT(c.phone) FILTER (WHERE c.state = 'done')::int AS completed
    FROM conversation_review_runs r LEFT JOIN conversation_review_contacts c ON c.run_id = r.id AND c.organization_id = $1
    WHERE r.organization_id = $1 GROUP BY r.id ORDER BY r.created_at DESC LIMIT 20`, [orgId])).rows;
}
async function get(pool, orgId, id) {
  await ensureSchema(pool);
  const run = (await pool.query('SELECT * FROM conversation_review_runs WHERE organization_id = $1 AND id = $2', [orgId, id])).rows[0];
  if (!run) throw Object.assign(new Error('Revisión no encontrada.'), { status: 404 });
  const contacts = (await pool.query('SELECT phone, position, state, result, error FROM conversation_review_contacts WHERE organization_id = $1 AND run_id = $2 ORDER BY position', [orgId, id])).rows;
  return { ...run, contacts, reviewOnly: true, sendAllowed: false, provider: 'evolution' };
}
async function claim(pool, orgId, id) {
  const token = randomUUID();
  const row = (await pool.query(`UPDATE conversation_review_contacts target SET state = 'processing', claim = $3, claimed_at = NOW(), error = NULL
    WHERE target.organization_id = $1 AND target.run_id = $2 AND target.phone = (
      SELECT phone FROM conversation_review_contacts WHERE organization_id = $1 AND run_id = $2
        AND (state = 'pending' OR (state = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes'))
        ORDER BY position FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING target.*`, [orgId, id, token])).rows[0];
  return row || null;
}
async function finish(pool, orgId, job, step, error = null) {
  const state = error ? 'error' : step.done ? 'done' : 'pending';
  return pool.query(`UPDATE conversation_review_contacts SET state = $5, result = $6, error = $7, claim = NULL, claimed_at = NULL
    WHERE organization_id = $1 AND run_id = $2 AND phone = $3 AND claim = $4`,
  [orgId, job.run_id, job.phone, job.claim, state, JSON.stringify(step?.result || job.result || null), error]);
}
async function invalidate(pool, orgId, id, phone, sourceHash) {
  await pool.query(`UPDATE conversation_review_contacts SET state = 'stale',
    result = result || '{"message":"","offeredMessage":"","offer":null,"offerText":"","sendAllowed":false,"reviewedByHuman":false,"stale":true}'::jsonb
    WHERE organization_id = $1 AND run_id = $2 AND phone = $3 AND result->>'sourceHash' = $4 AND state = 'done'`, [orgId, id, phone, sourceHash]);
}
async function retry(pool, orgId, id) {
  await get(pool, orgId, id);
  await pool.query(`UPDATE conversation_review_contacts SET state = 'pending', claim = NULL, claimed_at = NULL, error = NULL, result = NULL
    WHERE organization_id = $1 AND run_id = $2 AND state IN ('error','stale')`, [orgId, id]);
}
module.exports = { ensureSchema, validateInput, create, list, get, claim, finish, invalidate, retry };
