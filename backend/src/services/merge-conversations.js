const { getPool } = require('../db/database');

async function mergeConversations(orgId, targetId, sourceId) {
  if (!Number.isSafeInteger(targetId) || !Number.isSafeInteger(sourceId) || targetId === sourceId) {
    throw Object.assign(new Error('Parámetros inválidos'), { status: 400 });
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM conversations WHERE organization_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE',
      [orgId, [targetId, sourceId]]);
    if (rows.length !== 2) throw Object.assign(new Error('Conversación no encontrada'), { status: 404 });
    // Transfer every FK dependency before deleting the source. Failures roll back.
    for (const table of ['messages', 'orders', 'payment_proofs', 'scheduled_orders', 'escalation_feedback', 'admin_pending_replies', 'admin_outbox']) {
      await client.query(`UPDATE ${table} SET conversation_id = $1 WHERE conversation_id = $2`, [targetId, sourceId]);
    }
    const source = rows.find(r => r.id === sourceId), target = rows.find(r => r.id === targetId);
    const generic = !target.contact_name || target.contact_name === 'Cliente' || /^\d+$/.test(target.contact_name);
    await client.query(`UPDATE conversations SET
      unread_count = unread_count + $2, contact_name = COALESCE($3, contact_name), updated_at = NOW()
      WHERE id = $1`, [targetId, source.unread_count || 0, generic ? source.contact_name : null]);
    await client.query(`UPDATE conversations SET last_message = m.content, last_message_at = m.created_at
      FROM (SELECT content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1) m
      WHERE conversations.id = $1`, [targetId]);
    await client.query('DELETE FROM conversations WHERE id = $1 AND organization_id = $2', [sourceId, orgId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
module.exports = { mergeConversations };
