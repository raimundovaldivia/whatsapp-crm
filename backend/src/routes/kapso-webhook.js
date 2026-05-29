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
  if (!parsed || !parsed.text) return;

  console.log(`[KapsoWebhook] [Org:${org.name}] 📩 ${parsed.from}: ${parsed.text}`);

  try {
    // 1. Obtener/crear conversación
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);

    // 2. Guardar mensaje del cliente (puede ser duplicado si otro webhook llegó primero)
    const savedMsg = await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           parsed.text,
      sentBy:            'client',
    });
    // Si es duplicado (savedMsg null), continuar igual — el Meta webhook pudo haberlo guardado
    // pero no puede responder (null token). Kapso sí puede, así que seguimos.

    await db.updateConversationLastMessage(conversation.id, parsed.text, true);
    await db.updateLastInbound(conversation.id);
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig);

    // 3. Emitir al CRM en tiempo real (usar savedMsg o buscarlo si fue duplicado)
    const msgForSocket = savedMsg || { conversationId: conversation.id, direction: 'inbound', content: parsed.text };
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: msgForSocket, conversation: updatedConv });

    // 4. Si está en modo humano, verificar si hace mucho que no responde un humano
    if (updatedConv.agent_mode !== 'ai') {
      const AUTO_RESET_MINUTES = 120; // 2 horas sin respuesta humana → vuelve a IA
      const mins = await db.minutesSinceLastHumanReply(conversation.id);
      if (mins < AUTO_RESET_MINUTES) {
        console.log(`[KapsoWebhook] Modo humano activo (último humano hace ${Math.round(mins)}min), sin respuesta IA`);
        return;
      }
      // Auto-reset a modo IA
      console.log(`[KapsoWebhook] Auto-reset a modo IA (sin respuesta humana en ${Math.round(mins)}min)`);
      await db.setAgentMode(conversation.id, 'ai');
      io?.emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'ai' });
    }

    // 5. Ejecutar pipeline de 3 agentes
    io?.emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: true });
    const result = await pipeline.processMessage(org.id, conversation.id, parsed.text);
    io?.emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: false });

    // 6. Enviar respuesta por WhatsApp via Kapso
    let sentResult = null;
    let windowExpired = false;
    try {
      sentResult = await kapsoService.sendTextMessage(
        parsed.from,
        result.response,
        whatsappConfig
      );
    } catch (sendErr) {
      if (sendErr.is24hWindow) {
        windowExpired = true;
        console.warn(`[KapsoWebhook] ⏰ Ventana 24h expirada para ${parsed.from} — guardando respuesta como bloqueada`);
        // Notificar al CRM para que muestre el banner
        io?.emit(`window_expired_${org.id}`, { conversationId: conversation.id, phone: parsed.from });
      } else {
        throw sendErr; // otro error — propagar
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

  } catch (err) {
    // Imprimir error completo incluyendo respuesta de APIs externas
    if (err.response) {
      console.error('[KapsoWebhook] Error HTTP', err.response.status,
        'url:', err.config?.url,
        'body:', JSON.stringify(err.response.data));
    } else {
      console.error('[KapsoWebhook] Error procesando mensaje:', err.message, err.stack?.split('\n')[1]);
    }
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
