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
    return {
      messageId: message.id,
      from: message.from,
      contactName: contact?.profile?.name || null,
      timestamp: message.timestamp,
      type: message.type,
      text: message.type === 'text' ? message.text?.body : null,
    };
  } catch { return null; }
}

function parseStatusUpdate(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.statuses?.length) return null;
    const status = value.statuses[0];
    return { messageId: status.id, status: status.status, recipientId: status.recipient_id };
  } catch { return null; }
}

module.exports = { sendTextMessage, markAsRead, parseWebhookMessage, parseStatusUpdate };
