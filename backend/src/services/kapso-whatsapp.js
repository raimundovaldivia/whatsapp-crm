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
/**
 * Detecta si un error de Kapso/Meta es por ventana de 24h expirada.
 * En ese caso solo se pueden enviar templates, no mensajes de texto libre.
 */
function is24hWindowError(err) {
  const body = err.response?.data;
  // Kapso devuelve el error como string o como objeto
  const msg = typeof body === 'string' ? body
    : body?.error || body?.message || JSON.stringify(body || '');
  return typeof msg === 'string' && (
    msg.includes('24-hour window') ||
    msg.includes('non-template') ||
    msg.includes('outside the 24') ||
    // código de error Meta: 131047
    msg.includes('131047')
  );
}

async function sendTextMessage(to, text, config) {
  const { phone_number_id } = config;
  // Preferir la API Key de la org; si no existe (flujo Setup Links), usar la key de plataforma
  const apiKey = config.kapso_api_key || process.env.KAPSO_API_KEY;
  if (!apiKey) throw new Error('No hay Kapso API Key disponible (ni por org ni como KAPSO_API_KEY env var)');

  try {
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
          'X-API-Key':     apiKey,
          'Content-Type':  'application/json',
        },
      }
    );
    return response.data;
  } catch (err) {
    const status  = err.response?.status;
    const errBody = err.response?.data;
    const detail  = errBody ? JSON.stringify(errBody) : err.message;

    // Marcar el error con un flag especial para que los callers lo detecten
    if (is24hWindowError(err)) {
      console.warn(`[KapsoWA] ⏰ Ventana 24h expirada para ${to} — solo se pueden enviar templates`);
      const windowErr = new Error('WINDOW_EXPIRED: ventana de 24 horas expirada');
      windowErr.is24hWindow = true;
      throw windowErr;
    }

    console.error(`[KapsoWA] sendTextMessage FAILED — to:${to} phone_number_id:${phone_number_id} status:${status} — ${detail}`);
    throw err;
  }
}

/**
 * Marca un mensaje como leído via Kapso.
 * @param {string} messageId - WAMID del mensaje
 * @param {object} config    - Config de la org (kapso_api_key, phone_number_id)
 */
async function markAsRead(messageId, config) {
  const { phone_number_id } = config;
  const apiKey = config.kapso_api_key || process.env.KAPSO_API_KEY;
  if (!apiKey) return; // Sin key, saltar silenciosamente
  try {
    await axios.post(
      `${BASE_URL}/${API_VER}/${phone_number_id}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { 'X-API-Key': apiKey } }
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
/**
 * parseWebhookMessage — soporta Kapso v2
 *
 * En v2 el evento llega en el header X-Webhook-Event, no en body.event.
 * Se pasa explícitamente como parámetro `event`.
 *
 * Payload v2 reference:
 *   https://docs.kapso.ai/docs/platform/webhooks/event-types.md
 */
function parseWebhookMessage(body, event) {
  try {
    // Aceptar tanto el header como body.event (por si acaso)
    const evtName = event || body.event;
    if (evtName !== 'whatsapp.message.received') return null;

    const message  = body.message;
    const conv     = body.conversation;
    if (!message) return null;

    // Solo mensajes entrantes (inbound)
    const direction = message.kapso?.direction;
    if (direction && direction !== 'inbound') return null;

    // Texto: v2 usa message.text.body para texto;
    // Para audio Kapso genera transcript en message.kapso.transcript
    // Para otros tipos usa message.kapso.content como fallback
    let text = null;
    if (message.type === 'text') {
      text = message.text?.body;
    } else if (message.type === 'audio' && message.kapso?.transcript?.text) {
      text = `🎤 ${message.kapso.transcript.text}`;
    } else {
      text = message.kapso?.content || null;
    }
    if (!text) return null;

    // Número del remitente: v2 usa conversation.phone_number (con +)
    // Fallback a message.from (también presente en v2)
    const fromRaw = conv?.phone_number || message.from || null;
    const from    = fromRaw?.replace(/^\+/, ''); // sin "+" para consistencia interna

    return {
      messageId:   message.id,
      from,
      contactName: conv?.kapso?.contact_name || null,
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
/**
 * parseStatusUpdate — soporta Kapso v2 (evento en header, no en body)
 */
function parseStatusUpdate(body, event) {
  try {
    const evtName = event || body.event;
    const statusEvents = [
      'whatsapp.message.sent',
      'whatsapp.message.delivered',
      'whatsapp.message.read',
      'whatsapp.message.failed',
    ];
    if (!statusEvents.includes(evtName)) return null;

    const message = body.message;
    if (!message?.id) return null;

    // Extraer status limpio del event name: "whatsapp.message.delivered" → "delivered"
    const status = evtName.split('.').pop();

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

/**
 * Obtiene la lista de templates aprobados de la cuenta de WhatsApp Business.
 * @param {object} config - Config de la org (kapso_api_key, business_account_id)
 * @returns {Array} Lista de templates
 */
async function getTemplates(config) {
  const apiKey = config.kapso_api_key || process.env.KAPSO_API_KEY;
  const wabaId = config.business_account_id || process.env.KAPSO_WABA_ID;

  if (!apiKey) throw new Error('No hay Kapso API Key disponible');
  if (!wabaId) throw new Error('No hay WABA ID configurado. Agrégalo en la config de WhatsApp o como variable KAPSO_WABA_ID.');

  try {
    const response = await axios.get(
      `${BASE_URL}/${API_VER}/${wabaId}/message_templates?limit=100&status=APPROVED`,
      { headers: { 'X-API-Key': apiKey } }
    );
    return response.data?.data || response.data || [];
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[KapsoWA] getTemplates FAILED — waba_id:${wabaId} — ${detail}`);
    throw err;
  }
}

/**
 * Envía un mensaje de template de WhatsApp via Kapso.
 * @param {string} to             - Número destino (ej: 56912345678)
 * @param {string} templateName   - Nombre del template aprobado
 * @param {string} languageCode   - Código de idioma (ej: 'es', 'es_MX', 'en_US')
 * @param {Array}  components     - Componentes con variables (body params, etc.)
 * @param {object} config         - Config de la org
 *
 * Ejemplo components para body con {{1}}:
 *   [{ type: 'body', parameters: [{ type: 'text', text: 'Juan' }] }]
 */
async function sendTemplate(to, templateName, languageCode = 'es', components = [], config) {
  const { phone_number_id } = config;
  const apiKey = config.kapso_api_key || process.env.KAPSO_API_KEY;
  if (!apiKey) throw new Error('No hay Kapso API Key disponible');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to,
    type:     'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
    },
  };

  if (components && components.length > 0) {
    payload.template.components = components;
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/${API_VER}/${phone_number_id}/messages`,
      payload,
      {
        headers: {
          'X-API-Key':    apiKey,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (err) {
    const status  = err.response?.status;
    const errBody = err.response?.data;
    const detail  = errBody ? JSON.stringify(errBody) : err.message;
    console.error(`[KapsoWA] sendTemplate FAILED — to:${to} template:${templateName} status:${status} — ${detail}`);
    throw err;
  }
}

/**
 * Crea un template de WhatsApp en Meta Business Manager via Kapso.
 * El template queda en estado PENDING hasta que Meta lo aprueba (1-3 días).
 * @param {Object} templateData - { name, language, category, components }
 * @param {Object} config       - { kapso_api_key, business_account_id }
 */
async function createTemplate(templateData, config) {
  const wabaId = config.business_account_id || process.env.KAPSO_WABA_ID;
  const apiKey = config.kapso_api_key || process.env.KAPSO_API_KEY;
  if (!wabaId) throw new Error('business_account_id requerido para crear templates');
  if (!apiKey) throw new Error('Kapso API Key no disponible');

  try {
    const response = await axios.post(
      `${BASE_URL}/${API_VER}/${wabaId}/message_templates`,
      templateData,
      {
        headers: {
          'X-API-Key':    apiKey,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (err) {
    const status  = err.response?.status;
    const detail  = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[KapsoWA] createTemplate FAILED — name:${templateData.name} status:${status} — ${detail}`);
    throw err;
  }
}

module.exports = { sendTextMessage, markAsRead, parseWebhookMessage, parseStatusUpdate, verifySignature, is24hWindowError, getTemplates, sendTemplate, createTemplate };
