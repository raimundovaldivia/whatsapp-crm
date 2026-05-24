const express = require('express');
const router = express.Router();
const db = require('../db/database');
const whatsappService = require('../services/whatsapp');
const pipeline = require('../services/pipeline');

let io;
function setSocketIO(socketIO) { io = socketIO; }

/**
 * GET /webhook — Verificación de Meta
 * Meta envía hub.verify_token; lo comparamos con el de la org
 * También acepta WEBHOOK_VERIFY_TOKEN como fallback de env var
 */
router.get('/', async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[Webhook] Verificación recibida — token:', token);

  if (mode !== 'subscribe') {
    console.warn('[Webhook] ❌ hub.mode inválido:', mode);
    return res.sendStatus(403);
  }

  // 1. Verificar con token global de env var (fallback para setup inicial)
  const envToken = process.env.WEBHOOK_VERIFY_TOKEN;
  if (envToken && token === envToken) {
    console.log('[Webhook] ✅ Verificado via WEBHOOK_VERIFY_TOKEN env var');
    return res.status(200).send(challenge);
  }

  // 2. Cada cliente tiene su propio token guardado en la DB al hacer el setup
  const result = await db.getOrgByWebhookToken(token);
  if (!result) {
    console.warn('[Webhook] ❌ Token no encontrado en ninguna org:', token);
    return res.sendStatus(403);
  }

  console.log(`[Webhook] ✅ Verificado para org: ${result.org.name}`);
  return res.status(200).send(challenge);
});

/**
 * POST /webhook — Mensajes entrantes de WhatsApp
 */
router.post('/', async (req, res) => {
  res.sendStatus(200); // Responder siempre 200 a Meta

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  // Identificar la organización por el Phone Number ID del mensaje
  const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const orgResult = await db.getOrgByPhoneNumberId(phoneNumberId);
  if (!orgResult) {
    console.warn('[Webhook] Phone Number ID no registrado:', phoneNumberId);
    return;
  }
  const { org, whatsappConfig } = orgResult;

  // Si el proveedor activo es Kapso, ignorar — el kapso-webhook lo maneja
  if (whatsappConfig?.provider === 'kapso') {
    console.log(`[Webhook] Org ${org.name} usa Kapso, ignorando Meta webhook`);
    return;
  }

  // Actualizar status de mensaje (delivery receipt)
  const statusUpdate = whatsappService.parseStatusUpdate(body);
  if (statusUpdate) {
    await db.updateMessageStatus(statusUpdate.messageId, statusUpdate.status);
    io?.emit(`status_update_${org.id}`, statusUpdate);
    return;
  }

  // Parsear mensaje entrante
  const parsed = whatsappService.parseWebhookMessage(body);
  if (!parsed || parsed.type !== 'text' || !parsed.text) return;

  console.log(`[Webhook] [Org:${org.name}] 📩 ${parsed.from}: ${parsed.text}`);

  try {
    // 1. Obtener/crear conversación
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);

    // 2. Guardar mensaje del cliente
    const savedMsg = await db.saveMessage({
      conversationId: conversation.id,
      whatsappMessageId: parsed.messageId,
      direction: 'inbound',
      content: parsed.text,
      sentBy: 'client',
    });
    if (!savedMsg) return; // Duplicado

    await db.updateConversationLastMessage(conversation.id, parsed.text, true);
    await whatsappService.markAsRead(parsed.messageId, whatsappConfig);

    // 3. Emitir al CRM en tiempo real
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: savedMsg, conversation: updatedConv });

    // 4. Si está en modo humano, no responder con IA
    if (updatedConv.agent_mode !== 'ai') {
      console.log(`[Webhook] Modo humano activo, sin respuesta IA`);
      return;
    }

    // 5. Verificar que tenemos access_token válido antes de procesar con IA
    if (!whatsappConfig?.access_token || whatsappConfig.access_token === 'null') {
      console.warn(`[Webhook] ⚠️  access_token nulo para org ${org.name} — omitiendo respuesta IA`);
      return;
    }

    // 6. Ejecutar pipeline de 3 agentes
    const result = await pipeline.processMessage(org.id, conversation.id, parsed.text);

    // 7. Enviar respuesta por WhatsApp
    const sentResult = await whatsappService.sendTextMessage(
      parsed.from,
      result.response,
      whatsappConfig
    );

    // 8. Guardar respuesta en DB
    const outMsg = await db.saveMessage({
      conversationId: conversation.id,
      whatsappMessageId: sentResult?.messages?.[0]?.id || null,
      direction: 'outbound',
      content: result.response,
      sentBy: 'ai',
      agentType: result.agentType,
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
    console.error('[Webhook] Error procesando mensaje:', err);
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
