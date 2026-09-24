const db = require('../db/database');
const { SOLUTIONS, KEYS, FLAG_SOLUTION, DEFAULT_FLAGS, LIMITS, validateModules } = require('./solution-catalog');
const fail = (status, message, code = 'COMMERCIAL_ACCESS') => Object.assign(new Error(message), { status, code });
function isPlatformAdmin(userId) {
  return (process.env.PLATFORM_ADMIN_USER_IDS || '').split(',').map(v => v.trim()).filter(v => /^\d+$/.test(v)).includes(String(userId));
}
function access(contract, now = new Date()) {
  return !!contract && ['legacy', 'trial', 'active'].includes(contract.status) && (!contract.expires_at || new Date(contract.expires_at) > now);
}
async function contractFor(orgId, client = db.getPool()) {
  return (await client.query('SELECT * FROM commercial_contracts WHERE organization_id=$1', [orgId])).rows[0] || null;
}
async function permitted(orgId, key, client = db.getPool()) {
  if (!KEYS.includes(key)) return false;
  const contract = await contractFor(orgId, client);
  return access(contract) && contract.modules.includes(key);
}
async function assertModule(orgId, key) {
  if (!await permitted(orgId, key)) throw fail(403, 'Este módulo no está disponible en tu contrato. Revísalo en Mis soluciones.');
}
async function effectiveFlags(orgId) {
  const [contract, raw] = await Promise.all([contractFor(orgId), db.getSetting(orgId, 'modules')]);
  let preferences = {};
  try { preferences = typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { /* invalid preference cannot grant commercial access */ }
  const enabled = access(contract) ? contract.modules : [];
  return Object.fromEntries(Object.entries(DEFAULT_FLAGS).map(([key, fallback]) => [key,
    (!FLAG_SOLUTION[key] || enabled.includes(FLAG_SOLUTION[key])) && (typeof preferences[key] === 'boolean' ? preferences[key] : fallback)]));
}
async function summary(orgId) {
  const [contract, usage, users, requests] = await Promise.all([
    contractFor(orgId),
    db.getPool().query("SELECT metric,quantity FROM commercial_usage WHERE organization_id=$1 AND period=date_trunc('month',NOW() AT TIME ZONE 'UTC')::date", [orgId]),
    db.getPool().query('SELECT count(*)::int AS count FROM users WHERE organization_id=$1', [orgId]),
    db.getPool().query('SELECT id,module_key,status,note,created_at FROM commercial_requests WHERE organization_id=$1 ORDER BY id DESC LIMIT 50', [orgId]),
  ]);
  const expired = contract && ['legacy','trial','active'].includes(contract.status) && contract.expires_at && new Date(contract.expires_at) <= new Date();
  return { contract, state: expired ? 'expired' : contract?.status || 'base', available: access(contract) ? contract.modules : [], platformAdmin: false, catalog: SOLUTIONS,
    limits: access(contract) ? contract.limits : Object.fromEntries(Object.entries(LIMITS).map(([k,v]) => [k,v.default])),
    usage: { bot_turns: usage.rows.find(x => x.metric === 'bot_turns')?.quantity || 0, seats: users.rows[0].count },
    requests: requests.rows, period: new Date().toISOString().slice(0,7), billingMode: 'assisted' };
}
// Atomic quota accounting across replicas; count started bot turns, including provider failures.
async function consumeBotTurn(orgId) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const contract = (await client.query('SELECT * FROM commercial_contracts WHERE organization_id=$1 FOR UPDATE', [orgId])).rows[0];
    if (!access(contract) || !contract.modules.includes('sales_ai')) throw fail(403, 'Ventas con IA no está disponible');
    const result = await client.query(`INSERT INTO commercial_usage(organization_id,metric,period,quantity)
      SELECT $1,'bot_turns',date_trunc('month',NOW() AT TIME ZONE 'UTC')::date,1 WHERE $2::integer IS NULL OR $2>0
      ON CONFLICT(organization_id,metric,period) DO UPDATE SET quantity=commercial_usage.quantity+1
      WHERE $2::integer IS NULL OR commercial_usage.quantity<$2 RETURNING quantity`, [orgId, contract.limits.bot_turns]);
    if (!result.rowCount) throw fail(429, 'Se alcanzó el límite mensual del agente de ventas', 'QUOTA_EXCEEDED');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function createUserWithinLimit(data) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    // Organization lock also serializes base accounts, which do not yet have a contract.
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [data.organizationId]);
    const contract = await contractFor(data.organizationId, client);
    const limit = access(contract) ? contract.limits.seats : LIMITS.seats.default;
    const count = (await client.query('SELECT count(*)::int AS count FROM users WHERE organization_id=$1', [data.organizationId])).rows[0].count;
    if (limit !== null && count >= limit) throw fail(409, 'Se alcanzó el límite de usuarios de tu contrato', 'QUOTA_EXCEEDED');
    const result = await client.query(`INSERT INTO users(organization_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,$5)
      RETURNING id,organization_id,email,name,role`, [data.organizationId,data.email,data.passwordHash,data.name,data.role]);
    await client.query('COMMIT'); return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function validateContract(input) {
  if (!['trial','active','suspended','cancelled'].includes(input.status)) throw fail(400,'Estado inválido');
  validateModules(input.modules);
  if (!input.limits || Object.keys(input.limits).some(k => !Object.hasOwn(LIMITS,k))) throw fail(400,'Límites inválidos');
  for (const key of Object.keys(LIMITS)) if (input.limits[key] !== null && (!Number.isInteger(input.limits[key]) || input.limits[key] < (key === 'seats' ? 1 : 0) || input.limits[key] > 10000000)) throw fail(400,'Límites inválidos');
  if (input.expires_at != null && (typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at)) || new Date(input.expires_at) <= new Date())) throw fail(400,'La fecha de vencimiento debe estar en el futuro');
  if (input.status === 'trial' && !input.expires_at) throw fail(400,'La prueba requiere fecha de vencimiento');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 5 || input.reason.length > 1000) throw fail(400,'Indica un motivo de entre 5 y 1000 caracteres');
  if (!Number.isInteger(input.revision) || input.revision < 0) throw fail(400,'Versión de contrato inválida');
}
async function updateContract(orgId, actorId, input) {
  validateContract(input);
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const org = await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    if (!org.rowCount) throw fail(404,'Tienda no encontrada');
    const before = await contractFor(orgId, client);
    if ((before?.revision || 0) !== input.revision) throw fail(409,'El contrato cambió. Recarga antes de guardar.');
    const after = (await client.query(`INSERT INTO commercial_contracts(organization_id,status,modules,limits,expires_at,updated_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id) DO UPDATE SET status=$2,modules=$3,limits=$4,expires_at=$5,
      updated_by=$6,updated_at=NOW(),revision=commercial_contracts.revision+1 RETURNING *`,
    [orgId,input.status,JSON.stringify(input.modules),JSON.stringify(input.limits),input.expires_at || null,actorId])).rows[0];
    await client.query('INSERT INTO commercial_audit(organization_id,actor_id,action,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [orgId,actorId,'contract.updated',JSON.stringify(before),JSON.stringify(after),input.reason.trim()]);
    if (access(after)) await client.query("UPDATE commercial_requests SET status='approved',resolved_at=NOW() WHERE organization_id=$1 AND status='pending' AND module_key=ANY($2::text[])", [orgId,after.modules]);
    await client.query('COMMIT'); return after;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { isPlatformAdmin, access, contractFor, permitted, assertModule, effectiveFlags, summary, consumeBotTurn, createUserWithinLimit, validateContract, updateContract };
