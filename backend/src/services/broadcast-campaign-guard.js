const { getPool } = require('../db/database');

const META_PAYMENT_ERROR = '131042';

function errorCode(errors) {
  const first = Array.isArray(errors) ? errors[0] : errors;
  return first?.code != null ? String(first.code) : null;
}

/**
 * Abre el cortacircuito de una campaña ante un fallo de pago de Meta.
 * La transición es idempotente: varios webhooks simultáneos sólo la pausan
 * una vez. Los requests posteriores consultan este estado antes de enviar.
 */
async function pauseForPaymentFailure(orgId, { campaignId = null, messageId = null, errors = null } = {}) {
  if (errorCode(errors) !== META_PAYMENT_ERROR && !campaignId) return null;
  const { rows } = await getPool().query(
    `UPDATE broadcast_campaigns c
        SET status = 'paused_payment', pause_code = $3,
            pause_reason = 'Meta bloqueó los envíos por un problema de pago o elegibilidad',
            paused_at = COALESCE(c.paused_at, NOW()),
            completed_at = COALESCE(c.completed_at, NOW())
      WHERE c.organization_id = $1
        AND c.status <> 'paused_payment'
        AND (
          ($2::bigint IS NOT NULL AND c.id = $2)
          OR ($4::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM broadcast_campaign_recipients r
             WHERE r.campaign_id = c.id AND r.organization_id = $1
               AND r.whatsapp_message_id = $4
          ))
        )
      RETURNING c.*,
        (SELECT COUNT(*)::int FROM broadcast_campaign_recipients r
          WHERE r.campaign_id = c.id) AS processed_count`,
    [orgId, campaignId, META_PAYMENT_ERROR, messageId]
  );
  return rows[0] || null;
}

function isPaymentFailure(errors) {
  return errorCode(errors) === META_PAYMENT_ERROR;
}

module.exports = { META_PAYMENT_ERROR, isPaymentFailure, pauseForPaymentFailure };
