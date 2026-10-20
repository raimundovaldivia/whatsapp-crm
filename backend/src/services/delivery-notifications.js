const db = require('../db/database');
const whatsappService = require('./whatsapp');
const twilioService = require('./twilio-whatsapp');
const kapsoService = require('./kapso-whatsapp');
const evolutionService = require('./evolution-whatsapp');
const templateAutomation = require('./template-automation');
const { toISODate } = require('./business-date');
const { normalizeOrderLabel } = require('../utils/order-reference');

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function phoneDigits(value = '') {
  const digits = String(value).trim().split('@')[0].split(':')[0].replace(/\D/g, '');
  return /^9\d{8}$/.test(digits) ? `56${digits}` : digits;
}

function stopOrderLabel(stop = {}) {
  return normalizeOrderLabel(stop.orderName, stop.source, stop.id) || stop.orderName || stop.id || '';
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

async function getCustomerServiceWindow(orgId, phone, now = new Date(), preferredConversationId = null) {
  const normalized = phoneDigits(phone);
  if (!normalized) return { available: false, reason: 'NO_PHONE', conversationId: null, lastInboundAt: null, expiresAt: null };

  const { rows: [conversation] } = await db.getPool().query(`
    SELECT c.id, c.whatsapp_channel_id,
           (SELECT MAX(m.created_at)
              FROM messages m
             WHERE m.conversation_id = c.id
               AND m.direction = 'inbound') AS last_inbound_at
      FROM conversations c
     WHERE c.organization_id = $1
       AND NOT EXISTS (SELECT 1 FROM whatsapp_channels personal WHERE personal.id=c.whatsapp_channel_id AND personal.assigned_user_id IS NOT NULL)
       AND regexp_replace(COALESCE(c.phone_number, ''), '[^0-9]', '', 'g') = $2
       AND ($3::bigint IS NULL OR c.id = $3)
     ORDER BY last_inbound_at DESC NULLS LAST, c.last_message_at DESC NULLS LAST
     LIMIT 1`, [orgId, normalized, preferredConversationId]);

  if (!conversation) {
    return { available: false, reason: 'NO_CONVERSATION', conversationId: null, lastInboundAt: null, expiresAt: null };
  }
  return { conversationId: conversation.id, whatsappChannelId: conversation.whatsapp_channel_id || null, ...windowInfoFromLastInbound(conversation.last_inbound_at, now) };
}

function enRouteText({ customerName, orderName, trackingUrl }) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hola ${firstName} 👋` : 'Hola 👋';
  const normalizedOrderName = normalizeOrderLabel(orderName);
  const order = normalizedOrderName ? ` ${normalizedOrderName}` : '';
  const tracking = trackingUrl ? `\nPuedes ver la ubicación del reparto aquí: ${trackingUrl}` : '';
  return `${greeting} Tu pedido${order} ya va en camino 🚚. Por favor, mantente atento/a para recibirlo.${tracking}`;
}

function loadConsolidatedText({ customerName, orderName, trackingUrl }) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hola ${firstName} 👋` : 'Hola 👋';
  const normalizedOrderName = normalizeOrderLabel(orderName);
  const order = normalizedOrderName ? ` ${normalizedOrderName}` : '';
  const tracking = trackingUrl ? `\nSigue la ubicación del reparto aquí: ${trackingUrl}` : '';
  return `${greeting} Tu pedido${order} ya fue consolidado y quedó en manos del repartidor 🚚. Desde ahora puedes escribirnos por este chat si necesitas coordinar la entrega.${tracking}`;
}

function deliveryOutcomeText(stop, { status, note, deliveryDate } = {}) {
  const firstName = String(stop?.customerName || stop?.customer_name || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hola ${firstName} 👋` : 'Hola 👋';
  const orderLabel = stopOrderLabel(stop);
  const order = orderLabel ? ` ${orderLabel}` : '';
  const reason = String(note || '').trim();
  if (status === 'postponed') {
    const date = toISODate(deliveryDate);
    const formatted = date ? date.split('-').reverse().join('-') : 'la nueva fecha acordada';
    return `${greeting} Tu pedido${order} quedó reprogramado para el ${formatted}. ¿Te sirve esa fecha o necesitas que coordinemos otra alternativa?`;
  }
  if (status === 'cancelled') {
    return `${greeting} Vimos que tu pedido${order} no pudo completarse${reason ? `: ${reason}` : ''}. Antes de cerrarlo definitivamente queremos ayudarte: ¿prefieres reprogramar, corregir algún dato o cancelar?`;
  }
  return `${greeting} No pudimos completar la entrega de tu pedido${order}${reason ? `: ${reason}` : ''}. Queremos resolverlo contigo. ¿Prefieres reprogramar, corregir la dirección o coordinar otra alternativa?`;
}

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizedItems(order = {}) {
  const items = jsonValue(order.items, []);
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    name: String(item?.name || item?.title || item?.product_name || '').trim(),
    quantity: Math.max(0, Number(item?.quantity) || 0),
    price: Math.max(0, Number(item?.price) || 0),
  })).filter(item => item.name && item.quantity > 0);
}

function normalizedAddress(order = {}) {
  const embedded = jsonValue(order.shipping_address, {}) || {};
  return {
    address: String(order.shipping_address1 || embedded.address1 || embedded.address || '').trim(),
    city: String(order.shipping_city || embedded.city || '').trim(),
  };
}

function orderEditChanges(before = {}, after = {}) {
  const previousItems = normalizedItems(before);
  const currentItems = normalizedItems(after);
  const previousAddress = normalizedAddress(before);
  const currentAddress = normalizedAddress(after);
  const previousTotal = Math.round(Number(before.total_price) || 0);
  const currentTotal = Math.round(Number(after.total_price) || 0);
  const previousDate = toISODate(before.delivery_date);
  const currentDate = toISODate(after.delivery_date);
  const changes = {};
  if (JSON.stringify(previousItems) !== JSON.stringify(currentItems)) changes.items = currentItems;
  if (JSON.stringify(previousAddress) !== JSON.stringify(currentAddress)) changes.address = currentAddress;
  if (previousTotal !== currentTotal) changes.total = currentTotal;
  if (previousDate !== currentDate && currentDate) changes.deliveryDate = currentDate;
  return changes;
}

function money(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
}

function orderEditText({ customerName, orderLabel, changes }) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hola ${firstName} 👋` : 'Hola 👋';
  const lines = [`${greeting}\nActualizamos tu pedido${orderLabel ? ` ${orderLabel}` : ''}:`];
  if (changes.items) {
    lines.push(`📦 Productos: ${changes.items.map(item => `${item.quantity}x ${item.name}`).join(' · ')}`);
  }
  if (changes.address) {
    const destination = [changes.address.address, changes.address.city].filter(Boolean).join(', ');
    lines.push(`📍 Dirección: ${destination}`);
  }
  if (Object.hasOwn(changes, 'deliveryDate') && changes.deliveryDate) {
    const [year, month, day] = changes.deliveryDate.split('-');
    lines.push(`📅 Fecha de entrega: ${day}-${month}-${year}`);
  }
  if (Object.hasOwn(changes, 'total')) lines.push(`💰 Nuevo total: ${money(changes.total)}`);
  lines.push('Si algo no corresponde, respóndenos por aquí y lo revisamos.');
  return lines.join('\n');
}

function enRouteTemplateComponents(stop) {
  const name = String(stop.customerName || '').trim().split(/\s+/)[0] || 'Cliente';
  const order = String(stopOrderLabel(stop) || 'tu pedido').trim();
  const address = String(stop.fullAddress || stop.address || 'la dirección registrada').trim();
  return [{
    type: 'body',
    parameters: [name, order, address].map(text => ({ type: 'text', text })),
  }];
}

function deliveryResolutionTemplateComponents(stop, outcome = {}) {
  const name = String(stop.customerName || stop.customer_name || '').trim().split(/\s+/)[0] || 'Cliente';
  const order = String(stopOrderLabel(stop) || 'tu pedido').trim();
  const reason = String(outcome.note || (outcome.status === 'postponed' ? 'entrega reprogramada' : 'entrega no completada')).trim().slice(0, 180);
  return [{
    type: 'body',
    parameters: [name, order, reason].map(text => ({ type: 'text', text })),
  }];
}

function customerFeedbackText({ customerName, orderName }) {
  const firstName = String(customerName || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hola ${firstName} 👋` : 'Hola 👋';
  const normalizedOrderName = normalizeOrderLabel(orderName);
  const reference = normalizedOrderName ? ` (${normalizedOrderName})` : '';
  return `${greeting} Queremos saber cómo fue tu primera experiencia con nosotros${reference}. Del 1 al 5, ¿qué nota le pondrías? Si quieres, cuéntanos qué podríamos mejorar.`;
}

function customerFeedbackTemplateComponents(stop) {
  const name = String(stop.customerName || stop.customer_name || '').trim().split(/\s+/)[0] || 'Cliente';
  const order = String(stopOrderLabel(stop) || 'tu primera compra').trim();
  return [{
    type: 'body',
    parameters: [name, order].map(text => ({ type: 'text', text })),
  }];
}

function customerFeedbackTemplateText(stop) {
  const name = String(stop.customerName || stop.customer_name || '').trim().split(/\s+/)[0] || 'Cliente';
  const order = String(stopOrderLabel(stop) || 'tu primera compra').trim();
  return `Hola ${name}. Queremos saber cómo fue tu primera experiencia con nosotros por el pedido ${order}. Del 1 al 5, ¿qué nota le pondrías? Si quieres, cuéntanos qué podríamos mejorar.`;
}

async function sendProviderText(phone, text, config) {
  if (config.provider === 'twilio') return twilioService.sendTextMessage(phone, text, config);
  if (config.provider === 'kapso') return kapsoService.sendTextMessage(phone, text, config);
  if (config.provider === 'evolution') return evolutionService.sendTextMessage(phone, text, config);
  return whatsappService.sendTextMessage(phone, text, config);
}

async function sendDeliveryNotification(orgId, stop, {
  text,
  assignmentKey = 'delivery_en_route',
  templateComponents = enRouteTemplateComponents(stop),
  templateText = null,
  templateLabel = 'Pedido en camino',
  agentType = 'delivery',
} = {}) {
  const window = await getCustomerServiceWindow(
    orgId,
    stop.phone,
    new Date(),
    stop.conversationId || stop.conversation_id || null
  );
  let config = null;
  if (window.whatsappChannelId && db.getWhatsappChannel) {
    config = await db.getWhatsappChannel(orgId, window.whatsappChannelId);
  }
  if (!config) config = await db.getWhatsappConfig(orgId);
  if (!config && db.getDefaultWhatsappChannel) config = await db.getDefaultWhatsappChannel(orgId);
  if (!config) {
    const error = new Error('WhatsApp no está configurado para esta cuenta.');
    error.status = 400;
    error.code = 'WHATSAPP_NOT_CONFIGURED';
    throw error;
  }

  let sent;
  let via = 'text';
  let assignment = null;

  const sendAssignedTemplate = async () => {
    assignment = await templateAutomation.getAssignment(orgId, assignmentKey);
    if (!assignment) {
      const error = new Error(`La ventana de 24 horas está cerrada y no hay un template automático asignado para “${templateLabel}”.`);
      error.status = 409;
      error.code = window.reason || 'WINDOW_EXPIRED';
      error.window = window;
      throw error;
    }
    if (!['kapso', 'meta'].includes(config.provider)) {
      const error = new Error('El proveedor configurado no admite templates automáticos.');
      error.status = 400;
      error.code = 'TEMPLATES_NOT_SUPPORTED';
      throw error;
    }
    via = 'template';
    return kapsoService.sendTemplate(
      stop.phone,
      assignment.name,
      assignment.language || 'es',
      templateComponents,
      config
    );
  };

  if (window.available || config.provider === 'evolution') {
    try {
      sent = await sendProviderText(stop.phone, text, config);
    } catch (error) {
      if (!error.is24hWindow) throw error;
      sent = await sendAssignedTemplate();
    }
  } else {
    sent = await sendAssignedTemplate();
  }

  const messageId = sent?.messageId || sent?.messages?.[0]?.id || sent?.sid || null;
  const deliveredText = via === 'template' && templateText ? templateText : text;
  let message = null;
  let conversationId = window.conversationId;
  try {
    if (!conversationId && typeof db.upsertConversation === 'function') {
      const conversation = await db.upsertConversation(
        orgId,
        stop.phone,
        stop.customerName || stop.customer_name || 'Cliente',
        config.id || null
      );
      conversationId = conversation?.id || null;
    }
    message = await db.saveMessage({
      conversationId,
      whatsappMessageId: messageId,
      direction: 'outbound',
      content: via === 'template' ? `[Template: ${assignment.name}]\n\n${deliveredText}` : deliveredText,
      status: via === 'template' ? 'pending' : 'sent',
      sentBy: 'ai',
      agentType,
    });
    if (conversationId) await db.updateConversationLastMessage(conversationId, deliveredText);
  } catch (error) {
    // El proveedor ya aceptó el mensaje: no devolver un error que provoque un
    // segundo envío. El aviso queda como enviado aunque falle el registro local.
    console.error('[Delivery notification] Mensaje enviado pero no registrado:', error.message);
  }

  return { sent: true, text: deliveredText, message, conversationId, window, via, templateName: assignment?.name || null };
}

async function sendEnRouteNotification(orgId, stop) {
  return sendDeliveryNotification(orgId, stop, {
    text: enRouteText(stop),
    templateText: enRouteText({ ...stop, trackingUrl: null }),
  });
}

async function sendLoadConsolidatedNotification(orgId, stop) {
  return sendDeliveryNotification(orgId, stop, {
    text: loadConsolidatedText(stop),
    templateText: loadConsolidatedText({ ...stop, trackingUrl: null }),
    templateLabel: 'Pedido en camino',
    agentType: 'delivery_consolidated',
  });
}

async function sendDeliveryOutcomeRecovery(orgId, stop, outcome) {
  return sendDeliveryNotification(orgId, stop, {
    text: deliveryOutcomeText(stop, outcome),
    assignmentKey: 'delivery_resolution',
    templateComponents: deliveryResolutionTemplateComponents(stop, outcome),
    templateLabel: 'Resolver entrega',
    agentType: 'delivery_recovery',
  });
}

async function sendCustomerFeedbackRequest(orgId, stop) {
  const text = customerFeedbackText(stop);
  return sendDeliveryNotification(orgId, stop, {
    text,
    templateText: customerFeedbackTemplateText(stop),
    assignmentKey: 'customer_feedback',
    templateComponents: customerFeedbackTemplateComponents(stop),
    templateLabel: 'Opinión primera compra',
    agentType: 'customer_feedback',
  });
}

async function sendOrderEditNotification(orgId, { source = 'bot', id, before, after }) {
  const changes = orderEditChanges(before, after);
  if (!Object.keys(changes).length) return { sent: false, skipped: true, reason: 'NO_CHANGES' };

  const phone = after?.customer_phone || before?.customer_phone;
  if (!phoneDigits(phone)) return { sent: false, skipped: true, reason: 'NO_PHONE' };
  const window = await getCustomerServiceWindow(orgId, phone);
  let conversation = window.conversationId
    ? await db.getConversationById(window.conversationId, orgId).catch(() => null)
    : null;
  let config = await require('./whatsapp-provider').configForConversation(orgId, conversation);
  if (!config) return { sent: false, skipped: true, reason: 'WHATSAPP_NOT_CONFIGURED' };
  if (!window.available && config.provider !== 'evolution') {
    return { sent: false, skipped: true, reason: window.reason || 'WINDOW_EXPIRED' };
  }
  if (!conversation) {
    conversation = await db.upsertConversation(
      orgId,
      phone,
      after?.customer_name || before?.customer_name || 'Cliente',
      config.id || null
    );
    config = await require('./whatsapp-provider').configForConversation(orgId, conversation) || config;
  }

  const orderLabel = source === 'shopify'
    ? String(after?.name || after?.order_number || before?.name || before?.order_number || `#${id}`)
    : `#DR-${id}`;
  const text = orderEditText({
    customerName: after?.customer_name || before?.customer_name,
    orderLabel,
    changes,
  });
  try {
    const sent = await sendProviderText(phone, text, config);
    const message = await db.saveMessage({
      conversationId: conversation.id,
      whatsappMessageId: require('./whatsapp-provider').messageId(sent),
      direction: 'outbound',
      content: text,
      status: 'sent',
      sentBy: 'human',
      agentType: 'order_edit',
    });
    await db.updateConversationLastMessage(conversation.id, text);
    return { sent: true, text, message, conversationId: conversation.id, changes };
  } catch (error) {
    if (error.is24hWindow) return { sent: false, skipped: true, reason: 'WINDOW_EXPIRED' };
    console.error('[Order edit notification] No se pudo enviar:', error.message);
    return { sent: false, skipped: true, reason: 'SEND_FAILED', error: error.message };
  }
}

module.exports = {
  sendDeliveryNotification,
  CUSTOMER_SERVICE_WINDOW_MS,
  phoneDigits,
  windowInfoFromLastInbound,
  getCustomerServiceWindow,
  enRouteText,
  loadConsolidatedText,
  deliveryOutcomeText,
  enRouteTemplateComponents,
  deliveryResolutionTemplateComponents,
  customerFeedbackText,
  customerFeedbackTemplateComponents,
  customerFeedbackTemplateText,
  sendEnRouteNotification,
  sendLoadConsolidatedNotification,
  sendDeliveryOutcomeRecovery,
  sendCustomerFeedbackRequest,
  normalizedItems,
  normalizedAddress,
  orderEditChanges,
  orderEditText,
  sendOrderEditNotification,
};
