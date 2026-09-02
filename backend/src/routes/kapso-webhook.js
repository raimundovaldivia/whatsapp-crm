/**
 * kapso-webhook.js — Recibe mensajes entrantes de WhatsApp via Kapso
 *
 * Configura este webhook en app.kapso.ai:
 *   Tu número → Webhooks → Add webhook
 *   URL:    POST https://TU-BACKEND.onrender.com/kapso-webhook
 *   Events: whatsapp.message.received
 *   (Opcional) Habilita firma y copia el secret → guárdalo en KAPSO_WEBHOOK_SECRET
 *
 * Kapso envía JSON con Content-Type: application/json.
 * La org se identifica por el phone_number_id que viene en cada evento.
 */

const express        = require('express');
const router         = express.Router();
const db             = require('../db/database');
const kapsoService   = require('../services/kapso-whatsapp');
const pipeline       = require('../services/pipeline');
const { notifyAdminHandoff }    = require('../services/notifications');
const { analyzePaymentProof }   = require('../services/analyzePaymentProof');
const { createBotLogger }       = require('../services/bot-logger');

let io;
function setSocketIO(socketIO) { io = socketIO; }

/**
 * POST /kapso-webhook
 * Kapso envía JSON; ya está parseado por express.json() en index.js
 */
router.post('/', async (req, res) => {
  // Responder 200 inmediatamente (Kapso reintenta si no recibe respuesta rápida)
  res.sendStatus(200);

  const body = req.body;

  // En Kapso v2 el evento va en el HEADER X-Webhook-Event (no en el body)
  // Fallback a body.event por compatibilidad futura
  const event = req.headers['x-webhook-event'] || body?.event;

  console.log(`[KapsoWebhook] ← ${event || '(sin evento)'} | phone_number_id: ${body?.phone_number_id || '?'}`);

  if (!event) {
    console.warn('[KapsoWebhook] Sin X-Webhook-Event ni body.event. Ignorando.');
    return;
  }

  // ── Identificar la organización por phone_number_id ──────────────────
  const phoneNumberId = body?.phone_number_id;
  if (!phoneNumberId) {
    console.warn('[KapsoWebhook] Payload sin phone_number_id:', JSON.stringify(body).slice(0, 200));
    return;
  }

  const orgResult = await db.getOrgByPhoneNumberId(phoneNumberId);
  if (!orgResult) {
    console.warn(`[KapsoWebhook] phone_number_id '${phoneNumberId}' no registrado en DB.`);
    return;
  }
  const { org, whatsappConfig } = orgResult;

  // ── Verificación de firma HMAC (si hay webhook_secret configurado) ────
  const signature  = req.headers['x-webhook-signature'];
  const secret     = whatsappConfig.webhook_secret || process.env.KAPSO_WEBHOOK_SECRET;
  if (secret && signature) {
    const rawBody = JSON.stringify(body);
    const valid = kapsoService.verifySignature(rawBody, signature, secret);
    if (!valid) {
      console.warn(`[KapsoWebhook] ❌ Firma inválida para org ${org.name}`);
      return;
    }
  }

  // ── Actualizar estado de mensaje (delivered/read/failed) ─────────────
  const statusUpdate = kapsoService.parseStatusUpdate(body, event);
  if (statusUpdate) {
    await db.updateMessageStatus(statusUpdate.messageId, statusUpdate.status);
    io?.emit(`status_update_${org.id}`, statusUpdate);
    return;
  }

  // ── Parsear mensaje entrante ─────────────────────────────────────────
  const parsed = kapsoService.parseWebhookMessage(body, event);
  if (!parsed) return;

  // ── Imagen entrante → posible comprobante de pago ─────────────────
  if (parsed.type === 'image' && parsed.mediaId) {
    await handlePaymentProof(org, whatsappConfig, parsed);
    return;
  }

  // ── Audio sin transcript → guardar y responder ───────────────────
  if (parsed.type === 'audio' && !parsed.text) {
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});
    await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           '🎤 [Audio]',
      type:              'audio',
      sentBy:            'client',
      mediaId:           parsed.mediaId,
    });
    await db.updateConversationLastMessage(conversation.id, '🎤 [Audio]', true);
    await db.updateLastInbound(conversation.id);
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig).catch(() => {});
    const reply = '¡Hola! No puedo escuchar audios 😊 ¿Puedes escribirme lo que necesitas?';
    const sentMsg = await kapsoService.sendTextMessage(parsed.from, reply, whatsappConfig).catch(() => null);
    if (sentMsg) {
      await db.saveMessage({
        conversationId:    conversation.id,
        whatsappMessageId: sentMsg?.messages?.[0]?.id,
        direction:         'outbound',
        content:           reply,
        sentBy:            'ai',
      });
    }
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: '🎤 [Audio]', type: 'audio', media_id: parsed.mediaId },
      conversation: updatedConv,
    });
    return;
  }

  if (!parsed.text) return;

  const log = createBotLogger(org.name, parsed.from);
  log.in(parsed.text);

  try {
    // 1. Obtener/crear conversación
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);

    // 1b. Registrar como lead (sin pisar tipo si ya es customer)
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});

    // 2. Guardar mensaje del cliente (puede ser duplicado si otro webhook llegó primero)
    const savedMsg = await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           parsed.text,
      sentBy:            'client',
      mediaId:           parsed.mediaId,
    });

    await db.updateConversationLastMessage(conversation.id, parsed.text, true);
    await db.updateLastInbound(conversation.id);
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig);

    // 3. Emitir al CRM en tiempo real
    const msgForSocket = savedMsg || { conversationId: conversation.id, direction: 'inbound', content: parsed.text };
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: msgForSocket, conversation: updatedConv });

    // 4. Si está en modo humano, verificar si hace mucho que no responde un humano
    if (updatedConv.agent_mode !== 'ai') {
      const AUTO_RESET_MINUTES = 1440;
      const mins = await db.minutesSinceLastHumanReply(conversation.id);
      if (mins < AUTO_RESET_MINUTES) {
        log.humanMode(mins);
        log.done();
        return;
      }
      log.autoReset(mins);
      await db.setAgentMode(conversation.id, 'ai');
      io?.emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'ai' });
      if (typeof db.clearLastEscalation === 'function') {
        await db.clearLastEscalation(conversation.id).catch(() => {});
      }
      await db.updatePipelineState(conversation.id, 'exploring', {}).catch(() => {});
      log.done();
      return;
    }

    // 5. Ejecutar pipeline de 3 agentes
    io?.emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: true });
    const tPipeline = Date.now();
    const result = await pipeline.processMessage(org.id, conversation.id, parsed.text, log);
    io?.emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: false });

    // Si el pipeline detectó un pedido duplicado, no enviar ni guardar nada
    if (result.duplicate) {
      console.warn(`[KapsoWebhook] Pedido duplicado ignorado para conv ${conversation.id}`);
      log.step('duplicate', 'pedido ya creado por otro proceso — respuesta silenciada');
      log.done();
      return;
    }

    log.response(result.response, Date.now() - tPipeline);

    // 6. Enviar respuesta por WhatsApp via Kapso
    let sentResult = null;
    let windowExpired = false;
    const tSend = Date.now();
    try {
      sentResult = await kapsoService.sendTextMessage(
        parsed.from,
        result.response,
        whatsappConfig
      );
      log.sent(Date.now() - tSend);
    } catch (sendErr) {
      if (sendErr.is24hWindow) {
        windowExpired = true;
        log.windowExpired(parsed.from);
        io?.emit(`window_expired_${org.id}`, { conversationId: conversation.id, phone: parsed.from });
      } else {
        throw sendErr;
      }
    }

    // 7. Guardar respuesta en DB (aunque no se haya podido enviar)
    const outMsg = await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: sentResult?.messages?.[0]?.id || null,
      direction:         'outbound',
      content:           windowExpired
        ? `⏰ [Mensaje bloqueado — ventana 24h expirada]\n${result.response}`
        : result.response,
      sentBy:            'ai',
      agentType:         result.agentType,
      status:            windowExpired ? 'failed' : 'sent',
    });

    await db.updateConversationLastMessage(conversation.id, result.response);

    // 8. Si el pipeline indica cambiar a modo humano
    if (result.switchToHuman) {
      io?.emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'human' });
      const reason = result.escalationReason || 'El cliente solicitó hablar con un asesor';
      notifyAdminHandoff(org.id, conversation, reason);
    }

    const finalConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: outMsg, conversation: finalConv });

    // 9. Si se creó una orden, notificar al CRM
    if (result.orderCreated) {
      io?.emit(`order_created_${org.id}`, {
        conversationId: conversation.id,
        order: result.orderCreated,
      });
    }

    log.done();

  } catch (err) {
    if (err.response) {
      log.error('HTTP', new Error(`${err.response.status} ${err.config?.url} — ${JSON.stringify(err.response.data)}`));
    } else {
      log.error('pipeline', err);
    }
    log.done();
  }
});

/**
 * Maneja una imagen entrante como posible comprobante de pago.
 * Guarda el comprobante, responde al cliente y notifica al admin.
 */
async function handlePaymentProof(org, whatsappConfig, parsed) {
  try {
    console.log(`[KapsoWebhook] 📸 Imagen de ${parsed.from} — analizando con IA...`);

    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig).catch(() => {});

    // ── 1. Descargar imagen y analizar con Claude Vision ────────────
    let analysis = { is_payment_proof: false };
    let data, contentType;
    try {
      const mediaInfo = await kapsoService.getMediaUrl(parsed.mediaId, whatsappConfig);
      ({ data, contentType } = await kapsoService.downloadMedia(mediaInfo.url, whatsappConfig));
      analysis = await analyzePaymentProof(data, contentType);
      console.log(`[KapsoWebhook] 🤖 Análisis IA:`, JSON.stringify(analysis));
    } catch (aiErr) {
      console.warn('[KapsoWebhook] Error en análisis IA, asumiendo comprobante:', aiErr.message);
      // Si Claude falla, tratar como comprobante por seguridad
      analysis = { is_payment_proof: true, confidence: 'low' };
    }

    // ── 2. Si NO es comprobante → analizar con Vision y pasar al bot ────────
    if (!analysis.is_payment_proof) {
      await db.saveMessage({
        conversationId:    conversation.id,
        whatsappMessageId: parsed.messageId,
        direction:         'inbound',
        content:           '📷 [Imagen]',
        type:              'image',
        sentBy:            'client',
        mediaId:           parsed.mediaId,
      });
      await db.updateConversationLastMessage(conversation.id, '📷 [Imagen]', true);
      await db.updateLastInbound(conversation.id);

      // Analizar imagen con Claude Vision y pasar contexto al pipeline
      let imageContext = '[imagen]';
      if (data && contentType) {
        try {
          const Anthropic = require('@anthropic-ai/sdk');
          const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          const base64img = Buffer.from(data).toString('base64');
          const visionResp = await aiClient.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: contentType, data: base64img } },
              { type: 'text', text: 'Describe brevemente qué muestra esta imagen en 1-2 oraciones en español, sin saludar.' }
            ]}]
          });
          imageContext = `[imagen: ${visionResp.content[0]?.text || 'imagen enviada por el cliente'}]`;
        } catch (_) {}
      }

      const imgLog = createBotLogger(org.name, parsed.from);
      imgLog.in(imageContext);
      io?.emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: true });
      let imgResult;
      try {
        imgResult = await pipeline.processMessage(org.id, conversation.id, imageContext, imgLog);
      } finally {
        io?.emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: false });
      }

      if (imgResult && !imgResult.duplicate) {
        const sentMsg = await kapsoService.sendTextMessage(parsed.from, imgResult.response, whatsappConfig).catch(() => null);
        const outMsg = await db.saveMessage({
          conversationId:    conversation.id,
          whatsappMessageId: sentMsg?.messages?.[0]?.id || null,
          direction:         'outbound',
          content:           imgResult.response,
          sentBy:            'ai',
          agentType:         imgResult.agentType,
        });
        await db.updateConversationLastMessage(conversation.id, imgResult.response);
        const updatedConv = await db.getConversationById(conversation.id);
        io?.emit(`new_message_${org.id}`, {
          message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: parsed.mediaId },
          conversation: updatedConv,
        });
        io?.emit(`new_message_${org.id}`, { message: outMsg, conversation: updatedConv });
      } else {
        const updatedConv = await db.getConversationById(conversation.id);
        io?.emit(`new_message_${org.id}`, {
          message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: parsed.mediaId },
          conversation: updatedConv,
        });
      }
      return;
    }

    // ── 3. ES un comprobante — guardar mensaje ───────────────────────
    await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           '📸 [Comprobante de pago]',
      type:              'image',
      sentBy:            'client',
      mediaId:           parsed.mediaId,
    });
    await db.updateConversationLastMessage(conversation.id, '📸 [Comprobante de pago]', true);
    await db.updateLastInbound(conversation.id);

    // ── 4. Comparar monto con el pedido pendiente ────────────────────
    const pendingOrder = await db.getLatestPendingOrderByConversation(conversation.id);
    let amountMatches  = null;
    let proofStatus    = 'pending';

    if (analysis.amount && pendingOrder?.total_price) {
      const orderAmt = parseFloat(String(pendingOrder.total_price).replace(/[^0-9.]/g, ''));
      const paidAmt  = parseFloat(String(analysis.amount).replace(/[^0-9.]/g, ''));
      if (!isNaN(orderAmt) && !isNaN(paidAmt)) {
        amountMatches = Math.abs(orderAmt - paidAmt) <= 1; // tolerancia $1
        proofStatus   = amountMatches ? 'pre_verified' : 'pending';
        console.log(`[KapsoWebhook] 💰 Monto pedido: $${orderAmt} | Pagado: $${paidAmt} | Match: ${amountMatches}`);
      }
    }

    // ── 5. Guardar comprobante con datos extraídos ───────────────────
    const proof = await db.savePaymentProof({
      orgId:              org.id,
      conversationId:     conversation.id,
      orderId:            pendingOrder?.id || null,
      mediaId:            parsed.mediaId,
      customerPhone:      parsed.from,
      customerName:       conversation.contact_name || parsed.contactName,
      orderSummary:       pendingOrder ? `${pendingOrder.customer_name || ''} — $${pendingOrder.total_price || '?'}` : null,
      extractedAmount:    analysis.amount    || null,
      extractedDate:      analysis.date      || null,
      extractedBank:      analysis.bank      || null,
      extractedReference: analysis.reference || null,
      aiConfidence:       analysis.confidence || null,
      amountMatches,
      status:             proofStatus,
    });

    // Actualizar estado del pedido
    if (pendingOrder) {
      await db.updateOrder(pendingOrder.id, { status: 'payment_received' }).catch(() => {});
    }

    // ── 6. Responder al cliente ──────────────────────────────────────
    let reply;
    if (amountMatches === true) {
      reply = `✅ ¡Comprobante recibido y verificado automáticamente! Tu pago de $${analysis.amount?.toLocaleString('es-CL')} fue confirmado. Pronto despacharemos tu pedido 🚀`;
    } else if (amountMatches === false) {
      reply = `✅ Recibimos tu comprobante. Nuestro equipo lo revisará porque detectamos una diferencia en el monto — te confirmaremos pronto 🔍`;
    } else {
      reply = `✅ ¡Recibimos tu comprobante de pago! Lo verificaremos a la brevedad y te avisaremos cuando tu pedido esté listo para despacho 🚀`;
    }

    const sentMsg = await kapsoService.sendTextMessage(parsed.from, reply, whatsappConfig).catch(() => null);
    await db.saveMessage({
      conversationId: conversation.id, whatsappMessageId: sentMsg?.messages?.[0]?.id || null,
      direction: 'outbound', content: reply, sentBy: 'ai', agentType: 'system',
    });
    await db.updateConversationLastMessage(conversation.id, reply);

    // ── 7. Notificar al admin ────────────────────────────────────────
    const adminPhone = await db.getSetting(org.id, 'admin_alert_phone');
    if (adminPhone) {
      const wc = await db.getWhatsappConfig(org.id);
      if (wc) {
        const clientName  = conversation.contact_name || parsed.from;
        const orderLine   = pendingOrder ? `\n📦 *Pedido:* ${pendingOrder.customer_name || ''} — $${pendingOrder.total_price || '?'}` : '';
        const amountLine  = analysis.amount  ? `\n💵 *Monto pagado:* $${analysis.amount?.toLocaleString('es-CL')} ${analysis.currency || ''}` : '';
        const bankLine    = analysis.bank    ? `\n🏦 *Banco:* ${analysis.bank}` : '';
        const matchLine   = amountMatches === true  ? '\n✅ *Monto coincide — pre-verificado*'
                          : amountMatches === false ? '\n⚠️ *Monto NO coincide — revisar manualmente*'
                          : '';
        const adminMsg = `📸 *Comprobante de pago recibido*\n\n👤 *Cliente:* ${clientName} (${parsed.from})${orderLine}${amountLine}${bankLine}${matchLine}\n\nRevísalo en el CRM → Pagos.`;
        await kapsoService.sendTextMessage(adminPhone, adminMsg, wc).catch(() => {});
      }
    }

    // ── 8. Emitir al CRM en tiempo real ─────────────────────────────
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: '📸 [Comprobante de pago]', type: 'image', media_id: parsed.mediaId },
      conversation: updatedConv,
    });
    io?.emit(`payment_proof_${org.id}`, { proof, conversationId: conversation.id });

  } catch (err) {
    console.error('[KapsoWebhook] Error procesando imagen:', err.message);
  }
}

module.exports = router;
module.exports.setSocketIO = setSocketIO;
