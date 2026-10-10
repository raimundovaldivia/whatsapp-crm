const axios = require('axios');

const BASE_URL = 'https://graph.facebook.com/v19.0';

/**
 * Envía texto usando las credenciales de la organización
 */
async function sendTextMessage(toPhone, text, whatsappConfig) {
  const { phone_number_id, access_token } = whatsappConfig;

  const response = await axios.post(
    `${BASE_URL}/${phone_number_id}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'text',
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

async function sendMediaMessage(toPhone, media, whatsappConfig) {
  const { phone_number_id, access_token } = whatsappConfig;
  const type = media.type === 'image' ? 'image' : 'document';
  let uploadedMediaId = null;
  if (!media.mediaUrl) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([media.buffer], { type: media.mimeType }), media.fileName);
    const upload = await axios.post(`${BASE_URL}/${phone_number_id}/media`, form, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    uploadedMediaId = upload.data?.id;
    if (!uploadedMediaId) throw new Error('Meta no devolvió el identificador del archivo');
  }
  const content = media.mediaUrl ? { link: media.mediaUrl } : { id: uploadedMediaId };
  if (media.caption) content.caption = media.caption;
  if (type === 'document' && media.fileName) content.filename = media.fileName;
  const response = await axios.post(
    `${BASE_URL}/${phone_number_id}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to: toPhone, type, [type]: content },
    { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' } }
  );
  return { ...response.data, uploadedMediaId };
}

async function markAsRead(messageId, whatsappConfig) {
  const { phone_number_id, access_token } = whatsappConfig;
  try {
    await axios.post(
      `${BASE_URL}/${phone_number_id}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
  } catch { /* No crítico */ }
}

function parseWebhookMessage(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return null;
    const message = value.messages[0];
    const contact = value?.contacts?.[0];
    const adReferral = require('./ad-attribution').normalizeAdReferral?.(message.referral, 'meta') || null;
    return {
      messageId: message.id,
      from: message.from,
      contactName: contact?.profile?.name || null,
      timestamp: message.timestamp,
      type: message.type,
      text: message.type === 'text' ? message.text?.body : null,
      ...(adReferral ? { adReferral } : {}),
    };
  } catch { return null; }
}

function parseStatusUpdate(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.statuses?.length) return null;
    const status = value.statuses[0];
    return { messageId: status.id, status: status.status, recipientId: status.recipient_id, error: status.errors || null };
  } catch { return null; }
}

module.exports = { sendTextMessage, sendMediaMessage, markAsRead, parseWebhookMessage, parseStatusUpdate };
