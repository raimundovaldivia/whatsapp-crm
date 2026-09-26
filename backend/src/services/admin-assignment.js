const db = require('../db/database');

async function get(orgId, phone = null) {
  const { rows } = await db.getPool().query(`SELECT a.*, c.phone_number AS customer_phone,
    c.contact_name FROM admin_assignments a JOIN conversations c ON c.id=a.conversation_id
    WHERE a.organization_id=$1 AND c.organization_id=$1 AND ($2::text IS NULL OR a.admin_phone=$2)`, [orgId, phone ? db.normalizePhone(phone) : null]);
  return rows[0] || null;
}

async function claim(orgId, phone, conversationId = null) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    const active = await client.query('SELECT * FROM admin_assignments WHERE organization_id=$1 AND admin_phone=$2', [orgId, db.normalizePhone(phone)]);
    if (active.rows.length) {
      await client.query('COMMIT');
      return active.rows[0];
    }
    const { rows } = await client.query(`SELECT c.id AS conversation_id FROM conversations c
      WHERE c.organization_id=$1 AND c.agent_mode <> 'ai'
      AND (EXISTS(SELECT 1 FROM admin_pending_replies p WHERE p.org_id=$1 AND p.conversation_id=c.id AND p.status='pending')
        OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.direction='inbound'
          AND m.created_at > COALESCE(c.human_closed_at,'-infinity'::timestamptz)
          AND NOT EXISTS(SELECT 1 FROM messages r WHERE r.conversation_id=c.id AND r.direction='outbound'
            AND r.sent_by='human' AND r.status <> 'failed' AND (r.created_at,r.id) > (m.created_at,m.id))))
      AND NOT EXISTS (SELECT 1 FROM admin_assignments a WHERE a.organization_id=$1 AND a.conversation_id=c.id)
      AND ($2::int IS NULL OR c.id=$2)`, [orgId, conversationId]);
    if (rows.length !== 1) { await client.query('COMMIT'); return null; }
    const inserted = await client.query(`INSERT INTO admin_assignments(organization_id,conversation_id,admin_phone)
      VALUES($1,$2,$3) RETURNING *`, [orgId, rows[0].conversation_id, db.normalizePhone(phone)]);
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function finish(orgId, conversationId, returnToBot, phone) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    const removed = await client.query('DELETE FROM admin_assignments WHERE organization_id=$1 AND conversation_id=$2 AND admin_phone=$3 RETURNING conversation_id', [orgId, conversationId, db.normalizePhone(phone)]);
    if (!removed.rows.length) throw new Error('La conversación ya no está asignada a tu teléfono.');
    await client.query("UPDATE admin_pending_replies SET status='replied' WHERE org_id=$1 AND conversation_id=$2 AND status='pending'", [orgId, conversationId]);
    await client.query("UPDATE admin_outbox SET status='expired' WHERE organization_id=$1 AND conversation_id=$2 AND kind IN ('help','handoff','reply') AND status='pending'", [orgId, conversationId]);
    await client.query(`UPDATE conversations SET agent_mode=$3, human_closed_at=NOW(), last_escalation_at=NULL,
      last_escalation_trigger=NULL,last_escalation_reason=NULL,escalation_reminder_at=NULL
      WHERE organization_id=$1 AND id=$2`, [orgId, conversationId, returnToBot ? 'ai' : 'human']);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function forConversation(orgId, conversationId) {
  const { rows } = await db.getPool().query('SELECT * FROM admin_assignments WHERE organization_id=$1 AND conversation_id=$2', [orgId,conversationId]);
  return rows[0] || null;
}
async function forCustomer(orgId, phone) {
  const { rows } = await db.getPool().query(`SELECT a.*,c.phone_number AS customer_phone,c.contact_name FROM admin_assignments a
    JOIN conversations c ON c.id=a.conversation_id WHERE a.organization_id=$1 AND c.organization_id=$1
    AND regexp_replace(c.phone_number,'[^0-9]','','g')=$2`,[orgId,db.normalizePhone(phone)]);
  return rows[0] || null;
}
module.exports = { get, claim, finish, forConversation, forCustomer };
