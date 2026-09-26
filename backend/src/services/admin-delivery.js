const db = require('../db/database');
const kapso = require('./kapso-whatsapp');

async function reconcile(orgId, messageId) {
  await db.getPool().query(`UPDATE admin_notification_deliveries d SET
    status=r.status, error=r.error, updated_at=NOW(),
    delivered_at=CASE WHEN r.status IN ('delivered','read') THEN COALESCE(d.delivered_at,r.updated_at) ELSE d.delivered_at END,
    read_at=CASE WHEN r.status='read' THEN COALESCE(d.read_at,r.updated_at) ELSE d.read_at END
    FROM admin_delivery_receipts r WHERE d.organization_id=$1 AND d.message_id=$2
    AND r.organization_id=d.organization_id AND r.message_id=d.message_id`, [orgId, messageId]);
}

async function receipt(orgId, { messageId, status, error = null }) {
  if (!messageId || !['sent','delivered','read','failed'].includes(status)) return;
  await db.getPool().query(`INSERT INTO admin_delivery_receipts(organization_id,message_id,status,error)
    VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,message_id) DO UPDATE SET
    status=EXCLUDED.status,error=EXCLUDED.error,updated_at=NOW()
    WHERE CASE EXCLUDED.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END
    > CASE admin_delivery_receipts.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END`,
  [orgId, messageId, status, error ? JSON.stringify(error) : null]);
  await reconcile(orgId, messageId);
}

async function send(orgId, { phone, body, config, kind, conversationId }) {
  const pool = db.getPool();
  const { rows } = await pool.query(`INSERT INTO admin_notification_deliveries
    (organization_id,conversation_id,kind,recipient) VALUES($1,$2,$3,$4) RETURNING id`,
  [orgId, conversationId || null, kind, phone]);
  const id = rows[0].id;
  let response;
  try {
    response = await kapso.sendTextMessage(phone, body, config);
  } catch (error) {
    await pool.query('UPDATE admin_notification_deliveries SET status=$2,error=$3,updated_at=NOW() WHERE id=$1',
      [id, error.is24hWindow ? 'queued' : 'failed', error.message]);
    throw error;
  }
  const messageId = response?.messages?.[0]?.id || response?.message?.id || null;
  await pool.query("UPDATE admin_notification_deliveries SET status='accepted',message_id=$2,updated_at=NOW() WHERE id=$1", [id, messageId]);
  if (messageId) await reconcile(orgId, messageId);
  return response;
}
async function blocked(orgId, { conversationId, kind, phone, reason }) {
  await db.getPool().query(`INSERT INTO admin_notification_deliveries
    (organization_id,conversation_id,kind,recipient,status,error) VALUES($1,$2,$3,$4,'failed',$5)`,
  [orgId, conversationId || null, kind, phone || null, reason]);
}
module.exports = { send, receipt, blocked };
