'use strict';

/**
 * Persistencia de ofertas personales (tabla campaign_offers).
 * Las reglas viven en campaign-offers.js; aquí solo se leen y escriben filas.
 * `pool` es cualquier objeto con query(sql, params) → { rows }.
 */

const rules = require('./campaign-offers');

const COLUMNS = 'id, organization_id, conversation_id, product_id, offer_price, scope, status, expires_at, sent_at, created_at, message_id, redeemed_order_id, redeemed_at, superseded_at, expired_at';

/** Oferta más reciente enviada a la conversación (la última es la válida). */
async function latestForConversation(pool, orgId, conversationId) {
  const { rows } = await pool.query(
    `SELECT po.*, pr.title AS product_title FROM campaign_offers po
       LEFT JOIN products pr ON pr.id::text = po.product_id
      WHERE po.organization_id = $1 AND po.conversation_id = $2
        AND po.status IN ('sent', 'redeemed', 'expired', 'superseded')
      ORDER BY COALESCE(po.sent_at, po.created_at) DESC, po.id DESC LIMIT 1`,
    [orgId, conversationId],
  );
  return rows[0] || null;
}

/** Última oferta enviada por cada producto de la conversación (una vigente por producto). */
async function activeForConversation(pool, orgId, conversationId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (po.product_id) po.*, pr.title AS product_title FROM campaign_offers po
         LEFT JOIN products pr ON pr.id::text = po.product_id
        WHERE po.organization_id = $1 AND po.conversation_id = $2
          AND po.status IN ('sent', 'redeemed', 'expired', 'superseded')
        ORDER BY po.product_id, COALESCE(po.sent_at, po.created_at) DESC, po.id DESC
     ) latest_per_product`,
    [orgId, conversationId],
  );
  return rows;
}

/** Crea la oferta como borrador, antes del envío. Los campos ya fueron validados. */
async function createDraft(pool, orgId, conversationId, fields) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_offers (organization_id, conversation_id, product_id, offer_price, scope, expires_at, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'draft', NOW()) RETURNING ${COLUMNS}`,
    [orgId, conversationId, String(fields.product_id), Number(fields.offer_price),
      JSON.stringify(fields.scope), fields.expires_at],
  );
  return rows[0];
}

/** Tras un envío aceptado: esta oferta pasa a `sent` y las pendientes anteriores a `superseded`. */
async function markSent(pool, orgId, offerId, messageId, now = new Date()) {
  const { rows: [current] } = await pool.query(
    `SELECT ${COLUMNS} FROM campaign_offers WHERE organization_id = $1 AND id = $2`, [orgId, offerId]);
  if (!current) throw new Error('Oferta no encontrada');
  await pool.query(
    `UPDATE campaign_offers SET status = 'superseded', superseded_at = $3::timestamptz
      WHERE organization_id = $1 AND conversation_id = $2 AND product_id = $5 AND status = 'sent' AND id <> $4`,
    [orgId, current.conversation_id, now.toISOString(), offerId, current.product_id],
  );
  const { rows } = await pool.query(
    `UPDATE campaign_offers SET status = 'sent', sent_at = $3::timestamptz, message_id = $4::integer
      WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [orgId, offerId, now.toISOString(), messageId],
  );
  return rows[0];
}

/** Canje al crear un pedido. Lanza error si la oferta no es usable para un pedido nuevo. */
async function redeem(pool, orgId, offerId, orderId, now = new Date()) {
  const { rows: [offer] } = await pool.query(
    `SELECT ${COLUMNS} FROM campaign_offers WHERE organization_id = $1 AND id = $2`, [orgId, offerId]);
  if (!offer) throw new Error('Oferta no encontrada');
  const next = rules.redeem(offer, orderId, now);
  const { rows } = await pool.query(
    `UPDATE campaign_offers SET status = 'redeemed', redeemed_order_id = $3, redeemed_at = $4
      WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [orgId, offerId, orderId, next.redeemed_at],
  );
  return rows[0];
}

/** Cancelación del pedido canjeado: vuelve a `sent` o queda `expired` según la vigencia. */
async function releaseOnCancel(pool, orgId, orderId, now = new Date()) {
  const { rows: [offer] } = await pool.query(
    `SELECT ${COLUMNS} FROM campaign_offers WHERE redeemed_order_id = $1 AND ($2::integer IS NULL OR organization_id = $2)`, [orderId, orgId]);
  if (!offer) return null;
  const next = rules.onOrderCancelled(offer, now);
  const { rows } = await pool.query(
    `UPDATE campaign_offers SET status = $2, redeemed_order_id = NULL, redeemed_at = NULL,
            expired_at = CASE WHEN $2::text = 'expired' THEN $3::timestamptz ELSE expired_at END
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [offer.id, next.status, now.toISOString()],
  );
  return rows[0];
}

/** Marca como `expired` las ofertas enviadas cuya vigencia ya pasó. */
async function expireDue(pool, orgId, now = new Date()) {
  const { rows } = await pool.query(
    `UPDATE campaign_offers SET status = 'expired', expired_at = $2::timestamptz
      WHERE organization_id = $1 AND status = 'sent' AND expires_at <= $2::timestamptz
      RETURNING ${COLUMNS}`,
    [orgId, now.toISOString()],
  );
  return rows;
}

module.exports = { activeForConversation, latestForConversation, createDraft, markSent, redeem, releaseOnCancel, expireDue };
