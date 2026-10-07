const db = require('../db/database');

// Keep both user records and all historical authors. Only operational ownership moves.
async function merge(orgId, sourceId, targetId, actorId, name) {
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId === targetId || sourceId === actorId)
    throw Object.assign(new Error('Selecciona dos despachadores distintos'), { status: 400 });
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query(`SELECT * FROM users WHERE organization_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE`, [orgId, [sourceId, targetId]]);
    const source = users.find(u => u.id === sourceId), target = users.find(u => u.id === targetId);
    if (!source || !target || users.some(u => !['repartidor', 'coordinador'].includes(u.role) || u.merged_into_user_id))
      throw Object.assign(new Error('Solo se pueden unificar despachadores activos de este equipo'), { status: 409 });
    const channels = (await client.query('SELECT id,assigned_user_id FROM whatsapp_channels WHERE organization_id=$1 AND assigned_user_id=ANY($2::int[]) FOR UPDATE', [orgId, [sourceId, targetId]])).rows;
    if (channels.length > 1) throw Object.assign(new Error('Ambos usuarios tienen WhatsApp propio. Revisa sus conexiones antes de unificarlos.'), { status: 409 });
    const finalName = String(name || target.name).trim().slice(0, 120);
    const snapshot = { source: { id: source.id, name: source.name, role: source.role, phone: source.whatsapp_phone }, target: { id: target.id, name: target.name } };
    for (const table of ['delivery_routes', 'order_returns', 'delivery_expenses']) {
      // Preserve original attribution for audit and distinguish old offline request keys.
      const result = await client.query(`UPDATE ${table} SET driver_user_id=$1, original_driver_user_id=COALESCE(original_driver_user_id,$2)
        ${table !== 'order_returns' ? ', driver_name=$4' : ''}
        ${table === 'delivery_expenses' ? ", client_request_id=CASE WHEN client_request_id IS NULL THEN NULL ELSE 'merged:' || $2::text || ':' || id::text || ':' || client_request_id END" : ''}
        WHERE organization_id=$3 AND driver_user_id=$2 RETURNING id`, table === 'order_returns' ? [targetId, sourceId, orgId] : [targetId, sourceId, orgId, finalName]);
      snapshot[table] = result.rows.map(row => row.id);
    }
    await client.query('UPDATE whatsapp_channels SET assigned_user_id=$1 WHERE organization_id=$2 AND assigned_user_id=$3', [targetId, orgId, sourceId]);
    await client.query(`UPDATE users SET merged_into_user_id=$1, auth_version=auth_version+1,
      wa_notifications='{}'::jsonb WHERE id=$2 AND organization_id=$3`, [targetId, sourceId, orgId]);
    await client.query(`UPDATE users SET name=$1, whatsapp_phone=COALESCE(whatsapp_phone,$2) WHERE id=$3 AND organization_id=$4`,
      [finalName, source.whatsapp_phone, targetId, orgId]);
    // Old sessions are revoked above; remove stale push registrations without transferring devices.
    await client.query('DELETE FROM push_tokens WHERE organization_id=$1 AND user_id=$2', [orgId, sourceId]);
    await client.query('INSERT INTO user_merge_audit(organization_id,source_user_id,target_user_id,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [orgId, sourceId, targetId, actorId, JSON.stringify(snapshot)]);
    await client.query('COMMIT');
    return { sourceId, targetId };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { merge };
