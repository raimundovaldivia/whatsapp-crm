/**
 * Shopify Webhook — Recibe eventos de Shopify en tiempo real
 *
 * Eventos que manejamos:
 *   orders/paid         → Pago recibido, convertir draft a orden real
 *   orders/create       → Orden creada (puede venir de draft completado)
 *   orders/cancelled    → Orden cancelada
 *   draft_orders/update → Estado de draft order actualizado
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db/database');
const whatsappService = require('../services/whatsapp');

let io;
function setSocketIO(socketIO) { io = socketIO; }

/**
 * Middleware — verifica la firma HMAC de Shopify
 * Shopify firma cada webhook con HMAC-SHA256 usando el webhook secret
 */
function verifyShopifyHmac(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const orgId      = req.params.orgId;

  if (!hmacHeader) {
    return res.status(401).json({ error: 'Sin firma HMAC' });
  }

  // Obtener el webhook secret de la org
  const ds = db.getPrimaryDataSource(parseInt(orgId));
  if (!ds) return res.status(404).json({ error: 'Org no encontrada' });

  const webhookSecret = ds.config?.webhookSecret;
  if (!webhookSecret) {
    // Si no hay secret configurado, aceptar igual (para testing)
    console.warn(`[Shopify WH] Org ${orgId} sin webhook secret — aceptando sin verificar`);
    return next();
  }

  const digest = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.rawBody || '', 'utf8')
    .digest('base64');

  if (digest !== hmacHeader) {
    console.warn(`[Shopify WH] HMAC inválido para org ${orgId}`);
    return res.status(401).json({ error: 'Firma inválida' });
  }

  next();
}

/**
 * POST /shopify-webhook/:orgId
 * URL que configuras en cada app de Shopify.
 * El :orgId identifica qué organización/tienda está enviando el evento.
 */
router.post('/:orgId', verifyShopifyHmac, async (req, res) => {
  // Responder 200 inmediatamente (Shopify reintenta si no recibe respuesta rápida)
  res.sendStatus(200);

  const topic  = req.headers['x-shopify-topic'];   // ej: 'orders/paid'
  const orgId  = parseInt(req.params.orgId);
  const data   = req.body;

  console.log(`[Shopify WH] [Org:${orgId}] Evento: ${topic}`);

  try {
    switch (topic) {
      case 'orders/paid':
        await handleOrderPaid(orgId, data);
        break;
      case 'orders/create':
        await handleOrderCreate(orgId, data);
        break;
      case 'orders/cancelled':
        await handleOrderCancelled(orgId, data);
        break;
      case 'orders/updated':
        await handleOrderUpdated(orgId, data);
        break;
      case 'draft_orders/update':
        await handleDraftOrderUpdate(orgId, data);
        break;
      default:
        console.log(`[Shopify WH] Evento no manejado: ${topic}`);
    }
  } catch (err) {
    console.error(`[Shopify WH] Error procesando ${topic}:`, err.message);
  }
});

// ─── HANDLERS ─────────────────────────────────────────────────────

/**
 * orders/paid — El cliente completó el pago
 * Este es el evento más importante. Actualiza el estado y confirma por WhatsApp.
 */
async function handleOrderPaid(orgId, shopifyOrder) {
  const draftOrderId  = shopifyOrder.source_identifier  // a veces viene aquí
    || extractDraftIdFromNote(shopifyOrder.note);

  // Buscar la orden en nuestra DB por draft_id o por order_id
  let localOrder = findLocalOrder(orgId, {
    shopifyOrderId:  String(shopifyOrder.id),
    shopifyDraftId:  draftOrderId,
    customerPhone:   cleanPhone(shopifyOrder.phone || shopifyOrder.billing_address?.phone),
  });

  if (!localOrder) {
    console.warn(`[Shopify WH] orders/paid: Orden de Shopify #${shopifyOrder.id} no encontrada en DB local`);
    return;
  }

  // Actualizar estado en DB
  db.updateOrder(localOrder.id, {
    status:           'paid',
    shopify_order_id: String(shopifyOrder.id),
  });

  // Actualizar pipeline state de la conversación
  db.updatePipelineState(localOrder.conversation_id, 'done');

  // Emitir al CRM en tiempo real
  io?.emit(`order_paid_${orgId}`, {
    orderId:          localOrder.id,
    shopifyOrderId:   String(shopifyOrder.id),
    conversationId:   localOrder.conversation_id,
    total:            shopifyOrder.total_price,
  });

  // Enviar confirmación al cliente por WhatsApp
  const conv = db.getConversationById(localOrder.conversation_id);
  const wc   = db.getWhatsappConfig(orgId);

  if (conv && wc) {
    const customerName = shopifyOrder.customer?.first_name || conv.contact_name || 'cliente';
    const orderNum     = shopifyOrder.order_number || shopifyOrder.id;
    const total        = shopifyOrder.total_price_set?.shop_money?.amount || shopifyOrder.total_price;
    const currency     = shopifyOrder.currency || 'MXN';

    const confirmMsg =
      `✅ ¡Pago recibido, ${customerName}!\n\n` +
      `📦 Pedido #${orderNum} confirmado\n` +
      `💵 Total: $${total} ${currency}\n\n` +
      `Te avisaremos cuando tu pedido esté en camino 🚚\n` +
      `¡Gracias por tu compra!`;

    await whatsappService.sendTextMessage(conv.phone_number, confirmMsg, wc);

    // Guardar el mensaje en la conversación
    db.saveMessage({
      conversationId: conv.id,
      direction:      'outbound',
      content:        confirmMsg,
      sentBy:         'ai',
      agentType:      'orders',
    });
    db.updateConversationLastMessage(conv.id, confirmMsg);
  }

  console.log(`[Shopify WH] ✅ Orden #${shopifyOrder.order_number} marcada como pagada`);
}

/**
 * orders/create — Shopify crea la orden real desde un draft
 */
async function handleOrderCreate(orgId, shopifyOrder) {
  // Intentar vincular con nuestra orden local
  const localOrder = findLocalOrder(orgId, {
    shopifyOrderId: String(shopifyOrder.id),
    customerPhone:  cleanPhone(shopifyOrder.phone || shopifyOrder.billing_address?.phone),
  });

  if (localOrder && !localOrder.shopify_order_id) {
    db.updateOrder(localOrder.id, { shopify_order_id: String(shopifyOrder.id) });
    io?.emit(`order_updated_${orgId}`, { orderId: localOrder.id, shopifyOrderId: String(shopifyOrder.id) });
  }
}

/**
 * orders/cancelled — Orden cancelada en Shopify
 */
async function handleOrderCancelled(orgId, shopifyOrder) {
  const localOrder = findLocalOrder(orgId, { shopifyOrderId: String(shopifyOrder.id) });
  if (localOrder) {
    db.updateOrder(localOrder.id, { status: 'cancelled' });
    io?.emit(`order_updated_${orgId}`, { orderId: localOrder.id, status: 'cancelled' });

    // Notificar al cliente si queremos
    const conv = db.getConversationById(localOrder.conversation_id);
    const wc   = db.getWhatsappConfig(orgId);
    if (conv && wc) {
      const msg = `Tu pedido #${shopifyOrder.order_number} ha sido cancelado. Si tienes alguna pregunta, con gusto te ayudamos 😊`;
      await whatsappService.sendTextMessage(conv.phone_number, msg, wc);
      db.saveMessage({ conversationId: conv.id, direction: 'outbound', content: msg, sentBy: 'ai', agentType: 'orders' });
    }
  }
}

/**
 * orders/updated — Actualización general de orden
 */
async function handleOrderUpdated(orgId, shopifyOrder) {
  const localOrder = findLocalOrder(orgId, { shopifyOrderId: String(shopifyOrder.id) });
  if (!localOrder) return;

  let newStatus = localOrder.status;
  if (shopifyOrder.financial_status === 'paid')      newStatus = 'paid';
  if (shopifyOrder.financial_status === 'refunded')  newStatus = 'cancelled';
  if (shopifyOrder.cancelled_at)                     newStatus = 'cancelled';

  if (newStatus !== localOrder.status) {
    db.updateOrder(localOrder.id, { status: newStatus });
    io?.emit(`order_updated_${orgId}`, { orderId: localOrder.id, status: newStatus });
  }
}

/**
 * draft_orders/update — Draft order actualizada
 */
async function handleDraftOrderUpdate(orgId, draftOrder) {
  if (draftOrder.status === 'completed') {
    // El draft se completó → convertir a pagado
    const localOrder = findLocalOrder(orgId, { shopifyDraftId: String(draftOrder.id) });
    if (localOrder) {
      db.updateOrder(localOrder.id, { status: 'paid', shopify_order_id: String(draftOrder.order_id || '') });
      io?.emit(`order_paid_${orgId}`, { orderId: localOrder.id });
    }
  }
}

// ─── UTILS ────────────────────────────────────────────────────────

function findLocalOrder(orgId, { shopifyOrderId, shopifyDraftId, customerPhone }) {
  const d = db.getDb();

  if (shopifyOrderId) {
    const o = d.prepare('SELECT * FROM orders WHERE organization_id = ? AND shopify_order_id = ?').get(orgId, shopifyOrderId);
    if (o) return o;
  }
  if (shopifyDraftId) {
    const o = d.prepare('SELECT * FROM orders WHERE organization_id = ? AND shopify_draft_id = ?').get(orgId, shopifyDraftId);
    if (o) return o;
  }
  if (customerPhone) {
    const o = d.prepare('SELECT * FROM orders WHERE organization_id = ? AND customer_phone = ? ORDER BY created_at DESC LIMIT 1').get(orgId, customerPhone);
    if (o) return o;
  }
  return null;
}

// Extraer draft ID de la nota de la orden (guardamos "Conv: X" en la nota)
function extractDraftIdFromNote(note) {
  if (!note) return null;
  const match = note.match(/Conv:\s*(\d+)/);
  return match ? match[1] : null;
}

function cleanPhone(phone) {
  if (!phone) return null;
  return phone.replace(/\D/g, '');
}

module.exports = router;
module.exports.setSocketIO = setSocketIO;
