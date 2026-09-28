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

  // ─── PASO B: Enviar template de despacho ────────────────────────────────
  if (!wc || wc.provider !== 'kapso') {
    console.warn(`[ScheduledFollowUp] Org ${orgId}: sin config Kapso — saltando envío de template #${id}`);
    await db.markScheduledOrderSent(id);
    return;
  }

  // 2. Determinar qué template usar
  const tplName = template_name
    || (await db.getSetting(orgId, 'scheduled_dispatch_template'))
    || (await db.getSetting(orgId, 'scheduled_order_template'));

  if (!tplName) {
    console.warn(`[ScheduledFollowUp] Org ${orgId}: sin template de despacho configurado — la orden se creó pero no se enviará mensaje. Configura 'scheduled_dispatch_template' en Ajustes.`);
    await db.markScheduledOrderSent(id);
    return;
  }

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

  // 4. Enviar template vía Kapso
  console.log(`[ScheduledFollowUp] Enviando template de despacho '${tplName}' a ${phone} (scheduled_order #${id})`);
  let sentResult;
  try {
    sentResult = await kapsoService.sendTemplate(phone, tplName, 'es', components, wc);
  } catch (sendErr) {
    // Si el template tiene menos parámetros, reintentar con solo el nombre
    const metaCode = sendErr.response?.data?.error?.code;
    if (metaCode === 132000) {
      console.warn(`[ScheduledFollowUp] Template con 1 parámetro — reintentando con solo nombre`);
      sentResult = await kapsoService.sendTemplate(phone, tplName, 'es', [{
        type: 'body',
        parameters: [{ type: 'text', text: name }],
      }], wc);
    } else {
      throw sendErr;
    }
  }

  // 5. Guardar mensaje en DB y actualizar pipeline_state → template_sent (warm lead)
  const content = `[Template: ${tplName}]\n\n📅 Despacho de pedido agendado: ${product}`;
  const savedMessage = await db.saveMessage({
    conversationId:    convId,
    whatsappMessageId: sentResult?.messages?.[0]?.id || null,
    direction:         'outbound',
    content,
    sentBy:            'ai',
    agentType:         'system',
    status:            'pending',
  });

  await db.updateConversationLastMessage(convId, content);
  await activateDivaForAutomatedMessage(convId, db);
  await db.updatePipelineState(convId, 'template_sent');  // el pipeline lo trata como warm lead

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

  console.log(`[ScheduledFollowUp] ✅ Template de despacho enviado a ${phone} — scheduled_order #${id}`);
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
