const db = require('../db/database');
const kapso = require('./kapso-whatsapp');

const PROVIDER_MESSAGE_ID = /^(wamid\.|[a-f0-9-]{24,}$)/i;

/**
 * Recupera estados que no llegaron por webhook. Kapso acepta primero el envío
 * y luego publica sent/delivered/read/failed; si se pierde ese segundo evento,
 * el mensaje queda visualmente pendiente aunque el proveedor ya tenga el final.
 */
async function reconcilePendingMessages(orgId, messages, config) {
  if (!orgId || config?.provider !== 'kapso') return [];

  const now = Date.now();
  const candidates = (messages || []).filter(message => {
    const age = now - new Date(message.created_at || 0).getTime();
    return message.direction === 'outbound'
      && message.status === 'pending'
      && PROVIDER_MESSAGE_ID.test(String(message.whatsapp_message_id || ''))
      && Number.isFinite(age)
      && age >= 5000;
  }).slice(-12);

  const settled = await Promise.allSettled(candidates.map(async message => {
    const providerStatus = await kapso.getMessageStatus(message.whatsapp_message_id, config);
    if (!providerStatus?.status) return null;
    return db.updateMessageStatus(
      message.whatsapp_message_id,
      providerStatus.status,
      providerStatus.error || null,
      orgId
    );
  }));

  return settled
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);
}

module.exports = { reconcilePendingMessages };
