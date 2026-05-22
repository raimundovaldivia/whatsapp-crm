/**
 * twilio-webhook.js — Recibe mensajes entrantes de WhatsApp via Twilio
 *
 * Configura esta URL en Twilio Dashboard:
 *   Messaging → Sandbox Settings → "When a message comes in":
 *   POST https://TU-NGROK.ngrok-free.app/twilio-webhook
 */

const express        = require('express');
const router         = express.Router();
const db             = require('../db/database');
const twilioService  = require('../services/twilio-whatsapp');
const whatsappService = require('../services/whatsapp');
const pipeline       = require('../services/pipeline');

let io;
function setSocketIO(socketIO) { io = socketIO; }

/**
 * POST /twilio-webhook
 * Twilio envía los mensajes como application/x-www-form-urlencoded
 */
router.post('/', async (req, res) => {
  // Twilio espera respuesta TwiML vacía (sin mensaje automático de Twilio)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const parsed = twilioService.parseWebhookMessage(req.body);
  if (!parsed) return;

  // El número destino ("To") identifica la org — ej: whatsapp:+14155238886
  const twilioNumber = req.body.To?.replace('whatsapp:', '') || null;
  if (!twilioNumber) return;

  const orgResult = await db.getOrgByTwilioNumber(twilioNumber);
  if (!orgResult) {
    console.warn('[TwilioWebhook] Número Twilio no registrado:', twilioNumber);
    return;
  }

  const { org, whatsappConfig } = orgResult;
  console.log(`[TwilioWebhook] [Org:${org.name}] 📩 ${parsed.from}: ${parsed.text}`);

  try {
    // 1. Obtener/crear conversación
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);

    // 2. Guardar mensaje del cliente
    const savedMsg = await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           parsed.text,
      sentBy:            'client',
    });
    if (!savedMsg) return; // Duplicado

    await db.updateConversationLastMessage(conversation.id, parsed.text, true);

    // 3. Emitir al CRM en tiempo real
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: savedMsg, conversation: updatedConv });

    // 4. Si está en modo humano, no responder con IA
    if (updatedConv.agent_mode !== 'ai') return;

    // 5. Ejecutar pipeline de 3 agentes
    const result = await pipeline.processMessage(org.id, conversation.id, parsed.text);

    // 6. Enviar respuesta por Twilio
    const sentResult = await twilioService.sendTextMessage(
      parsed.from,
      result.response,
      whatsappConfig
    );

    // 7. Guardar respuesta en DB
    const outMsg = await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: sentResult?.messageId || null,
      direction:         'outbound',
      content:           result.response,
      sentBy:            'ai',
      agentType:         result.agentType,
    });

    await db.updateConversationLastMessage(conversation.id, result.response);

    if (result.switchToHuman) {
      io?.emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'human' });
    }

    const finalConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: outMsg, conversation: finalConv });

    if (result.orderCreated) {
      io?.emit(`order_created_${org.id}`, { conversationId: conversation.id, order: result.orderCreated });
    }

  } catch (err) {
    console.error('[TwilioWebhook] Error procesando mensaje:', err);
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
