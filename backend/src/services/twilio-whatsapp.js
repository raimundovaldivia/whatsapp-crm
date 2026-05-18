/**
 * twilio-whatsapp.js — Envío y recepción de mensajes via Twilio WhatsApp
 *
 * Credenciales requeridas en la config de la org:
 *   twilio_account_sid   → Account SID (ACxxx...)
 *   twilio_auth_token    → Auth Token
 *   twilio_phone_number  → Número Twilio (ej: +14155238886 para el sandbox)
 *
 * Webhook en Twilio: POST /twilio-webhook
 */

const twilio = require('twilio');

/**
 * Envía un mensaje de texto por WhatsApp via Twilio.
 * @param {string} to   - Número destino con código de país (ej: 56912345678)
 * @param {string} text - Texto del mensaje
 * @param {object} config - Config de la org (twilio_account_sid, twilio_auth_token, twilio_phone_number)
 */
async function sendTextMessage(to, text, config) {
  const client = twilio(config.twilio_account_sid, config.twilio_auth_token);

  // Formato Twilio WhatsApp: whatsapp:+56912345678
  const toFormatted   = `whatsapp:${to.startsWith('+') ? to : '+' + to}`;
  const fromFormatted = `whatsapp:${config.twilio_phone_number}`;

  const message = await client.messages.create({
    from: fromFormatted,
    to:   toFormatted,
    body: text,
  });

  return { messageId: message.sid, status: message.status };
}

/**
 * Parsea el body de un webhook de Twilio (application/x-www-form-urlencoded).
 * @param {object} body - req.body ya parseado por express.urlencoded
 * @returns {{ messageId, from, contactName, text, type }} | null
 */
function parseWebhookMessage(body) {
  try {
    const from = body.From?.replace('whatsapp:', '') || null; // quita el prefijo
    const text = body.Body?.trim()                  || null;
    const messageId   = body.MessageSid             || null;
    const contactName = body.ProfileName            || null;

    if (!from || !text || !messageId) return null;

    return { messageId, from, contactName, text, type: 'text' };
  } catch { return null; }
}

/**
 * Verifica la firma del webhook de Twilio (seguridad).
 * Opcional pero recomendado en producción.
 */
function validateSignature(req, authToken) {
  try {
    const signature = req.headers['x-twilio-signature'] || '';
    const url = `${process.env.PUBLIC_URL}/twilio-webhook`;
    return twilio.validateRequest(authToken, signature, url, req.body);
  } catch { return false; }
}

module.exports = { sendTextMessage, parseWebhookMessage, validateSignature };
