const db = require('../db/database');
const CONVERSATION_ROLES = ['owner','admin','supervisor','agent','alert_admin'];
async function resolve(orgId, phone) {
  const normalized = db.normalizePhone(phone);
  if (!normalized) return null;
  const { rows } = await db.getPool().query(`SELECT id,organization_id,name,role,whatsapp_phone,active
    FROM users WHERE organization_id=$1 AND regexp_replace(whatsapp_phone,'[^0-9]','','g')=$2`, [orgId,normalized]);
  if (rows.length > 1) return { role:'ambiguous', phone:normalized, organization_id:orgId };
  if (rows.length === 1) return { ...rows[0], role: rows[0].active === false ? 'suspended' : rows[0].role, phone:normalized };
  const adminPhone = await db.getSetting(orgId,'admin_alert_phone');
  if (adminPhone && db.normalizePhone(adminPhone) === normalized) {
    // The configured notification phone may handle clients, but is not an owner account.
    return { role:'alert_admin',name:'Encargado de atención',phone:normalized,organization_id:orgId };
  }
  return null;
}
function canAttend(actor) { return !!actor && CONVERSATION_ROLES.includes(actor.role); }
module.exports = { resolve, canAttend };
