const db = require('../db/database');
const kapso = require('./kapso-whatsapp');
const campaignGuard = require('./broadcast-campaign-guard');

const PAYMENT_MESSAGE = 'Meta bloqueó el envío por un problema de pago o elegibilidad';

function errorCode(error) {
  const first = Array.isArray(error) ? error[0] : error;
  return first?.code != null ? String(first.code) : null;
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/**
 * Consulta al proveedor por los mensajes que sólo conservan la aceptación
 * inicial. Esto cubre webhooks tardíos o perdidos sin inferir fallos.
 */
async function reconcileCampaignStatuses(orgId, campaignId, { force = false, limit = 500 } = {}) {
  const config = await db.getWhatsappConfig(orgId);
  if (!config || config.provider !== 'kapso') {
    return { checked: 0, updated: 0, failed: 0, pending: 0, unsupported: true };
  }

  const { rows } = await db.getPool().query(
    `SELECT r.id, r.whatsapp_message_id, COALESCE(m.status, 'pending') AS local_status
       FROM broadcast_campaign_recipients r
       LEFT JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
      WHERE r.organization_id = $1 AND r.campaign_id = $2
        AND r.result_status = 'accepted'
        AND r.whatsapp_message_id IS NOT NULL
        AND COALESCE(m.status, 'pending') IN ('pending','sent')
        AND r.created_at < NOW() - INTERVAL '5 seconds'
        AND ($3::boolean OR r.provider_checked_at IS NULL
             OR r.provider_checked_at < NOW() - INTERVAL '2 minutes')
      ORDER BY r.id
      LIMIT $4`,
    [orgId, campaignId, !!force, Math.min(Math.max(Number(limit) || 500, 1), 500)]
  );

  let updated = 0;
  let failed = 0;
  const results = await mapConcurrent(rows, 10, async recipient => {
    try {
      const receipt = await kapso.getMessageStatus(recipient.whatsapp_message_id, config);
      if (!receipt?.status) return { checked: false };
      const code = errorCode(receipt.error);
      const message = code === campaignGuard.META_PAYMENT_ERROR
        ? PAYMENT_MESSAGE
        : (receipt.error?.[0]?.message || receipt.error?.message || null);
      await db.updateMessageStatus(
        recipient.whatsapp_message_id,
        receipt.status,
        receipt.error || null,
        orgId
      );
      await db.getPool().query(
        `UPDATE broadcast_campaign_recipients
            SET provider_checked_at = NOW(), provider_status = $1,
                result_status = CASE WHEN $1 = 'failed' THEN 'failed' ELSE result_status END,
                error_code = CASE WHEN $1 = 'failed' THEN $2 ELSE error_code END,
                error_message = CASE WHEN $1 = 'failed' THEN $3 ELSE error_message END,
                error_detail = CASE WHEN $1 = 'failed' THEN $4::jsonb ELSE error_detail END
          WHERE id = $5 AND organization_id = $6`,
        [receipt.status, code, message, receipt.error ? JSON.stringify(receipt.error) : null, recipient.id, orgId]
      );
      if (receipt.status !== recipient.local_status) updated++;
      if (receipt.status === 'failed') failed++;
      return { checked: true, status: receipt.status, code };
    } catch (error) {
      console.warn(`[CampaignStatus] No se pudo verificar ${recipient.whatsapp_message_id}:`, error.message);
      return { checked: false, error: error.message };
    }
  });

  if (results.some(result => result?.code === campaignGuard.META_PAYMENT_ERROR)) {
    await campaignGuard.pauseForPaymentFailure(orgId, { campaignId, errors: [{ code: campaignGuard.META_PAYMENT_ERROR }] });
  }

  return {
    checked: results.filter(result => result?.checked).length,
    updated,
    failed,
    pending: rows.length - results.filter(result => result?.checked).length,
  };
}

module.exports = { reconcileCampaignStatuses, errorCode };
