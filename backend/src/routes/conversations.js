const express = require('express');
const crypto = require('crypto');
const router = require('express').Router();
const db = require('../db/database');
const { getPool } = require('../db/database');
const whatsappService = require('../services/whatsapp');
const twilioService   = require('../services/twilio-whatsapp');
const kapsoService    = require('../services/kapso-whatsapp');
const whatsappProvider = require('../services/whatsapp-provider');
const outboundMedia = require('../services/outbound-media');
const paymentOptions = require('../services/payment-options');
const { notifyAdminHandoff } = require('../services/notifications');
const { notifyAdmin } = require('../services/admin-notify');
const pipelineOutbound = require('../services/pipeline-outbound');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getBodyComponent, getMissingBodyParameters, renderTemplateFromComponents } = require('../utils/template-renderer.mjs');
const followUp = require('../services/follow-up');
const { reconcilePendingMessages } = require('../services/message-status-recovery');
const { isTrackableDestination, extractTrackingTokens } = require('../services/lead-journey');
const { client: aiClient, modelFor, responseText } = require('../services/ai-provider');
const inboundPolicy = require('../services/inbound-message-policy');

let io;
function setSocketIO(socketIO) { io = socketIO; }

async function outboundConfig(orgId, conversation = null, requestedChannelId = null) {
  if (requestedChannelId === 'official' || requestedChannelId === 'legacy') {
    return db.getWhatsappConfig(orgId);
  }
  const channelId = requestedChannelId || conversation?.whatsapp_channel_id;
  const numericChannelId = Number(channelId);
  if (channelId && Number.isInteger(numericChannelId) && numericChannelId > 0) {
    const channel = await db.getWhatsappChannel(orgId, numericChannelId);
    if (channel) return channel;
  }
  const legacyConfig = await db.getWhatsappConfig(orgId);
  if (conversation && legacyConfig) return legacyConfig;
  const defaultChannel = await db.getDefaultWhatsappChannel(orgId);
  if (defaultChannel) return defaultChannel;
  return legacyConfig;
}

// Todas las rutas requieren auth
router.use(requireAuth);
const { mergeConversations } = require('../services/merge-conversations');

/**
 * GET /api/conversations
 */
router.get('/', async (req, res) => {
  try {
    const { unread } = req.query;
    res.json({ success: true, data: await db.getAllConversations(req.orgId, { unreadOnly: unread === 'true' }) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/:id/messages
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });
    let messages = await db.getMessagesByConversation(conv.id, parseInt(req.query.limit) || 50);
    const wc = await outboundConfig(req.orgId, conv);
    const recovered = await reconcilePendingMessages(req.orgId, messages, wc).catch(err => {
      console.warn(`[Conv] No se pudieron verificar estados pendientes del chat ${conv.id}:`, err.message);
      return [];
    });
    if (recovered.length) {
      messages = await db.getMessagesByConversation(conv.id, parseInt(req.query.limit) || 50);
      for (const message of recovered) {
        io?.to(`org_${req.orgId}`).emit(`status_update_${req.orgId}`, {
          messageId: message.whatsapp_message_id,
          status: message.status,
          error: message.delivery_error || null,
        });
      }
    }
    await db.markConversationAsRead(conv.id);
    res.json({ success: true, data: { conversation: conv, messages } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/conversations/:id/tracking-links — crea un enlace corto sin PII. */
router.post('/:id/tracking-links', async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const destinationUrl = String(req.body?.url || '').trim();
    const linkKind = ['product', 'catalog', 'checkout', 'payment', 'other'].includes(req.body?.kind)
      ? req.body.kind
      : 'other';
    if (!Number.isInteger(conversationId) || conversationId < 1) {
      return res.status(400).json({ success: false, error: 'Conversación inválida' });
    }
    if (!isTrackableDestination(destinationUrl)) {
      return res.status(400).json({ success: false, error: 'El enlace debe comenzar con http:// o https:// y no puede contener credenciales.' });
    }
    const publicUrl = String(process.env.CRM_PUBLIC_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL || '').replace(/\/$/, '');
    if (!publicUrl) return res.status(503).json({ success: false, error: 'Falta configurar CRM_PUBLIC_URL para crear enlaces rastreables.' });

    let saved = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      const token = crypto.randomBytes(9).toString('base64url');
      try {
        saved = await db.createConversationTrackingLink({
          organizationId: req.orgId,
          conversationId,
          token,
          destinationUrl,
          linkKind,
          createdBy: req.userId,
        });
      } catch (error) {
        if (error.code !== '23505') throw error;
      }
    }
    if (!saved) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    res.status(201).json({
      success: true,
      data: { id: saved.id, shortUrl: `${publicUrl}/r/${saved.token}`, destinationUrl: saved.destination_url, kind: saved.link_kind },
    });
  } catch (error) {
    console.error('[Conv] Error creando enlace rastreable:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo crear el enlace rastreable' });
  }
});

/** PATCH /api/conversations/:id/limbo-reason — confirmación humana del motivo. */
router.patch('/:id/limbo-reason', async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    const allowed = new Set(['price', 'delivery', 'payment', 'later', 'stock', 'declined', 'competitor', 'no_need', 'service', 'no_reply', 'unknown']);
    const reasonCode = String(req.body?.reason || '');
    const note = String(req.body?.note || '').trim();
    if (!Number.isInteger(conversationId) || conversationId < 1 || !allowed.has(reasonCode)) {
      return res.status(400).json({ success: false, error: 'Motivo inválido' });
    }
    if (note.length > 500) return res.status(400).json({ success: false, error: 'La nota no puede superar 500 caracteres' });
    const updated = await db.setConversationLimboReason(req.orgId, conversationId, reasonCode, note || null);
    if (!updated) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('[Conv] Error guardando motivo de limbo:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo guardar el motivo' });
  }
});

/** GET /api/conversations/:id/payment-options — vista previa sin enviar. */
router.get('/:id/payment-options', async (req, res) => {
  try {
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    const text = await paymentOptions.buildPaymentOptionsMessage(req.orgId);
    if (!text) return res.status(409).json({ success: false, error: 'Configura primero los métodos y datos de pago en Ajustes.' });
    res.json({ success: true, data: { text } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/conversations/:id/payment-options — envía la versión oficial configurada. */
router.post('/:id/payment-options', async (req, res) => {
  try {
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    const text = await paymentOptions.buildPaymentOptionsMessage(req.orgId);
    if (!text) return res.status(409).json({ success: false, error: 'Configura primero los métodos y datos de pago en Ajustes.' });
    const wc = await outboundConfig(req.orgId, conv);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    let sentResult;
    try {
      sentResult = await whatsappProvider.sendTextMessage(conv.phone_number, text, wc);
    } catch (sendErr) {
      if (sendErr.is24hWindow) {
        return res.status(409).json({
          success: false,
          error: 'WINDOW_EXPIRED',
          message: 'La ventana de 24 horas expiró. Usa un template aprobado para volver a contactar al cliente.',
        });
      }
      throw sendErr;
    }

    const message = await db.saveMessage({
      conversationId: conv.id,
      whatsappMessageId: whatsappProvider.messageId(sentResult),
      direction: 'outbound',
      content: text,
      sentBy: 'human',
      agentType: 'payment_options',
    });
    await db.updateConversationLastMessage(conv.id, text);
    await db.setAgentMode(conv.id, 'human');
    const updated = await db.getConversationById(conv.id, req.orgId);
    io?.to(`org_${req.orgId}`).emit(`agent_mode_changed_${req.orgId}`, { conversationId: conv.id, mode: 'human' });
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message, conversation: updated });
    res.json({ success: true, data: message });
  } catch (err) {
    console.error('[Conv] Error enviando opciones de pago:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/messages — Mensaje manual
 */
router.post('/:id/messages', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, error: 'Texto vacío' });

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    const wc = await outboundConfig(req.orgId, conv);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    // Enviar por el proveedor correcto según configuración
    let sentResult;
    try {
      sentResult = await whatsappProvider.sendTextMessage(conv.phone_number, text.trim(), wc);
    } catch (sendErr) {
      if (sendErr.is24hWindow) {
        return res.status(400).json({
          success: false,
          error: 'WINDOW_EXPIRED',
          message: 'La ventana de 24 horas expiró. El cliente debe escribirte primero para que puedas responder.',
        });
      }
      throw sendErr;
    }

    const message = await db.saveMessage({
      conversationId: conv.id,
      whatsappMessageId: whatsappProvider.messageId(sentResult),
      direction: 'outbound',
      content: text.trim(),
      sentBy: 'human',
    });
    if (message?.id) {
      await db.attachConversationTrackingLinksToMessage(req.orgId, conv.id, message.id, extractTrackingTokens(text.trim()));
    }

    await db.updateConversationLastMessage(conv.id, text.trim());
    // Una respuesta escrita desde el CRM significa que una persona tomó el hilo.
    await db.setAgentMode(conv.id, 'human');
    io?.to(`org_${req.orgId}`).emit(`agent_mode_changed_${req.orgId}`, { conversationId: conv.id, mode: 'human' });
    const updated = await db.getConversationById(conv.id);
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message, conversation: updated });

    res.json({ success: true, data: message });
  } catch (err) {
    console.error('[Conv] Error enviando:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/conversations/:id/media — foto o documento desde el CRM. */
router.post('/:id/media', async (req, res) => {
  try {
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    const wc = await whatsappProvider.configForConversation(req.orgId, conv);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });
    let sent;
    try {
      sent = await outboundMedia.send({ orgId: req.orgId, conversation: conv, payload: req.body, config: wc });
    } catch (sendErr) {
      if (sendErr.is24hWindow) {
        return res.status(409).json({
          success: false,
          error: 'WINDOW_EXPIRED',
          message: 'La ventana de 24 horas expiró. El cliente debe escribir primero para recibir archivos.',
        });
      }
      throw sendErr;
    }
    await db.setAgentMode(conv.id, 'human');
    const updated = await db.getConversationById(conv.id, req.orgId);
    io?.to(`org_${req.orgId}`).emit(`agent_mode_changed_${req.orgId}`, { conversationId: conv.id, mode: 'human' });
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message: sent.message, conversation: updated });
    res.json({ success: true, data: sent.message });
  } catch (err) {
    console.error('[Conv] Error enviando archivo:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.code || err.message, message: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/agent-mode
 */
router.patch('/:id/agent-mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['ai', 'coordinating', 'human'].includes(mode)) return res.status(400).json({ success: false, error: 'mode inválido' });

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    await db.setAgentMode(conv.id, mode);
    io?.to(`org_${req.orgId}`).emit(`agent_mode_changed_${req.orgId}`, { conversationId: conv.id, mode });

    // Notificar al admin si se cambia a modo humano manualmente desde el CRM
    if (mode === 'human') {
      notifyAdminHandoff(req.orgId, conv, 'Cambio manual desde el CRM');
    }

    res.json({ success: true, data: await db.getConversationById(conv.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/read
 */
router.patch('/:id/read', async (req, res) => {
  try {
    if (!await db.getConversationById(Number(req.params.id), req.orgId)) return res.status(404).json({ error: 'Conversación no encontrada' });
    await db.markConversationAsRead(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/pin
 * Mantiene una conversación destacada al comienzo de la lista.
 */
router.patch('/:id/pin', async (req, res) => {
  try {
    if (typeof req.body?.pinned !== 'boolean') {
      return res.status(400).json({ success: false, error: 'pinned debe ser verdadero o falso' });
    }
    const updated = await db.setConversationPinned(Number(req.params.id), req.orgId, req.body.pinned);
    if (!updated) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/customer-note
 * Nota interna persistente, compartida por los canales del mismo cliente.
 */
router.patch('/:id/customer-note', async (req, res) => {
  try {
    if (typeof req.body?.note !== 'string') {
      return res.status(400).json({ success: false, error: 'La nota debe ser texto' });
    }
    if (req.body.note.trim().length > 1000) {
      return res.status(400).json({ success: false, error: 'La nota no puede superar 1000 caracteres' });
    }
    const conv = await db.getConversationById(Number(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    const note = await db.setCustomerNote(req.orgId, conv.phone_number, req.body.note);
    res.json({ success: true, note, data: await db.getConversationById(conv.id, req.orgId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/start
 * Inicia o reutiliza una conversación con un número y envía el primer mensaje.
 * Body: { phone: "56912345678", name?: "Juan", text: "Hola..." }
 */
router.post('/start', async (req, res) => {
  try {
    const { phone, name, text, channelId } = req.body;
    if (!phone?.trim()) return res.status(400).json({ success: false, error: 'Número de teléfono requerido' });
    if (!text?.trim())  return res.status(400).json({ success: false, error: 'Mensaje requerido' });

    // Normalizar el teléfono: con código de país, sin +
    const phoneNorm = db.normalizePhone(phone.trim());

    const wc = await outboundConfig(req.orgId, null, channelId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    const selectedChannelId = wc.provider === 'evolution' ? wc.id : null;
    const existingConversation = await db.upsertConversation(req.orgId, phoneNorm, name?.trim() || null, selectedChannelId);
    const convId = existingConversation.id;

    // Enviar por el proveedor correcto
    let sentResult;
    sentResult = await whatsappProvider.sendTextMessage(phoneNorm, text.trim(), wc);

    const message = await db.saveMessage({
      conversationId: convId,
      whatsappMessageId: whatsappProvider.messageId(sentResult),
      direction: 'outbound',
      content: text.trim(),
      sentBy: 'human',
    });

    await db.updateConversationLastMessage(convId, text.trim());
    const conv = await db.getConversationById(convId);
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message, conversation: conv });

    res.json({ success: true, data: { conversationId: convId, message, conversation: conv } });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Conv/start] Error:', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

/**
 * PATCH /api/conversations/:id/pipeline-state
 * Permite cambiar manualmente el pipeline_state (ej: sacar a un cliente de hot lead)
 */
router.patch('/:id/pipeline-state', async (req, res) => {
  try {
    if (!await db.getConversationById(Number(req.params.id), req.orgId)) return res.status(404).json({ error: 'Conversación no encontrada' });
    const { state, excludeHotLead } = req.body;
    const VALID = ['exploring', 'interested', 'collecting_order', 'awaiting_payment', 'done'];
    if (!VALID.includes(state)) {
      return res.status(400).json({ success: false, error: `Estado inválido. Válidos: ${VALID.join(', ')}` });
    }
    await db.updatePipelineState(parseInt(req.params.id), state);
    // Si se excluye de hot leads, marcar la bandera para que el scan no la vuelva a añadir
    if (excludeHotLead) {
      await getPool().query(
        'UPDATE conversations SET hot_lead_excluded = TRUE, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
        [parseInt(req.params.id), req.orgId]
      );
    }
    res.json({ success: true, state, excludeHotLead: !!excludeHotLead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/:id/hot-lead-exclusion', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId < 1 || typeof req.body?.excluded !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Solicitud de exclusión inválida' });
    }
    const { rows } = await getPool().query(
      `UPDATE conversations
          SET hot_lead_excluded = $1, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3
        RETURNING id, hot_lead_excluded`,
      [req.body.excluded, conversationId, req.orgId]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    res.json({ success: true, excluded: rows[0].hot_lead_excluded });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/client-type
 * Marcar manualmente un contacto como "empresa" o "personal"
 */
router.patch('/:id/client-type', async (req, res) => {
  try {
    const { clientType } = req.body;
    if (!['personal', 'empresa'].includes(clientType)) {
      return res.status(400).json({ success: false, error: 'clientType debe ser "personal" o "empresa"' });
    }
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    const contact = await db.updateContactClientType(req.orgId, conv.phone_number, clientType);
    res.json({ success: true, clientType, contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/:id/orders
 */
router.get('/:id/orders', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM orders WHERE conversation_id = $1 AND organization_id = $2 ORDER BY created_at DESC',
      [parseInt(req.params.id), req.orgId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/orders
 * Crear una orden manual desde el panel admin.
 * Body: { items: [{productId, title, price, quantity}], sendSummary: boolean }
 */
const campaignOffers = require('../services/campaign-offers');
const campaignOffersStore = require('../services/campaign-offers-store');

router.post('/:id/orders', async (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    const conv   = await db.getConversationById(convId, req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const { items: rawItems = [], offerId = null, sendSummary = true, shippingAddress = {}, discount = 0, discountType = 'percent', note = '' } = req.body;
    if (!rawItems.length) return res.status(400).json({ success: false, error: 'Agrega al menos un producto' });
    if (typeof note !== 'string' || note.trim().length > 1000) {
      return res.status(400).json({ success: false, error: 'La nota del pedido no puede superar 1000 caracteres' });
    }

    // Oferta de campaña: sólo la última enviada, vigente, y referenciada por el pedido.
    const campaignRows = await campaignOffersStore.activeForConversation(db.getPool(), req.orgId, convId).catch(() => []);
    const requestedOfferIds = new Set((Array.isArray(req.body.offerIds) ? req.body.offerIds : (offerId != null ? [offerId] : [])).map(Number));
    const offersToRedeem = campaignRows.filter(o => o.status === 'sent' && !campaignOffers.isExpiredOffer(o) && requestedOfferIds.has(Number(o.id)));
    const normalizedItems = rawItems.map(i => ({ ...i, product_id: i.product_id ?? i.productId ?? i.id }));
    let items = normalizedItems;
    for (const offer of offersToRedeem) items = campaignOffers.applyOfferToItems(items, offer, null).items;
    const subtotal      = items.reduce((s, i) => s + (parseFloat(i.price) * parseInt(i.quantity || 1)), 0);
    const discountNum   = parseFloat(discount) || 0;
    const discountAmount = discountNum > 0
      ? (discountType === 'percent' ? subtotal * (discountNum / 100) : Math.min(discountNum, subtotal))
      : 0;
    const totalPrice    = Math.max(0, subtotal - discountAmount);

    // Resolver nombre y dirección desde contacts (fuente de verdad)
    let customerName = conv.contact_name;
    const rawPhone = conv.phone_number;
    const contact = await db.getContact(req.orgId, rawPhone);

    if (!customerName || customerName === rawPhone || /^\d+$/.test(customerName) || customerName === 'Cliente') {
      if (contact?.name && contact.name !== rawPhone && !/^\d+$/.test(contact.name)) {
        customerName = contact.name;
      }
    }
    customerName = customerName || rawPhone;

    // Dirección: usar la del modal; si está vacía, usar la del contacto como fallback
    let finalAddress = shippingAddress;
    const addrEmpty = !shippingAddress?.address && !shippingAddress?.address1;
    if (addrEmpty && contact?.address) {
      finalAddress = { address: contact.address, city: contact.city || '' };
    }

    const order = await db.createOrder({
      conversationId: convId,
      organizationId: req.orgId,
      items,
      customerName,
      customerPhone:   conv.phone_number,
      shippingAddress: finalAddress,
      totalPrice,
      note: note.trim() || null,
    });
    for (const offer of offersToRedeem) {
      await campaignOffersStore.redeem(db.getPool(), req.orgId, offer.id, order.id)
        .catch(error => console.warn('[Campaign offers] no se pudo canjear la oferta:', error.message));
    }

    // Guardar mensaje de resumen en el chat y enviarlo al cliente
    if (sendSummary) {
      const lines = items.map(i => `• ${i.title} x${i.quantity || 1} — $${(parseFloat(i.price) * parseInt(i.quantity || 1)).toLocaleString('es-CL')}`);
      const discountLine = discountAmount > 0
        ? `\n_Descuento (${discountType === 'percent' ? `${discountNum}%` : `$${Math.round(discountAmount).toLocaleString('es-CL')}`}): -$${Math.round(discountAmount).toLocaleString('es-CL')}_`
        : '';
      const subtotalLine = discountAmount > 0
        ? `\nSubtotal: $${subtotal.toLocaleString('es-CL')}` : '';
      const summary = `🛒 *Pedido #DR-${order.id} generado*\n\n${lines.join('\n')}${subtotalLine}${discountLine}\n\n*Total: $${totalPrice.toLocaleString('es-CL')}*\n\nTe contactaremos para coordinar la entrega y el pago.`;

      const wc = await db.getWhatsappConfig(req.orgId);
      if (wc) {
        try {
          const provider = wc.provider || 'kapso';
          if (provider === 'kapso') {
            await require('../services/kapso-whatsapp').sendTextMessage(conv.phone_number, summary, wc);
          } else if (provider === 'twilio') {
            await require('../services/twilio-whatsapp').sendTextMessage(conv.phone_number, summary, wc);
          } else {
            await require('../services/whatsapp').sendTextMessage(conv.phone_number, summary, wc);
          }
        } catch (_) { /* no bloquear si el WA falla */ }
      }
      const savedMsg = await db.saveMessage({
        conversationId:    convId,
        whatsappMessageId: `order_${order.id}_${Date.now()}`,
        content:           summary,
        direction:         'outbound',
        type:              'text',
        sentBy:            'human',
      });
      await db.updateConversationLastMessage(convId, summary);
      const updatedConv = await db.getConversationById(convId);
      const io = req.app.get('io');
      io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message: savedMsg, conversation: updatedConv });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('[Conversations/createOrder]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/escalation-feedback
 * Guarda si la escalación fue correcta o innecesaria
 * Body: { feedback: 'correct' | 'unnecessary' }
 */
router.post('/:id/escalation-feedback', async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!['correct', 'unnecessary'].includes(feedback)) {
      return res.status(400).json({ success: false, error: 'feedback debe ser correct o unnecessary' });
    }

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    // Guardar feedback
    await db.saveEscalationFeedback(
      req.orgId,
      conv.id,
      conv.last_escalation_trigger || '',
      conv.last_escalation_reason  || '',
      feedback
    );

    // Limpiar el contexto de escalación para no mostrar los botones de nuevo
    await db.clearLastEscalation(conv.id);

    // Contar cuántos negativos hay para loggear
    const negCount = feedback === 'unnecessary' ? 1 : 0;
    if (negCount > 0) {
      console.log(`[Feedback] ❌ Escalación innecesaria registrada para conv ${conv.id}: "${conv.last_escalation_trigger?.slice(0,50)}"`);
    } else {
      console.log(`[Feedback] ✅ Escalación correcta confirmada para conv ${conv.id}`);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/send-template
 * Envía un template de WhatsApp a una conversación específica.
 * Útil cuando la ventana de 24h ha expirado.
 * Body: { templateName, languageCode?, components? }
 *   components ejemplo: [{ type: 'body', parameters: [{ type: 'text', text: 'Juan' }] }]
 */
router.post('/:id/send-template', async (req, res) => {
  try {
    const { templateName, languageCode, components } = req.body;
    if (!templateName?.trim()) {
      return res.status(400).json({ success: false, error: 'templateName requerido' });
    }

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });
    if (conv.whatsapp_channel_id) {
      return res.status(400).json({ success: false, error: 'Los templates pertenecen al número oficial. Abre la conversación Kapso/Meta de este cliente para enviarlo.' });
    }

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
      return res.status(400).json({ success: false, error: 'Templates solo disponibles con Kapso o Meta' });
    }

    const kapsoService = require('../services/kapso-whatsapp');
    const templates = await kapsoService.getTemplates(wc);
    const template = templates.find(item => item.name === templateName.trim());
    if (!template) return res.status(400).json({ success: false, error: `Template ${templateName.trim()} no encontrado` });
    const body = getBodyComponent(template)?.text || '';
    const missing = getMissingBodyParameters(body, components || []);
    if (missing.length) return res.status(400).json({ success: false, error: `Faltan valores para ${missing.map(number => `{{${number}}}`).join(', ')}` });
    const rendered = renderTemplateFromComponents(body, components || []);
    const sentResult = await kapsoService.sendTemplate(
      conv.phone_number,
      templateName.trim(),
      languageCode || 'es',
      components || [],
      wc
    );

    const savedContent = rendered
      ? `[Template: ${templateName.trim()}]\n\n${rendered}`
      : `[Template: ${templateName.trim()}]`;

    const message = await db.saveMessage({
      conversationId:    conv.id,
      whatsappMessageId: sentResult?.messages?.[0]?.id || null,
      direction:         'outbound',
      content:           savedContent,
      sentBy:            'human',
      agentType:         null,
    });

    await db.updateConversationLastMessage(conv.id, savedContent);
    const updated = await db.getConversationById(conv.id);
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message, conversation: updated });

    res.json({ success: true, data: message });
  } catch (err) {
    console.error('[Conv/send-template] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/conversations/:id/messages
 * Borra todos los mensajes de una conversación y resetea su estado.
 * Solo disponible para raivaldiviabou@gmail.com (uso en testing).
 */
router.delete('/:id/messages', async (req, res) => {
  try {
    // Verificar que el usuario es el dev autorizado
    const user = await db.getUserById(req.userId);
    if (!user || user.email !== 'raivaldiviabou@gmail.com') {
      return res.status(403).json({ success: false, error: 'No autorizado' });
    }

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const pool = getPool();

    // Borrar todos los mensajes
    const { rowCount } = await pool.query(
      'DELETE FROM messages WHERE conversation_id = $1',
      [conv.id]
    );

    // Resetear estado de la conversación
    await pool.query(
      `UPDATE conversations SET
        pipeline_state         = 'exploring',
        order_draft            = '{}',
        agent_mode             = 'ai',
        last_message           = NULL,
        last_message_at        = CURRENT_TIMESTAMP,
        unread_count           = 0,
        last_escalation_trigger = NULL,
        last_escalation_reason  = NULL,
        last_escalation_at      = NULL,
        updated_at             = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [conv.id]
    );

    console.log(`[DevTool] 🗑️  ${rowCount} mensajes borrados en conv ${conv.id} por ${user.email}`);

    const freshConv = await db.getConversationById(conv.id);
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message: null, conversation: freshConv });

    res.json({ success: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/merge-duplicates
 * Encuentra conversaciones duplicadas (mismo teléfono con/sin '+') y las fusiona.
 * Mantiene la que tiene más mensajes y borra la otra.
 */
router.post('/merge-duplicates', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  const pool = getPool();
  try {
    let merged = 0;

    // ── Paso 1: Pares exactos con/sin '+' ────────────────────────────────
    // Busca conversaciones donde existe UNA con phone='56...' y OTRA con phone='+56...'
    // Mantiene la sin '+' (la del webhook), mueve mensajes, borra la con '+'.
    const pairs = await pool.query(
      `SELECT c_keep.id AS keep_id, c_dupe.id AS dupe_id,
              c_dupe.contact_name AS dupe_name, c_keep.contact_name AS keep_name
       FROM conversations c_keep
       JOIN conversations c_dupe
         ON c_dupe.organization_id = c_keep.organization_id
        AND c_dupe.whatsapp_channel_id IS NOT DISTINCT FROM c_keep.whatsapp_channel_id
        AND c_dupe.phone_number = '+' || c_keep.phone_number
       WHERE c_keep.organization_id = $1
         AND c_keep.phone_number NOT LIKE '+%'`,
      [req.orgId]
    );

    for (const row of pairs.rows) {
      await mergeConversations(req.orgId, row.keep_id, row.dupe_id);
      merged++;
    }

    // ── Paso 2: Pares sin código de país (9XXXXXXXX vs 569XXXXXXXX) ─────────
    // Busca conversaciones donde phone='9XXXXXXXX' y existe otra con phone='569XXXXXXXX'
    // Mantiene la que tiene más mensajes.
    const pairsNoCC = await pool.query(
      `SELECT
         c_long.id  AS keep_id,  c_long.contact_name  AS keep_name,
         c_short.id AS dupe_id,  c_short.contact_name AS dupe_name
       FROM conversations c_long
       JOIN conversations c_short
         ON c_short.organization_id = c_long.organization_id
        AND c_short.whatsapp_channel_id IS NOT DISTINCT FROM c_long.whatsapp_channel_id
        AND c_long.phone_number = '56' || c_short.phone_number
       WHERE c_long.organization_id = $1
         AND c_short.phone_number ~ '^9[0-9]{8}$'`,
      [req.orgId]
    );

    for (const row of pairsNoCC.rows) {
      await mergeConversations(req.orgId, row.keep_id, row.dupe_id);
      merged++;
    }

    // ── Paso 3: 9XXXXXXXX vs +569XXXXXXXX ───────────────────────────────────
    // El caso que faltaba: número sin código de país vs con + y código de país
    const pairsShortVsPlusFull = await pool.query(
      `SELECT
         c_long.id  AS keep_id,  c_long.contact_name  AS keep_name,
         c_short.id AS dupe_id,  c_short.contact_name AS dupe_name
       FROM conversations c_long
       JOIN conversations c_short
         ON c_short.organization_id = c_long.organization_id
        AND c_short.whatsapp_channel_id IS NOT DISTINCT FROM c_long.whatsapp_channel_id
        AND c_long.phone_number = '56' || c_short.phone_number
       WHERE c_long.organization_id = $1
         AND c_short.phone_number ~ '^9[0-9]{8}$'
         AND c_long.phone_number ~ '^569[0-9]{8}$'`,
      [req.orgId]
    );

    // También buscar: 9XXXXXXXX vs +56XXXXXXXXX
    const pairsShortVsPlusFullInv = await pool.query(
      `SELECT
         c_full.id  AS keep_id,  c_full.contact_name  AS keep_name,
         c_short.id AS dupe_id,  c_short.contact_name AS dupe_name
       FROM conversations c_full
       JOIN conversations c_short
         ON c_short.organization_id = c_full.organization_id
        AND c_short.whatsapp_channel_id IS NOT DISTINCT FROM c_full.whatsapp_channel_id
        AND c_full.phone_number = '+56' || c_short.phone_number
       WHERE c_full.organization_id = $1
         AND c_short.phone_number ~ '^9[0-9]{8}$'`,
      [req.orgId]
    );

    for (const row of [...pairsShortVsPlusFull.rows, ...pairsShortVsPlusFullInv.rows]) {
      await mergeConversations(req.orgId, row.keep_id, row.dupe_id);
      merged++;
    }

    // ── Paso 4: Normalizar phones en contacts (sin constraint issue) ──────
    // En contacts la clave es (organization_id, phone) — puede haber pares +/sin +
    // Borramos el '+' solo si NO existe ya uno sin '+' para esa org
    await pool.query(
      `DELETE FROM contacts
       WHERE organization_id = $1 AND phone LIKE '+%'
         AND EXISTS (
           SELECT 1 FROM contacts c2
           WHERE c2.organization_id = $1
             AND c2.phone = SUBSTRING(contacts.phone FROM 2)
         )`,
      [req.orgId]
    );
    // Los que quedan con '+' y no tienen duplicado: actualizarlos
    await pool.query(
      `UPDATE contacts SET phone = SUBSTRING(phone FROM 2), updated_at = NOW()
       WHERE organization_id = $1 AND phone LIKE '+%'`,
      [req.orgId]
    );

    // ── Paso 5: Normalizar conversations.phone_number a formato canónico ────
    // Conversaciones con phone 9XXXXXXXX (sin 56) que no tienen par → actualizar a 569XXXXXXXX
    await pool.query(
      `UPDATE conversations SET phone_number = '56' || phone_number, updated_at = NOW()
       WHERE organization_id = $1
         AND phone_number ~ '^9[0-9]{8}$'
         AND NOT EXISTS (
           SELECT 1 FROM conversations c2
           WHERE c2.organization_id = $1
             AND c2.whatsapp_channel_id IS NOT DISTINCT FROM conversations.whatsapp_channel_id
             AND c2.phone_number = '56' || conversations.phone_number
         )`,
      [req.orgId]
    );
    // Conversaciones con phone +56XXXXXXXXX → quitar el +
    await pool.query(
      `UPDATE conversations SET phone_number = SUBSTRING(phone_number FROM 2), updated_at = NOW()
       WHERE organization_id = $1
         AND phone_number LIKE '+%'
         AND NOT EXISTS (
           SELECT 1 FROM conversations c2
           WHERE c2.organization_id = $1
             AND c2.whatsapp_channel_id IS NOT DISTINCT FROM conversations.whatsapp_channel_id
             AND c2.phone_number = SUBSTRING(conversations.phone_number FROM 2)
         )`,
      [req.orgId]
    );

    res.json({ success: true, mergedConversations: merged });
  } catch (err) {
    console.error('[merge-duplicates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/search-messages?q=xxx
 * Busca en el contenido de los mensajes de todas las conversaciones de la organización.
 * Devuelve hasta 25 conversaciones con el mensaje más reciente que coincide.
 */
router.get('/search-messages', async (req, res) => {
  const pool = getPool();
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [] });

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (m.conversation_id)
        c.id, c.contact_name, c.phone_number, c.agent_mode, c.pipeline_state,
        c.unread_count, c.last_message_at,
        m.content  AS matched_content,
        m.direction,
        m.created_at AS matched_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.organization_id = $1
        AND m.content ILIKE $2
      ORDER BY m.conversation_id, m.created_at DESC
      LIMIT 25
    `, [req.orgId, `%${q}%`]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[Conversations/searchMessages]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/search-by-phone?phone=xxx
 * Busca TODAS las conversaciones de un número en cualquier formato (56xxx, +56xxx, xxx sin prefijo).
 * Útil para diagnosticar chats perdidos y encontrar duplicados.
 */
router.get('/search-by-phone', async (req, res) => {
  const pool = getPool();
  try {
    const rawPhone = (req.query.phone || '').replace(/\s/g, '').replace(/^\+/, '');
    if (!rawPhone) return res.status(400).json({ success: false, error: 'Falta parámetro phone' });

    // Construir todas las variantes del número (normalizar primero a canónico 56XXXXXXXXX)
    let canonical = rawPhone;
    if (/^9\d{8}$/.test(canonical)) canonical = '56' + canonical;

    const variants = new Set([rawPhone]);
    if (/^569\d{8}$/.test(canonical)) {
      variants.add(canonical);              // 56991623745
      variants.add(canonical.slice(2));     // 991623745
      variants.add('+' + canonical);        // +56991623745
      variants.add('+' + canonical.slice(2)); // +991623745
    } else {
      variants.add('+' + rawPhone);
    }

    const placeholders = [...variants].map((_, i) => `$${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `SELECT c.id, c.phone_number, c.contact_name, c.pipeline_state, c.agent_mode,
              c.last_message_at, c.hot_lead_excluded, c.whatsapp_channel_id,
              wc.assigned_user_id AS whatsapp_channel_assigned_user_id,
              assigned_user.name AS whatsapp_channel_assignee,
              COALESCE(wc.name,
                CASE WHEN cfg.provider = 'kapso' THEN 'WhatsApp Oficial (Kapso)' ELSE 'WhatsApp Oficial' END
              ) AS whatsapp_channel_name,
              COALESCE(wc.phone_number, cfg.display_phone_number, cfg.twilio_phone_number) AS whatsapp_channel_phone,
              COALESCE(wc.provider, cfg.provider, 'meta') AS whatsapp_provider,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS first_message_at
       FROM conversations c
       LEFT JOIN whatsapp_channels wc ON wc.id = c.whatsapp_channel_id
       LEFT JOIN users assigned_user
         ON assigned_user.id = wc.assigned_user_id
        AND assigned_user.organization_id = c.organization_id
       LEFT JOIN whatsapp_configs cfg ON cfg.organization_id = c.organization_id
       WHERE c.organization_id = $1
         AND c.phone_number IN (${placeholders})
       ORDER BY c.last_message_at DESC`,
      [req.orgId, ...[...variants]]
    );

    res.json({ success: true, phone: rawPhone, variants: [...variants], conversations: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/merge-into/:targetId
 * Fusiona UNA conversación específica (sourceId del body) dentro de targetId.
 * Mueve los mensajes y borra la conversación fuente.
 */
router.post('/merge-into/:targetId', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const targetId = Number(req.params.targetId), sourceId = Number(req.body.sourceId);
    await mergeConversations(req.orgId, targetId, sourceId);
    res.json({ success: true, mergedInto: targetId, deleted: sourceId });
  } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
});

/**
 * POST /api/conversations/trigger-follow-up
 * Dispara el follow-up bot ahora mismo para conversaciones abandonadas de esta org.
 * El cron corre automáticamente cada 30min pero este endpoint lo activa a demanda.
 */
router.post('/trigger-follow-up', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const result = await followUp.runFollowUp(io, new Date(), {
      organizationId: req.orgId,
      minIdleHours: 2,
      maxIdleHours: 22,
    });
    if (result.reason === 'outside_customer_hours') {
      return res.status(409).json({
        success: false,
        error: 'OUTSIDE_CUSTOMER_HOURS',
        message: 'Los seguimientos automáticos solo se envían entre las 09:00 y las 20:59, hora de Chile.',
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[trigger-follow-up]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/scan-hot-leads
 * Guarda el estado vigente y una propuesta explicable sin modificar ninguna
 * conversación. La aplicación queda en un paso separado y auditable.
 */
router.post('/scan-hot-leads', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  const pool = getPool();
  const runId = crypto.randomUUID();
  try {
    const requestedLimit = req.body?.limit === undefined ? 200 : Number(req.body.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
      return res.status(400).json({ success: false, error: 'limit debe ser un entero entre 1 y 500' });
    }
    await pool.query(
      `INSERT INTO lead_qualification_runs
        (run_id, organization_id, created_by, requested_limit)
       VALUES ($1, $2, $3, $4)`,
      [runId, req.orgId, req.userId || null, requestedLimit]
    );
    const { rows: convs } = await pool.query(
      `SELECT c.id
       FROM conversations c
       WHERE c.organization_id = $1
         AND c.last_message_at > NOW() - INTERVAL '30 days'
       ORDER BY c.last_message_at DESC
       LIMIT $2`,
      [req.orgId, requestedLimit]
    );

    const summary = {
      legacyHot: 0,
      exploring: 0, interested: 0, hot: 0, very_hot: 0,
      future: 0, won: 0, discarded: 0,
    };
    for (const conv of convs) {
      const calculated = await db.calculateLeadQualification(conv.id, req.orgId);
      if (!calculated) continue;
      const { conversation: before, qualification: proposed } = calculated;
      const legacyHot = ['interested', 'collecting_order'].includes(before.pipeline_state)
        && !before.hot_lead_excluded;
      if (legacyHot) summary.legacyHot++;
      summary[proposed.temperature] = (summary[proposed.temperature] || 0) + 1;
      await pool.query(
        `INSERT INTO lead_qualification_audits
          (run_id, organization_id, conversation_id,
           before_pipeline_state, before_lead_temperature, before_lead_score,
           before_hot_excluded, before_legacy_hot, before_qualification_reasons,
           before_lead_signals, before_updated_at,
           proposed_temperature, proposed_score, proposed_reasons, proposed_signals)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          runId, req.orgId, before.id,
          before.pipeline_state || null, before.lead_temperature || null, Number(before.lead_score || 0),
          Boolean(before.hot_lead_excluded), legacyHot,
          JSON.stringify(before.qualification_reasons || []), JSON.stringify(before.lead_signals || {}),
          before.updated_at || null,
          proposed.temperature, proposed.score, JSON.stringify(proposed.reasons),
          JSON.stringify({ ...proposed.signals, veryHotGate: proposed.veryHotGate }),
        ]
      );
    }

    await pool.query(
      `UPDATE lead_qualification_runs
          SET conversation_count = $1, status = 'completed', summary = $2,
              completed_at = NOW()
        WHERE run_id = $3 AND organization_id = $4`,
      [convs.length, JSON.stringify(summary), runId, req.orgId]
    );

    res.json({
      success: true,
      runId,
      applied: false,
      scanned: convs.length,
      hotLeadsFound: summary.hot + summary.very_hot,
      veryHotLeadsFound: summary.very_hot,
      summary,
    });
  } catch (err) {
    await pool.query(
      `UPDATE lead_qualification_runs
          SET status = 'failed', completed_at = NOW()
        WHERE run_id = $1 AND organization_id = $2`,
      [runId, req.orgId]
    ).catch(() => {});
    console.error('[scan-hot-leads]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/lead-qualification-runs/:runId', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: runs } = await pool.query(
      `SELECT * FROM lead_qualification_runs
        WHERE run_id = $1 AND organization_id = $2`,
      [req.params.runId, req.orgId]
    );
    if (!runs[0]) return res.status(404).json({ success: false, error: 'Evaluación no encontrada' });
    const { rows: conversations } = await pool.query(
      `SELECT a.*, c.contact_name, c.phone_number
         FROM lead_qualification_audits a
         JOIN conversations c
           ON c.id = a.conversation_id AND c.organization_id = a.organization_id
        WHERE a.run_id = $1 AND a.organization_id = $2
        ORDER BY a.proposed_score DESC, a.conversation_id`,
      [req.params.runId, req.orgId]
    );
    res.json({ success: true, run: runs[0], conversations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/lead-qualification-runs/:runId/apply', requireRole('owner', 'admin'), async (req, res) => {
  const pool = getPool();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: runs } = await client.query(
      `SELECT * FROM lead_qualification_runs
        WHERE run_id = $1 AND organization_id = $2
        FOR UPDATE`,
      [req.params.runId, req.orgId]
    );
    const run = runs[0];
    if (!run) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Evaluación no encontrada' });
    }
    if (run.status !== 'completed' || run.applied) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'La evaluación no está disponible para aplicar' });
    }
    const { rows: updated } = await client.query(
      `UPDATE conversations c
          SET lead_temperature = a.proposed_temperature,
              lead_score = a.proposed_score,
              qualification_reasons = a.proposed_reasons,
              lead_signals = a.proposed_signals,
              qualified_at = NOW()
         FROM lead_qualification_audits a
        WHERE a.run_id = $1
          AND a.organization_id = $2
          AND c.id = a.conversation_id
          AND c.organization_id = a.organization_id
          AND c.updated_at IS NOT DISTINCT FROM a.before_updated_at
        RETURNING c.id`,
      [req.params.runId, req.orgId]
    );
    const updatedIds = updated.map(row => row.id);
    if (updatedIds.length) {
      await client.query(
        `UPDATE lead_qualification_audits
            SET applied = TRUE
          WHERE run_id = $1 AND organization_id = $2
            AND conversation_id = ANY($3::int[])`,
        [req.params.runId, req.orgId, updatedIds]
      );
    }
    const skipped = Number(run.conversation_count || 0) - updatedIds.length;
    await client.query(
      `UPDATE lead_qualification_runs
          SET applied = TRUE,
              summary = summary || $1::jsonb
        WHERE run_id = $2 AND organization_id = $3`,
      [JSON.stringify({ appliedCount: updatedIds.length, skippedChanged: skipped }), req.params.runId, req.orgId]
    );
    await client.query('COMMIT');
    res.json({ success: true, runId: req.params.runId, applied: updatedIds.length, skippedChanged: skipped });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client?.release();
  }
});

/**
 * POST /api/conversations/:id/analyze
 * Analiza la conversación con IA y devuelve un reporte del comportamiento del bot.
 */
router.post('/:id/analyze', async (req, res) => {
  try {
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const messages = await db.getMessagesByConversation(conv.id, 200);
    if (!messages.length) return res.json({ success: true, analysis: { error: 'Sin mensajes para analizar' } });

    // Formatear historial para el análisis
    const transcript = messages.map(m => {
      const who = m.direction === 'inbound' ? '👤 Cliente' : (m.sent_by === 'human' ? '🧑 Agente humano' : '🤖 Bot');
      const time = new Date(m.created_at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${who}: ${m.content}`;
    }).join('\n');

    const resp = await aiClient.messages.create({
      model: modelFor('fast'),
      max_tokens: 1024,
      system: `Eres un analista de calidad para un CRM de WhatsApp con bot de ventas IA.
Tu tarea: analizar conversaciones y evaluar el desempeño del bot.

REGLAS PARA estado_final (MUY IMPORTANTE — leer con cuidado):
- "compró"         → el cliente confirmó y pagó o hay orden creada
- "agendó"         → el cliente mencionó explícitamente una fecha futura para recibir o pedir (ej: "el viernes", "el 2 de septiembre", "la próxima semana cuando llegue"), aunque no haya dado aún su dirección
- "interesado"     → mostró interés pero SIN comprometerse a una fecha concreta
- "exploró"        → solo preguntó precios o info, sin intención clara de compra
- "insatisfecho"   → se fue molesto o sin resolver su problema
- "se dio de baja" → pidió no recibir más mensajes

Si el cliente dijo una fecha específica → SIEMPRE es "agendó", no "interesado".

REGLA IMPORTANTE sobre pedidos agendados:
- Si la conversación resultó en un pedido agendado ("agendó"), NO es un error que el bot no haya pedido dirección ni pago.
- La dirección y el pago se coordinan el día del pedido, no antes. Esto es intencional.
- Solo es error si el bot confundió la fecha (ej: dijo "hoy" cuando era para el lunes).

Responde SIEMPRE en JSON con esta estructura exacta:
{
  "resumen": "1-2 oraciones describiendo qué pasó",
  "intencion_cliente": "qué quería el cliente",
  "deteccion_correcta": true/false,
  "estado_final": "compró | agendó | interesado | exploró | insatisfecho | se dio de baja | otro",
  "puntaje_bot": 1-5,
  "aciertos": ["lista de cosas que hizo bien el bot"],
  "errores": ["lista de errores o problemas detectados"],
  "oportunidades": ["cosas que el bot pudo hacer mejor"],
  "proxima_accion": "qué debería hacer el negocio ahora"
}
Sin texto fuera del JSON. Sin markdown.`,
      messages: [{
        role: 'user',
        content: `Estado actual de la conversación: ${conv.pipeline_state || 'exploring'}
Cliente: ${conv.contact_name || conv.phone_number}

CONVERSACIÓN:
${transcript}

Analiza y devuelve el JSON.`,
      }],
    });

    let analysis;
    const rawText = responseText(resp);
    try {
      // El modelo a veces envuelve el JSON en ```json ... ``` — limpiar antes de parsear
      const raw = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      analysis = JSON.parse(raw);
    } catch {
      analysis = { resumen: rawText, error: 'Formato inesperado' };
    }

    // Aplicar automáticamente el estado detectado al pipeline
    const STATE_MAP = {
      'compró':         'confirmed',
      'agendó':         'scheduled',
      'interesado':     'interested',
      'exploró':        'exploring',
      'insatisfecho':   'exploring',
      'se dio de baja': 'opted_out',
    };
    const newState = STATE_MAP[analysis.estado_final];
    if (newState && newState !== conv.pipeline_state) {
      await db.updatePipelineState(conv.id, newState);
      analysis.estado_aplicado = newState;
      // Opt-out automático si el análisis detecta baja
      if (analysis.estado_final === 'se dio de baja' && conv.phone_number) {
        await db.setContactOptOut(req.orgId, conv.phone_number, true);
      }
    }

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[Conv/analyze]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/generate-improvements
 * Toma los errores/oportunidades del análisis y genera reglas concretas para mejorar el bot.
 * Body: { errores: string[], oportunidades: string[], resumen: string }
 */
router.post('/:id/generate-improvements', async (req, res) => {
  try {
    const { errores = [], oportunidades = [], resumen = '' } = req.body;

    if (!errores.length && !oportunidades.length) {
      return res.json({ success: true, rules: [] });
    }

    const resp = await aiClient.messages.create({
      model: modelFor('fast'),
      max_tokens: 512,
      system: `Eres un experto en optimización de bots de ventas por WhatsApp.
Tu tarea: convertir errores y oportunidades detectadas en una conversación en REGLAS CONCRETAS que el bot debe seguir de ahora en adelante.

Las reglas deben ser:
- En imperativo directo (ej: "Cuando el cliente mencione una fecha, confirma el día exacto")
- Específicas y accionables, no vagas
- Máximo 15 palabras cada una
- En español

Responde SOLO un array JSON de strings. Sin texto fuera del JSON. Sin markdown.
Ejemplo: ["Regla 1", "Regla 2", "Regla 3"]`,
      messages: [{
        role: 'user',
        content: `Contexto de la conversación: ${resumen}

ERRORES del bot:
${errores.map((e, i) => `${i + 1}. ${e}`).join('\n') || '(ninguno)'}

OPORTUNIDADES de mejora:
${oportunidades.map((o, i) => `${i + 1}. ${o}`).join('\n') || '(ninguna)'}

Genera entre 2 y 5 reglas concretas para el bot basadas en estos errores y oportunidades.`,
      }],
    });

    let rules = [];
    try {
      const raw = responseText(resp).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      rules = JSON.parse(raw);
      if (!Array.isArray(rules)) rules = [];
    } catch {
      rules = [];
    }

    res.json({ success: true, rules });
  } catch (err) {
    console.error('[Conv/generate-improvements]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Proxy de media (imágenes, audio) ─────────────────────────────
router.get('/media/:mediaRef', async (req, res) => {
  try {
    const kapsoSvc = require('../services/kapso-whatsapp');
    const mediaCache = require('../services/media-cache');
    const axios = require('axios');
    const whatsappConfig = await db.getWhatsappConfig(req.orgId);

    // El valor guardado en media_id puede ser una URL directa de Kapso
    // o un WhatsApp media ID. Descodificar base64url si aplica.
    let ref = req.params.mediaRef;
    try {
      const decoded = Buffer.from(ref.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      // Validar que la decodificación produjo algo coherente
      if (decoded.startsWith('https://') || decoded.startsWith('evolution:') || /^[\w.\-]+$/.test(decoded)) {
        ref = decoded;
      }
    } catch (_) {}

    const { rows } = await getPool().query(
      'SELECT m.id, m.type, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.organization_id = $1 AND m.media_id = $2 LIMIT 1',
      [req.orgId, ref]);
    if (!rows.length) return res.status(404).json({ error: 'Media no disponible' });
    const cacheKey = req.orgId + ':' + ref;
    const stored = await db.getMessageMediaBlob(req.orgId, rows[0].id);
    const cached = mediaCache.get(cacheKey) || mediaCache.get(ref);
    let data, contentType;
    if (stored) ({ data, content_type: contentType } = stored);
    else if (cached) ({ data, contentType } = cached);
    else if (ref.startsWith('evolution:')) {
      ({ data, contentType } = await require('../services/evolution-whatsapp').downloadMediaReference(req.orgId, ref));
      mediaCache.set(cacheKey, data, contentType);
      await db.saveMessageMediaBlob(req.orgId, rows[0].id, data, contentType).catch(() => {});
    } else {
      const apiKey = whatsappConfig?.kapso_api_key || process.env.KAPSO_API_KEY;
      if (!ref.startsWith('https://') && !apiKey) return res.status(503).json({ error: 'WhatsApp no configurado' });
      const url = ref.startsWith('https://') ? ref : (await kapsoSvc.getMediaUrl(ref, whatsappConfig)).url;
      ({ data, contentType } = await kapsoSvc.downloadMedia(url, whatsappConfig));
      mediaCache.set(cacheKey, data, contentType);
      await db.saveMessageMediaBlob(req.orgId, rows[0].id, data, contentType).catch(() => {});
    }
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    if (rows[0].type === 'document') {
      const filename = String(rows[0].content || 'archivo').split('\n')[0].replace(/^📎\s*/, '').replace(/["\r\n]/g, '').slice(0, 120) || 'archivo';
      res.set('Content-Disposition', `inline; filename="${filename}"`);
    }
    res.send(Buffer.from(data));
  } catch (err) {
    console.error('[Media proxy] Error:', err.message, '| status:', err.response?.status, '| ref:', err.config?.url?.slice(0,80));
    res.status(404).json({ error: 'Media no disponible', detail: err.message });
  }
});

/**
 * GET /api/conversations/unanswered
 * Conversaciones donde el último mensaje es inbound (sin respuesta del bot) en las últimas N horas.
 */
router.get('/unanswered', async (req, res) => {
  const pool = getPool();
  const hours = parseInt(req.query.hours) || 48;
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.phone_number,
        c.contact_name,
        c.agent_mode,
        m.content   AS last_message,
        m.created_at AS last_message_at
      FROM conversations c
      JOIN LATERAL (
        SELECT content, direction, created_at
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON true
      WHERE c.organization_id = $1
        AND c.agent_mode = 'ai'
        AND m.direction   = 'inbound'
        AND m.created_at  > NOW() - ($2 || ' hours')::interval
      ORDER BY m.created_at DESC
    `, [req.orgId, hours]);

    res.json({ success: true, count: rows.length, conversations: rows });
  } catch (err) {
    console.error('[Unanswered] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/retry-unanswered
 * Re-ejecuta el pipeline para cada conversación sin respuesta (bot mode, últimas N horas).
 */
router.post('/retry-unanswered', async (req, res) => {
  const pool = getPool();
  const hours = parseInt(req.body?.hours) || 48;

  try {
    // 1. Buscar conversaciones sin respuesta
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.phone_number,
        c.whatsapp_channel_id,
        m.id AS last_inbound_id,
        m.content AS last_inbound
      FROM conversations c
      JOIN LATERAL (
        SELECT id, content, direction, created_at
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON true
      WHERE c.organization_id = $1
        AND c.agent_mode = 'ai'
        AND m.direction   = 'inbound'
        AND m.created_at  > NOW() - ($2 || ' hours')::interval
      ORDER BY m.created_at ASC
    `, [req.orgId, hours]);

    if (!rows.length) {
      return res.json({ success: true, retried: 0, results: [] });
    }

    // 2. Obtener pipeline. La configuración de salida se resuelve por conversación
    // para no responder un chat de Evolution desde el número oficial de Kapso.
    const pipeline = require('../services/pipeline');

    const results = [];
    for (const conv of rows) {
      let lockClient = null;
      try {
        lockClient = await pool.connect();
        await lockClient.query('SELECT pg_advisory_lock($1, $2)', [req.orgId, conv.id]);
        const latest = await lockClient.query(`
          SELECT id, direction
          FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `, [conv.id]);
        if (!latest.rows[0]
          || latest.rows[0].direction !== 'inbound'
          || String(latest.rows[0].id) !== String(conv.last_inbound_id)) {
          results.push({ phone: conv.phone_number, success: false, reason: 'already_answered' });
          continue;
        }
        if (inboundPolicy.isNoResponseNeeded(conv.last_inbound)) {
          results.push({ phone: conv.phone_number, success: false, reason: 'no_response_needed' });
          continue;
        }
        const result = await pipeline.processMessage(req.orgId, conv.id, conv.last_inbound);
        if (result.duplicate) {
          results.push({ phone: conv.phone_number, success: false, reason: 'duplicate' });
          continue;
        }
        if (result.skipped || !result.response) {
          results.push({ phone: conv.phone_number, success: false, reason: result.reason || 'no_response' });
          continue;
        }

        if (result?.response && !result?.duplicate) {
          const currentConversation = await db.getConversationById(conv.id, req.orgId);
          const outboundDecision = await pipelineOutbound.evaluatePipelineResult({
            orgId: req.orgId,
            conversationId: conv.id,
            userMessage: conv.last_inbound,
            result,
          });
          if (outboundDecision.escalate) {
            const responseWasReplaced = outboundDecision.response !== result.response;
            await pipelineOutbound.coordinateConversation({
              orgId: req.orgId,
              conversationId: conv.id,
              conversation: currentConversation || conv,
              userMessage: conv.last_inbound,
              reason: outboundDecision.reason,
              botWasGoingToSay: outboundDecision.botWasGoingToSay,
              io,
            });
            result.response = outboundDecision.response;
            result.agentType = 'orchestrator';
            result.productMedia = null;
            if (responseWasReplaced) {
              result.aiProvider = null;
              result.aiModel = null;
              result.promptVersion = 'escalation-ack-v1';
            }
          }
          // Enviar y guardar en DB
          const sendConfig = await outboundConfig(req.orgId, conv);
          if (!sendConfig) throw new Error('WhatsApp no configurado para la conversación');
          const sent = await whatsappProvider.sendTextMessage(conv.phone_number, result.response, sendConfig);
          const savedOutbound = await db.saveMessage({
            conversationId: conv.id,
            whatsappMessageId: whatsappProvider.messageId(sent),
            direction: 'outbound',
            content: result.response,
            sentBy: 'ai',
            agentType: result.agentType,
            aiProvider: result.aiProvider,
            aiModel: result.aiModel,
            promptVersion: result.promptVersion,
          }).catch(() => {});
          await db.updateConversationLastMessage(conv.id, result.response, false).catch(() => {});

          const finalConversation = await db.getConversationById(conv.id, req.orgId);
          io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, {
            message: savedOutbound,
            conversation: finalConversation,
          });
          if (result.productMedia) {
            await require('../services/product-media-delivery').sendSuggested({
              suggestion: result.productMedia,
              orgId: req.orgId,
              conversation: finalConversation || currentConversation || conv,
              config: sendConfig,
              io,
              agentType: result.agentType,
            });
          }
          if (result.orderCreated) {
            io?.to(`org_${req.orgId}`).emit(`order_created_${req.orgId}`, { conversationId: conv.id, order: result.orderCreated });
          }
          if (result.orderUpdated || result.orderCancelled) {
            const changed = result.orderUpdated || result.orderCancelled;
            io?.to(`org_${req.orgId}`).emit(`order_updated_${req.orgId}`, {
              conversationId: conv.id,
              orderId: changed.orderId,
              event: result.orderUpdated ? 'updated' : 'cancelled',
            });
          }
          if (result.adminNotice) {
            notifyAdmin(req.orgId, { body: result.adminNotice, kind: 'order', conversationId: conv.id }).catch(() => {});
          }

          results.push({ phone: conv.phone_number, success: true });
          console.log(`[RetryUnanswered] ✅ ${conv.phone_number}: respondido`);
        } else {
          results.push({ phone: conv.phone_number, success: false, reason: result?.duplicate ? 'duplicate' : 'no_response' });
        }
      } catch (err) {
        console.error(`[RetryUnanswered] ❌ ${conv.phone_number}:`, err.message);
        results.push({ phone: conv.phone_number, success: false, reason: err.message });
      } finally {
        if (lockClient) {
          await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [req.orgId, conv.id]).catch(() => {});
          lockClient.release();
        }
      }

      // pequeña pausa entre mensajes para no saturar la API
      await new Promise(r => setTimeout(r, 500));
    }

    const sent = results.filter(r => r.success).length;
    res.json({ success: true, retried: rows.length, sent, results });
  } catch (err) {
    console.error('[RetryUnanswered] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
