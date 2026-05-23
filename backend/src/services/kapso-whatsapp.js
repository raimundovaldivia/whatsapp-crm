/**
 * kapso-whatsapp.js — Envío y recepción de mensajes via Kapso
 *
 * Kapso actúa como proxy sobre la Meta Cloud API, eliminando todo el proceso
 * de verificación de empresa en Facebook. La API es casi idéntica a Meta
 * pero usa una API key propia en lugar del access_token de Meta.
 *
 * Credenciales requeridas en la config de la org:
 *   kapso_api_key   → API Key de Kapso (desde app.kapso.ai → Settings → API Keys)
 *   phone_number_id → Phone Number ID de WhatsApp (el mismo concepto que en Meta)
 *   webhook_secret  → (Opcional) Secret para verificar firma HMAC de webhooks
 *
 * Webhooks en Kapso:
 *   1. En app.kapso.ai → tu número → Webhooks → crear webhook
 *   2. URL: POST https://TU-BACKEND.onrender.com/kapso-webhook
 *   3. Eventos a suscribir: whatsapp.message.received
 *
 * Docs: https://docs.kapso.ai
 */

const axios  = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://api.kapso.ai/meta/whatsapp';
const API_VER  = 'v24.0';

/**
 * Envía un mensaje de texto por WhatsApp via Kapso.
 * @param {string} to     - Número destino con código de país (ej: 56912345678)
 * @param {string} text   - Texto del mensaje
 * @param {object} config - Config de la org (kapso_api_key, phone_number_id)
 */
async function sendTextMessage(to, text, config) {
  const { kapso_api_key, phone_number_id } = config;

  const response = await axios.post(
    `${BASE_URL}/${API_VER}/${phone_number_id}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        'X-API-Key':     kapso_api_key,
        'Content-Type':  'application/json',
      },
    }
  );

  return response.data;
}

/**
 * Marca un mensaje como leído via Kapso.
 * @param {string} messageId - WAMID del mensaje
 * @param {object} config    - Config de la org (kapso_api_key, phone_number_id)
 */
async function markAsRead(messageId, config) {
  const { kapso_api_key, phone_number_id } = config;
  try {
    await axios.post(
      `${BASE_URL}/${API_VER}/${phone_number_id}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { 'X-API-Key': kapso_api_key } }
    );
  } catch { /* No crítico */ }
}

/**
 * Parsea el payload de un webhook de Kapso (v2 format).
 *
 * Kapso envía eventos como:
 * {
 *   event: 'whatsapp.message.received',
 *   message: { id, type, text: { body }, kapso: { direction, content, ... } },
 *   conversation: { phone_number, kapso: { contact_name } },
 *   phone_number_id: '...'
 * }
 *
 * @param {object} body - req.body ya parseado
 * @returns {{ messageId, from, contactName, text, type }} | null
 */
function parseWebhookMessage(body) {
  try {
    if (body.event !== 'whatsapp.message.received') return null;

    const message  = body.message;
    const conv     = body.conversation;
    if (!message || !conv) return null;

    // Solo procesamos mensajes de texto por ahora
    // Para audio, Kapso ya transcribe automáticamente en message.kapso.transcript
    const text = message.type === 'text'
      ? message.text?.body
      : message.kapso?.content || null;   // fallback: descripción generada por Kapso

    if (!text) return null;

    return {
      messageId:   message.id,
      from:        conv.phone_number?.replace(/^\+/, ''), // sin "+" para consistencia interna
      contactName: conv.kapso?.contact_name || null,
      timestamp:   message.timestamp,
      type:        message.type,
      text,
    };
  } catch { return null; }
}

/**
 * Parsea eventos de estado (delivered, read, failed) del webhook de Kapso.
 *
 * Eventos de estado: whatsapp.message.delivered, whatsapp.message.read, whatsapp.message.failed
 *
 * @param {object} body
 * @returns {{ messageId, status, recipientId }} | null
 */
function parseStatusUpdate(body) {
  try {
    const statusEvents = [
      'whatsapp.message.sent',
      'whatsapp.message.delivered',
      'whatsapp.message.read',
      'whatsapp.message.failed',
    ];
    if (!statusEvents.includes(body.event)) return null;

    const message = body.message;
    if (!message?.id) return null;

    // Extraer status limpio del event name: "whatsapp.message.delivered" → "delivered"
    const status = body.event.split('.').pop();

    return {
      messageId:   message.id,
      status,
      recipientId: body.conversation?.phone_number || null,
    };
  } catch { return null; }
}

/**
 * Verifica la firma HMAC-SHA256 del webhook de Kapso.
 *
 * Kapso envía la firma en el header X-Webhook-Signature.
 * La firma se calcula sobre el JSON.stringify del payload.
 *
 * @param {string} rawBody  - Body como string (JSON.stringify del parsed body)
 * @param {string} signature - Valor del header X-Webhook-Signature
 * @param {string} secret    - Webhook secret configurado en Kapso
 * @returns {boolean}
 */
function verifySignature(rawBody, signature, secret) {
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch { return false; }
}

module.exports = { sendTextMessage, markAsRead, parseWebhookMessage, parseStatusUpdate, verifySignature };
