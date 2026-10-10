const db = require('../db/database');
const evolution = require('./evolution-whatsapp');
const kapso = require('./kapso-whatsapp');
const meta = require('./whatsapp');

function parsedMessages(job) {
  const payload = job.payload || {};
  if (job.provider === 'evolution') {
    const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
    return rows.map(data => evolution.parseWebhookMessage({ ...payload, data })).filter(Boolean);
  }
  if (job.provider === 'kapso') {
    const parsed = kapso.parseWebhookMessage(payload, job.headers?.['x-webhook-event'] || payload.event);
    return parsed ? [parsed] : [];
  }
  if (job.provider === 'meta') {
    const parsed = meta.parseWebhookMessage(payload);
    return parsed ? [parsed] : [];
  }
  return [];
}

async function backfillWhatsappAttributions() {
  const pool = db.getPool();
  const { rows: jobs } = await pool.query(
    `SELECT provider, organization_id, payload, headers, params, created_at
       FROM webhook_inbox
      WHERE provider IN ('evolution','kapso','meta')
        AND created_at >= NOW() - INTERVAL '90 days'
        AND (payload::text ILIKE '%externalAdReply%'
          OR payload::text ILIKE '%external_ad_reply%'
          OR payload::text ILIKE '%"referral"%'
          OR payload::text ILIKE '%ctwa_clid%')
      ORDER BY id ASC LIMIT 5000`
  );
  let imported = 0;
  for (const job of jobs) {
    for (const parsed of parsedMessages(job)) {
      if (!parsed.attribution || !parsed.from || !parsed.messageId) continue;
      const channelId = job.provider === 'evolution' ? Number(job.params?.channelId || 0) || null : null;
      const digits = String(parsed.from).replace(/\D/g, '');
      const { rows: [conversation] } = await pool.query(
        `SELECT id FROM conversations
          WHERE organization_id=$1
            AND regexp_replace(phone_number, '[^0-9]', '', 'g')=$2
            AND (($3::int IS NULL AND whatsapp_channel_id IS NULL)
              OR ($3::int IS NOT NULL AND whatsapp_channel_id=$3))
          ORDER BY last_message_at DESC
          LIMIT 1`,
        [job.organization_id, digits, channelId]
      );
      if (!conversation) continue;
      const { rows: [message] } = await pool.query(
        'SELECT id FROM messages WHERE conversation_id=$1 AND whatsapp_message_id=$2 LIMIT 1',
        [conversation.id, parsed.messageId]
      );
      await db.saveWhatsappAttribution({
        organizationId: job.organization_id,
        conversationId: conversation.id,
        messageId: message?.id || null,
        whatsappMessageId: parsed.messageId,
        provider: job.provider,
        attribution: parsed.attribution,
        receivedAt: job.created_at,
      });
      imported++;
    }
  }
  if (imported) console.log(`[Attribution] ${imported} referencias históricas recuperadas`);
  return imported;
}

module.exports = { backfillWhatsappAttributions };
