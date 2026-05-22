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
const { getPool } = require('../db/database');
const whatsappService = require('../services/whatsapp');

let io;
function setSocketIO(socketIO) { io = socketIO; }

/**
 * Middleware — verifica la firma HMAC de Shopify
 * Shopify firma cada webhook con HMAC-SHA256 usando el webhook secret
 */
async function verifyShopifyHmac(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const orgId      = req.params.orgId;

  if (!hmacHeader) {
    return res.status(401).json({ error: 'Sin firma HMAC' });
  }

  // Obtener el webhook secret de la org
  const ds = await db.getPrimaryDataSource(parseInt(orgId));
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
 */
async function handleOrderPaid(orgId, shopifyOrder) {
  const draftOrderId  = shopifyOrder.source_identifier
    || extractDraftIdFromNote(shopifyOrder.note);

  let localOrder = await findLocalOrder(orgId, {
    shopifyOrderId:  String(shopifyOrder.id),
    shopifyDraftId:  draftOrderId,
    customerPhone:   cleanPhone(shopifyOrder.phone || shopifyOrder.billing_address?.phone),
  });

  if (!localOrder) {
    console.warn(`[Shopify WH] orders/paid: Orden de Shopify #${shopifyOrder.id} no encontrada en DB local`);
    return;
  }

  await db.updateOrder(localOrder.id, {
    status:           'paid',
    shopify_order_id: String(shopifyOrder.id),
  });

  await db.updatePipelineState(localOrder.conversation_id, 'done');

  io?.emit(`order_paid_${orgId}`, {
    orderId:          localOrder.id,
    shopifyOrderId:   String(shopifyOrder.id),
    conversationId:   localOrder.conversation_id,
    total:            shopifyOrder.total_price,
  });

  const conv = await db.getConversationById(localOrder.conversation_id);
  const wc   = await db.getWhatsappConfig(orgId);

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

    await db.saveMessage({
      conversationId: conv.id,
      direction:      'outbound',
      content:        confirmMsg,
      sentBy:         'ai',
      agentType:      'orders',
    });
    await db.updateConversationLastMessage(conv.id, confirmMsg);
  }

  console.log(`[Shopify WH] ✅ Orden #${shopifyOrder.order_number} marcada como pagada`);
}

/**
 * orders/create — Shopify crea la orden real desde un draft
 */
async function handleOrderCreate(orgId, shopifyOrder) {
  const localOrder = await findLocalOrder(orgId, {
    shopifyOrderId: String(shopifyOrder.id),
    customerPhone:  cleanPhone(shopifyOrder.phone || shopifyOrder.billing_address?.phone),
  });

  if (localOrder && !localOrder.shopify_order_id) {
    await db.updateOrder(localOrder.id, { shopify_order_id: String(shopifyOrder.id) });
    io?.emit(`order_updated_${orgId}`, { orderId: localOrder.id, shopifyOrderId: String(shopifyOrder.id) });
  }
}

/**
 * orders/cancelled — Orden cancelada en Shopify
 */
async function handleOrderCancelled(orgId, shopifyOrder) {
  const localOrder = await findLocalOrder(orgId, { shopifyOrderId: String(shopifyOrder.id) });
  if (localOrder) {
    await db.updateOrder(localOrder.id, { status: 'cancelled' });
    io?.emit(`order_updated_${orgId}`, { orderId: localOrder.id, status: 'cancelled' });

    const conv = await db.getConversationById(localOrder.conversation_id);
    const wc   = await db.getWhatsappConfig(orgId);
    if (conv && wc) {
      const msg = `Tu pedido #${shopifyOrder.order_number} ha sido cancelado. Si tienes alguna pregunta, con gusto te ayudamos 😊`;
      await whatsappService.sendTextMessage(conv.phone_number, msg, wc);
      await db.saveMessage({ conversationId: conv.id, direction: 'outbound', content: msg, sentBy: 'ai', agentType: 'orders' });
    }
  }
}

/**
 * orders/updated — Actualización general de orden
 */
async function handleOrderUpdated(orgId, shopifyOrder) {
  const localOrder = await findLocalOrder(orgId, { shopifyOrderId: String(shopifyOrder.id) });
  if (!localOrder) return;

  let newStatus = localOrder.status;
  if (shopifyOrder.financial_status === 'paid')      newStatus = 'paid';
  if (shopifyOrder.financial_status === 'refunded')  newStatus = 'cancelled';
  if (shopifyOrder.cancelled_at)                     newStatus = 'cancelled';

  if (newStatus !== localOrder.status) {
    await db.updateOrder(localOrder.id, { status: newStatus });
    io?.emit(`order_updated_${orgId}`, { orderId: localOrder.id, status: newStatus });
  }
}

/**
 * draft_orders/update — Draft order actualizada
 */
async function handleDraftOrderUpdate(orgId, draftOrder) {
  if (draftOrder.status === 'completed') {
    const localOrder = await findLocalOrder(orgId, { shopifyDraftId: String(draftOrder.id) });
    if (localOrder) {
      await db.updateOrder(localOrder.id, { status: 'paid', shopify_order_id: String(draftOrder.order_id || '') });
      io?.emit(`order_paid_${orgId}`, { orderId: localOrder.id });
    }
  }
}

// ─── UTILS ────────────────────────────────────────────────────────

async function findLocalOrder(orgId, { shopifyOrderId, shopifyDraftId, customerPhone } = {}) {
  const pool = getPool();

  if (shopifyOrderId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE organization_id = $1 AND shopify_order_id = $2',
      [orgId, shopifyOrderId]
    );
    if (rows[0]) return rows[0];
  }
  if (shopifyDraftId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE organization_id = $1 AND shopify_draft_id = $2',
      [orgId, shopifyDraftId]
    );
    if (rows[0]) return rows[0];
  }
  if (customerPhone) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE organization_id = $1 AND customer_phone = $2 ORDER BY created_at DESC LIMIT 1',
      [orgId, customerPhone]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

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
