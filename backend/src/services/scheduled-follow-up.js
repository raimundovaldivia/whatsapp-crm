/**
 * scheduled-follow-up.js — Envía templates de WhatsApp a clientes con pedidos agendados
 *
 * Corre una vez al día (a las 9:00 AM hora de Chile).
 * Busca pedidos agendados cuya desired_date ya llegó y les envía un template
 * de WhatsApp (necesario porque la ventana de 24h habrá expirado).
 *
 * Configuración por org:
 *   setting: 'scheduled_order_template' → nombre del template aprobado a usar
 *   Si no está configurado, el pedido se registra en logs pero no se envía nada.
 */

const db           = require('../db/database');
const kapsoService = require('./kapso-whatsapp');
const whatsappService = require('./whatsapp');
const twilioService = require('./twilio-whatsapp');
const deliveryNotifications = require('./delivery-notifications');
const templateAutomation = require('./template-automation');
const { activateDivaForAutomatedMessage } = require('./conversation-mode');
const { isCustomerMessagingHour } = require('./outbound-policy');

/**
 * Envía los follow-ups de pedidos agendados para HOY y días anteriores no enviados.
 * @param {object} io - Socket.IO para notificaciones en tiempo real (opcional)
 */
async function runScheduledFollowUp(io = null, now = new Date()) {
  if (!isCustomerMessagingHour(now)) {
    console.log('[ScheduledFollowUp] Fuera del horario 09:00-20:59 de Chile — se posterga la revisión');
    return { processed: 0, reason: 'outside_customer_hours' };
  }

  console.log('[ScheduledFollowUp] 🔔 Revisando pedidos agendados pendientes...');

  let orders;
  try {
    orders = await db.getPendingScheduledOrders();
  } catch (err) {
    console.error('[ScheduledFollowUp] Error consultando DB:', err.message);
    return { processed: 0 };
  }

  if (!orders.length) {
    console.log('[ScheduledFollowUp] Sin pedidos pendientes para hoy.');
    return { processed: 0 };
  }

  console.log(`[ScheduledFollowUp] ${orders.length} pedido(s) agendado(s) a enviar`);

  for (const order of orders) {
    try {
      await processScheduledOrder(order, io);
    } catch (err) {
      console.error(`[ScheduledFollowUp] Error procesando scheduled_order #${order.id}:`, err.message);
    }
  }

  return { processed: orders.length };
}

async function processScheduledOrder(order, io) {
  const { id, organization_id: orgId, conversation_id: convId, phone, customer_name, product_notes, desired_date, template_name } = order;

  if (!await require('./commercial').permitted(orgId,'orders')) return;
  const name    = customer_name || 'Cliente';
  const product = product_notes || 'tu pedido';

  // 1. Obtener config de WhatsApp de la org
  const wc = await db.getWhatsappConfig(orgId);

  // ─── PASO A: Crear pedido real en la tabla orders ───────────────────────
  // Siempre hacemos esto cuando llega el día, independientemente del template.
  // Verificamos primero que no exista ya un pedido activo para esta conversación.
  try {
    const existing = await db.getActiveOrderForBot(convId);
    if (!existing) {
      // Intentar obtener dirección del contacto
      const contact = await db.getContact(orgId, phone).catch(() => null);
      const shippingAddress = (contact?.address1 || contact?.address)
        ? { address1: contact.address1 || contact.address, city: contact.city || '' }
        : null;

      const newOrder = await db.createOrder({
        conversationId:  convId,
        organizationId:  orgId,
        items:           [{ name: product, quantity: 1 }],
        customerName:    name,
        customerPhone:   phone,
        shippingAddress: shippingAddress,
        totalPrice:      null,
        status:          'por_despachar',
      });
      console.log(`[ScheduledFollowUp] 📦 Orden real creada: id=${newOrder?.id} para scheduled_order #${id}`);
    } else {
      console.log(`[ScheduledFollowUp] 📦 Ya existe orden activa (id=${existing.id}) para conv ${convId} — no se duplica`);
    }
  } catch (orderErr) {
    console.error(`[ScheduledFollowUp] ⚠️ Error creando orden real para scheduled_order #${id}:`, orderErr.message);
    // No interrumpimos — seguimos con el template
  }

  // ─── PASO B: Enviar aviso ────────────────────────────────────────────────
  // Texto libre dentro de la ventana; template solo como respaldo cuando la
  // ventana terminó. Así no se incurre en el costo de template innecesariamente.
  if (!wc) {
    console.warn(`[ScheduledFollowUp] Org ${orgId}: sin WhatsApp — saltando aviso #${id}`);
    await db.markScheduledOrderSent(id);
    return;
  }

  const assignment = await templateAutomation.getAssignment(orgId, 'scheduled_order');
  const tplName = template_name || assignment?.name
    || (await db.getSetting(orgId, 'scheduled_dispatch_template'))
    || (await db.getSetting(orgId, 'scheduled_order_template'));
  const tplLanguage = assignment?.language
    || (await db.getSetting(orgId, 'scheduled_dispatch_template_language'))
    || 'es';

  // 3. Construir los components del template
  //    El template debe tener {{1}} = nombre del cliente, {{2}} = producto
  //    Si solo tiene {{1}}, se usa el nombre. Ajustamos según la cantidad de parámetros.
  const components = [{
    type: 'body',
    parameters: [
      { type: 'text', text: name },
      { type: 'text', text: product },
    ],
  }];

  const window = await deliveryNotifications.getCustomerServiceWindow(orgId, phone);
  const freeText = `Hola ${String(name).trim().split(/\s+/)[0] || 'Cliente'} 👋 Tu pedido agendado de ${product} ya está preparado para despacho. Te avisaremos cuando vaya en camino.`;
  let sentResult;
  let via = 'text';
  const sendTemplate = async () => {
    if (!tplName) throw new Error('La ventana de 24 horas está cerrada y no hay template asignado para Pedido agendado.');
    via = 'template';
    console.log(`[ScheduledFollowUp] Ventana cerrada: usando template '${tplName}' para #${id}`);
    try {
      return await kapsoService.sendTemplate(phone, tplName, tplLanguage, components, wc);
    } catch (sendErr) {
      const metaCode = sendErr.response?.data?.error?.code;
      if (metaCode === 132000 && template_name) {
        return kapsoService.sendTemplate(phone, tplName, tplLanguage, [{
          type: 'body', parameters: [{ type: 'text', text: name }],
        }], wc);
      }
      throw sendErr;
    }
  };

  if (window.available) {
    try {
      if (wc.provider === 'twilio') sentResult = await twilioService.sendTextMessage(phone, freeText, wc);
      else if (wc.provider === 'kapso') sentResult = await kapsoService.sendTextMessage(phone, freeText, wc);
      else sentResult = await whatsappService.sendTextMessage(phone, freeText, wc);
    } catch (sendErr) {
      if (!sendErr.is24hWindow) throw sendErr;
      sentResult = await sendTemplate();
    }
  } else {
    sentResult = await sendTemplate();
  }

  // 5. Guardar mensaje en DB y actualizar pipeline_state.
  const content = via === 'template'
    ? `[Template: ${tplName}]\n\n📅 Despacho de pedido agendado: ${product}`
    : freeText;
  const savedMessage = await db.saveMessage({
    conversationId:    convId,
    whatsappMessageId: sentResult?.messageId || sentResult?.messages?.[0]?.id || sentResult?.sid || null,
    direction:         'outbound',
    content,
    sentBy:            'ai',
    agentType:         'system',
    status:            via === 'template' ? 'pending' : 'sent',
  });

  await db.updateConversationLastMessage(convId, content);
  await activateDivaForAutomatedMessage(convId, db);
  await db.updatePipelineState(convId, via === 'template' ? 'template_sent' : 'exploring');

  // 6. Marcar como enviado
  await db.markScheduledOrderSent(id);

  // 7. Notificar al CRM en tiempo real
  const updatedConv = await db.getConversationById(convId).catch(() => null);
  if (updatedConv && io) {
    io.to(`org_${orgId}`).emit(`new_message_${orgId}`, {
      message:      savedMessage,
      conversation: updatedConv,
    });
  }

  console.log(`[ScheduledFollowUp] ✅ Aviso de despacho enviado por ${via} a ${phone} — scheduled_order #${id}`);
}

/**
 * Revisa cada 15 minutos. La regla horaria usa America/Santiago y la base de
 * datos evita repetir pedidos ya procesados. Así también funciona correctamente
 * durante los cambios de horario de Chile.
 * @param {object} io - Socket.IO (opcional)
 */
function startScheduledFollowUpJob(io = null) {
  const CHECK_EVERY_MS = 15 * 60 * 1000;
  console.log('[ScheduledFollowUp] 🚀 Job iniciado — revisa cada 15 min y solo envía entre 09:00 y 20:59 (Chile)');

  setTimeout(() => runScheduledFollowUp(io), 2 * 60 * 1000);
  setInterval(() => runScheduledFollowUp(io), CHECK_EVERY_MS);
}

module.exports = { startScheduledFollowUpJob, runScheduledFollowUp };
