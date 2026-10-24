// Additional purchases must be requested by the customer, never inferred from
// delivery coordination, a payment receipt or the model's confirmation token.
function requestsAdditionalOrder(message) {
  const text = String(message || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/[?¿]|\b(?:no|cancel\w*|anul\w*|si\s+llega\w*)\b/.test(text)) return false;
  return /\b(?:quiero|quisiera|necesito|deseo|hagamos|hacer|crea(?:me)?|arma(?:me)?|haz(?:me)?)\b.{0,45}\b(?:otro|nuevo|segundo)\s+pedido\b/.test(text)
    || /\b(?:quiero|necesito|quisiera)\b.{0,70}\b(?:pedido\s+aparte|compra\s+adicional)\b/.test(text);
}

// Keep the final check and insert in one transaction, serialized per
// conversation. A check followed by an unlocked insert can race another turn.
async function persistBotOrder(pool, { orgId, conversationId, additionalOrderId = null }, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const anchor = await client.query('SELECT id FROM conversations WHERE id=$1 AND organization_id=$2 FOR UPDATE', [conversationId, orgId]);
    if (!anchor.rows.length) throw Object.assign(new Error('Conversación no encontrada'), { status: 404 });
    const existing = await client.query(`SELECT id FROM orders
      WHERE organization_id=$1 AND conversation_id=$2
        AND ($3::bigint IS NULL OR id<>$3)
        AND status NOT IN ('cancelled','canceled')
        AND (created_at > NOW()-INTERVAL '10 minutes'
          OR (status IN ('draft','nuevo','sent','payment_received','por_despachar','asignado_ruta','en_camino','no_entregado')
            AND (COALESCE(updated_at,created_at)>NOW()-INTERVAL '7 days'
              OR delivery_date >= (NOW() AT TIME ZONE 'America/Santiago')::date)))
      ORDER BY created_at DESC LIMIT 1`, [orgId, conversationId, additionalOrderId]);
    if (existing.rows.length) throw Object.assign(new Error('El pedido ya está registrado'), {
      code: 'ORDER_ALREADY_EXISTS', orderId: existing.rows[0].id,
    });
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { requestsAdditionalOrder, persistBotOrder };
