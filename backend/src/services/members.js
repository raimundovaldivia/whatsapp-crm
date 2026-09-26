const db = require('../db/database');
const commercial = require('./commercial');
const { LIMITS } = require('./solution-catalog');
const fail = (status, message) => Object.assign(new Error(message), { status });

async function setActive(orgId, actorId, userId, active) {
  if (!Number.isSafeInteger(userId) || userId < 1 || typeof active !== 'boolean') throw fail(400, 'Usuario o estado inválido');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    // Same lock as seat creation and contract updates: concurrent activations cannot exceed quota.
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    const actor = (await client.query('SELECT role,active FROM users WHERE id=$1 AND organization_id=$2', [actorId,orgId])).rows[0];
    if (!actor?.active || !['owner','admin'].includes(actor.role)) throw fail(403, 'Sin permisos suficientes');
    const user = (await client.query('SELECT id,role,active FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [userId,orgId])).rows[0];
    if (!user) throw fail(404, 'Usuario no encontrado');
    if (user.role === 'owner' || userId === actorId) throw fail(403, 'No puedes suspender al propietario ni tu propia cuenta');
    if (user.active !== active) {
      if (active) {
        const contract = await commercial.contractFor(orgId,client);
        const limit = commercial.access(contract) ? contract.limits.seats : LIMITS.seats.default;
        const { rows } = await client.query('SELECT count(*)::int AS count FROM users WHERE organization_id=$1 AND active=TRUE', [orgId]);
        if (limit !== null && rows[0].count >= limit) throw fail(409, 'No hay cupos disponibles. Suspende otra cuenta o amplía tu contrato.');
      }
      await client.query('UPDATE users SET active=$1,auth_version=auth_version+1 WHERE id=$2 AND organization_id=$3', [active,userId,orgId]);
      await client.query('INSERT INTO commercial_audit(organization_id,actor_id,action,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6)',
        [orgId,actorId,active?'member.activated':'member.suspended',JSON.stringify(user),JSON.stringify({...user,active}),active?'Reactivación de integrante':'Suspensión de integrante']);
    }
    await client.query('COMMIT');
    return {...user,active};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { setActive };
