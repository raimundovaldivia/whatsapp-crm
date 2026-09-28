const db = require('../db/database');
const whatsappService = require('./whatsapp');
const twilioService = require('./twilio-whatsapp');
const kapsoService = require('./kapso-whatsapp');

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function phoneDigits(value = '') {
  return String(value).replace(/\D/g, '');
}

function windowInfoFromLastInbound(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) {
    return { available: false, reason: 'NO_INBOUND', lastInboundAt: null, expiresAt: null };
  }
  const last = new Date(lastInboundAt);
  if (Number.isNaN(last.getTime())) {
    return { available: false, reason: 'NO_INBOUND', lastInboundAt: null, expiresAt: null };
  }
  const expiresAt = new Date(last.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  return {
    available: now.getTime() < expiresAt.getTime(),
    reason: now.getTime() < expiresAt.getTime() ? null : 'WINDOW_EXPIRED',
    lastInboundAt: last.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function getCustomerServiceWindow(orgId, phone, now = new Date()) {
  const normalized = phoneDigits(phone);
  if (!normalized) return { available: false, reason: 'NO_PHONE', conversationId: null, lastInboundAt: null, expiresAt: null };

  const { rows: [conversation] } = await db.getPool().query(`
    SELECT c.id,
           (SELECT MAX(m.created_at)
              FROM messages m
             WHERE m.conversation_id = c.id
               AND m.direction = 'inbound') AS last_inbound_at
      FROM conversations c
     WHERE c.organization_id = $1
       AND regexp_replace(COALESCE(c.phone_number, ''), '[^0-9]', '', 'g') = $2
     ORDER BY last_inbound_at DESC NULLS LAST, c.last_message_at DESC NULLS LAST
     LIMIT 1`, [orgId, normalized]);

  if (!conversation) {
    return { available: false, reason: 'NO_CONVERSATION', conversationId: null, lastInboundAt: null, expiresAt: null };
  }
  return { conversationId: conversation.id, ...windowInfoFromLastInbound(conversation.last_inbound_at, now) };
}

function enRouteText({ customerName, orderName }) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hola ${firstName} 👋` : 'Hola 👋';
  const order = orderName ? ` ${orderName}` : '';
  return `${greeting} Tu pedido${order} ya va en camino 🚚. Por favor, mantente atento/a para recibirlo.`;
}

async function sendProviderText(phone, text, config) {
  if (config.provider === 'twilio') return twilioService.sendTextMessage(phone, text, config);
  if (config.provider === 'kapso') return kapsoService.sendTextMessage(phone, text, config);
  return whatsappService.sendTextMessage(phone, text, config);
}

async function sendEnRouteNotification(orgId, stop) {
  const window = await getCustomerServiceWindow(orgId, stop.phone);
  if (!window.available) {
    const error = new Error('La ventana de 24 horas está cerrada. Para avisar se necesita un template aprobado.');
    error.status = 409;
    error.code = window.reason || 'WINDOW_EXPIRED';
    error.window = window;
    throw error;
  }

  const config = await db.getWhatsappConfig(orgId);
  if (!config) {
    const error = new Error('WhatsApp no está configurado para esta cuenta.');
    error.status = 400;
    error.code = 'WHATSAPP_NOT_CONFIGURED';
    throw error;
  }

  const text = enRouteText(stop);
  let sent;
  try {
    sent = await sendProviderText(stop.phone, text, config);
  } catch (error) {
    if (error.is24hWindow) {
      error.status = 409;
      error.code = 'WINDOW_EXPIRED';
      error.message = 'La ventana de 24 horas se cerró. Para avisar se necesita un template aprobado.';
    }
    throw error;
  }

  const messageId = sent?.messageId || sent?.messages?.[0]?.id || sent?.sid || null;
  let message = null;
  try {
    message = await db.saveMessage({
      conversationId: window.conversationId,
      whatsappMessageId: messageId,
      direction: 'outbound',
      content: text,
      status: 'sent',
      sentBy: 'ai',
      agentType: 'delivery',
    });
    await db.updateConversationLastMessage(window.conversationId, text);
  } catch (error) {
    // El proveedor ya aceptó el mensaje: no devolver un error que provoque un
    // segundo envío. El aviso queda como enviado aunque falle el registro local.
    console.error('[Delivery notification] Mensaje enviado pero no registrado:', error.message);
  }

  return { sent: true, text, message, conversationId: window.conversationId, window };
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  phoneDigits,
  windowInfoFromLastInbound,
  getCustomerServiceWindow,
  enRouteText,
  sendEnRouteNotification,
};
