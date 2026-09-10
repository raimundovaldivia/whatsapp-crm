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
const { notifyAdminHandoff, notifyAdminHelp, notifyAgentsNewMessage, notifyAgentsPayment } = require('../services/notifications');
const secretary = require('../services/admin-secretary');
const { analyzePaymentProof }   = require('../services/analyzePaymentProof');
const { createBotLogger }       = require('../services/bot-logger');
const mediaCache                = require('../services/media-cache');
const { handleAgentCommand }    = require('../services/agent-commands');

let io;
function setSocketIO(socketIO) { io = socketIO; }

// ── Debug store: últimos 20 webhooks recibidos (en memoria) ─────────
const debugLog = [];
function pushDebug(entry) {
  debugLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (debugLog.length > 20) debugLog.pop();
}

// GET /kapso-webhook/debug — retorna los últimos webhooks (sin auth para facilitar debug)
router.get('/debug', (req, res) => {
  res.json({ count: debugLog.length, entries: debugLog });
});

/**
 * Debounce por conversación — evita múltiples respuestas del bot cuando
 * el cliente manda varios mensajes rápidos en sucesión.
 * El pipeline se ejecuta 3 segundos después del ÚLTIMO mensaje recibido.
 */
const pendingPipeline = new Map(); // key: `${orgId}:${conversationId}` → timer

function schedulePipeline(orgId, conversationId, fn) {
  const key = `${orgId}:${conversationId}`;
  if (pendingPipeline.has(key)) clearTimeout(pendingPipeline.get(key));
  const timer = setTimeout(async () => {
    pendingPipeline.delete(key);
    await fn();
  }, 3000); // esperar 3s desde el último mensaje
  pendingPipeline.set(key, timer);
}

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

  const msgType = body?.message?.type || '—';
  console.log(`[KapsoWebhook] ← ${event || '(sin evento)'} | type:${msgType} | phone_number_id: ${body?.phone_number_id || '?'}`);
  pushDebug({ event, msgType, phone_number_id: body?.phone_number_id, raw: JSON.stringify(body).slice(0, 800) });

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
  // Nota: verificación de firma desactivada como bloqueo — JSON.stringify(body)
  // no reproduce exactamente el raw body original, causando falsos negativos.
  // Se loggea como advertencia pero no se bloquea el procesamiento.
  const signature  = req.headers['x-webhook-signature'];
  const secret     = whatsappConfig.webhook_secret || process.env.KAPSO_WEBHOOK_SECRET;
  if (secret && signature) {
    const rawBody = JSON.stringify(body);
    const valid = kapsoService.verifySignature(rawBody, signature, secret);
    if (!valid) {
      console.warn(`[KapsoWebhook] ⚠️ Firma no verificada para org ${org.name} (continuando de todas formas)`);
      // No retornamos — seguimos procesando el mensaje
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
  if (!parsed) {
    if (event === 'whatsapp.message.received') {
      console.warn('[KapsoWebhook] parseWebhookMessage retornó null — body.message:', JSON.stringify(body?.message).slice(0, 600));
    }
    return;
  }
  console.log(`[KapsoWebhook] ✅ parsed: type=${parsed.type} | from=${parsed.from} | mediaId=${parsed.mediaId} | mediaUrl=${parsed.mediaUrl?.slice(0,60)}`);

  // ── Admin relay: si el mensaje viene del teléfono del admin → enrutar al cliente ──
  const adminPhone = await db.getSetting(org.id, 'admin_alert_phone');
  if (adminPhone && parsed.from && db.normalizePhone(parsed.from) === db.normalizePhone(adminPhone)) {
    await handleAdminReply(org, whatsappConfig, parsed);
    return;
  }

  // ── Agente registrado: solo si el mensaje empieza con "#" → procesar como comando ──
  // Mensajes sin "#" van al flujo normal (el agente puede chatear con el bot o aparecer como conversación)
  if (parsed.from && parsed.type === 'text' && parsed.text && parsed.text.trimStart().startsWith('#')) {
    const agent = await db.getUserByWhatsappPhone(org.id, parsed.from).catch(() => null);
    if (agent) {
      const commandText = parsed.text.trimStart().slice(1).trim(); // quitar el "#"
      console.log(`[KapsoWebhook] 🤖 Comando de agente ${agent.name || agent.email}: "${commandText.slice(0, 80)}"`);
      await handleAgentCommand(org, whatsappConfig, agent, commandText);
      return;
    }
  }

  // ── Imagen o documento-imagen entrante → posible comprobante de pago ────
  // WhatsApp puede enviar imágenes como type:'image' o type:'document' (PNG/JPG como archivo)
  if ((parsed.type === 'image' || parsed.type === 'document') && (parsed.mediaId || parsed.mediaUrl)) {
    await handlePaymentProof(org, whatsappConfig, parsed);
    return;
  }

  // ── Audio sin transcript → guardar y responder ───────────────────
  if (parsed.type === 'audio' && !parsed.text) {
    const audioMediaRef = parsed.mediaUrl || parsed.mediaId;
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});
    await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           '🎤 [Audio]',
      type:              'audio',
      sentBy:            'client',
      mediaId:           audioMediaRef,
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
      message: { conversationId: conversation.id, direction: 'inbound', content: '🎤 [Audio]', type: 'audio', media_id: audioMediaRef },
      conversation: updatedConv,
    });
    return;
  }

  if (!parsed.text) return;

  try {
    // 1. Obtener/crear conversación
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);

    // 1b. Registrar como lead (sin pisar tipo si ya es customer)
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});

    // 2. Guardar mensaje del cliente — retorna null si ya existe (webhook duplicado)
    const savedMsg = await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           parsed.text,
      sentBy:            'client',
      mediaId:           parsed.mediaId,
    });

    // Si el mensaje ya estaba en DB (otro webhook / otra instancia lo procesó primero),
    // salir sin ejecutar el pipeline para evitar respuestas duplicadas.
    if (!savedMsg) {
      console.log(`[KapsoWebhook] ⚠️ Mensaje duplicado ignorado: ${parsed.messageId}`);
      return;
    }

    await db.updateConversationLastMessage(conversation.id, parsed.text, true);
    await db.updateLastInbound(conversation.id);
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig);

    // 3. Emitir al CRM en tiempo real (el mensaje siempre aparece inmediatamente)
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, { message: savedMsg, conversation: updatedConv });

    // 3b. Notificar a agentes con new_messages habilitado (sin await para no bloquear)
    notifyAgentsNewMessage(org.id, updatedConv, parsed.text).catch(() => {});

    // 4. Si está en modo humano/pendiente, verificar si corresponde auto-reset
    if (updatedConv.agent_mode !== 'ai') {
      const AUTO_RESET_MINUTES = 1440;
      const mins = await db.minutesSinceLastHumanReply(conversation.id);
      // Solo auto-reset si algún humano YA respondió antes y lleva > 24h sin hacerlo.
      // Si nunca respondió un humano (Infinity), mantener en espera — no interrumpir.
      if (mins < AUTO_RESET_MINUTES || !isFinite(mins)) return;
      // Auto-reset a modo IA
      await db.setAgentMode(conversation.id, 'ai');
      io?.emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'ai' });
      if (typeof db.clearLastEscalation === 'function') {
        await db.clearLastEscalation(conversation.id).catch(() => {});
      }
      await db.updatePipelineState(conversation.id, 'exploring', {}).catch(() => {});
      return;
    }

    // 5. Debounce: esperar 3s desde el ÚLTIMO mensaje antes de ejecutar pipeline.
    //    Si el cliente manda varios mensajes rápidos, solo se procesa el último.
    const capturedText  = parsed.text;
    const capturedFrom  = parsed.from;
    const capturedConvId = conversation.id;

    schedulePipeline(org.id, capturedConvId, async () => {
      const log = createBotLogger(org.name, capturedFrom);
      // Leer el último mensaje inbound de la DB (puede haber llegado algo nuevo durante el debounce)
      const lastMessages = await db.getLastMessages(capturedConvId, 3).catch(() => []);
      const lastInbound  = lastMessages?.find(m => m.direction === 'inbound');
      const textToProcess = lastInbound?.content || capturedText;
      log.in(textToProcess);

      try {
        io?.emit(`bot_typing_${org.id}`, { conversationId: capturedConvId, typing: true });
        const tPipeline = Date.now();
        const result = await pipeline.processMessage(org.id, capturedConvId, textToProcess, log);
        io?.emit(`bot_typing_${org.id}`, { conversationId: capturedConvId, typing: false });

        if (result.duplicate) {
          log.step('duplicate', 'pedido ya creado por otro proceso — respuesta silenciada');
          log.done();
          return;
        }

        log.response(result.response, Date.now() - tPipeline);

        // ── Guardrail: detectar razonamiento interno filtrado al exterior ──
        // El modelo a veces genera meta-comentarios como "El último mensaje fue una reacción..."
        // Si esto ocurre, NO enviar — loggear como error silencioso.
        const INTERNAL_REASONING_PATTERNS = [
          /^el [úu]ltimo mensaje/i,
          /^el cliente (acaba|escribió|dijo|envió)/i,
          /^debería (esperar|responder|ignorar)/i,
          /^no (debería|hay que|corresponde)/i,
          /sin embargo, si el cliente/i,
          /la respuesta sería:/i,
        ];
        if (INTERNAL_REASONING_PATTERNS.some(p => p.test(result.response.trim()))) {
          console.error(`[KapsoWebhook] ⛔ Respuesta con razonamiento interno bloqueada para ${capturedFrom}:`, result.response.slice(0, 100));
          return;
        }

        // ── Si el pipeline escala, no decirle al cliente "te conectaré con un asesor".
        //    El bot pausa y le pregunta al admin en privado.
        //    El cliente recibe silencio (o nada) — el admin decide qué responder.
        if (result.switchToHuman) {
          await db.setAgentMode(capturedConvId, 'human');
          io?.emit(`agent_mode_changed_${org.id}`, { conversationId: capturedConvId, mode: 'human' });
          const reason = result.escalationReason || 'Necesita validación del ejecutivo';
          notifyAdminHelp(org.id, updatedConv || conversation, result.response, reason).catch(() => {});
          log.step('switchToHuman', `admin consultado — conv ${capturedConvId} en pausa`);
          log.done();
          return; // no enviar nada al cliente todavía
        }

        // Enviar respuesta por WhatsApp via Kapso
        let sentResult = null;
        let windowExpired = false;
        const tSend = Date.now();
        try {
          sentResult = await kapsoService.sendTextMessage(capturedFrom, result.response, whatsappConfig);
          log.sent(Date.now() - tSend);
        } catch (sendErr) {
          if (sendErr.is24hWindow) {
            windowExpired = true;
            log.windowExpired(capturedFrom);
            io?.emit(`window_expired_${org.id}`, { conversationId: capturedConvId, phone: capturedFrom });
          } else {
            throw sendErr;
          }
        }

        const outMsg = await db.saveMessage({
          conversationId:    capturedConvId,
          whatsappMessageId: sentResult?.messages?.[0]?.id || null,
          direction:         'outbound',
          content:           windowExpired
            ? `⏰ [Mensaje bloqueado — ventana 24h expirada]\n${result.response}`
            : result.response,
          sentBy:            'ai',
          agentType:         result.agentType,
          status:            windowExpired ? 'failed' : 'sent',
        });

        await db.updateConversationLastMessage(capturedConvId, result.response);

        if (result.orderCreated) {
          io?.emit(`order_created_${org.id}`, {
            conversationId: capturedConvId,
            order: result.orderCreated,
          });
        }

        const finalConv = await db.getConversationById(capturedConvId);
        io?.emit(`new_message_${org.id}`, { message: outMsg, conversation: finalConv });

        log.done();

      } catch (err) {
        io?.emit(`bot_typing_${org.id}`, { conversationId: capturedConvId, typing: false });
        if (err.response) {
          log.error('HTTP', new Error(`${err.response.status} ${err.config?.url} — ${JSON.stringify(err.response.data)}`));
        } else {
          log.error('pipeline', err);
        }
        log.done();
      }
    });

  } catch (outerErr) {
    console.error('[KapsoWebhook] Error procesando mensaje entrante:', outerErr.message);
  }
});

/**
 * Maneja respuestas del admin desde su WhatsApp personal.
 * Cuando el admin responde, su mensaje se reenvía al cliente pendiente más reciente.
 */
async function handleAdminReply(org, whatsappConfig, parsed) {
  if (!parsed.text) return;

  try {
    // Buscar pendiente activo para esta org
    const pending = await db.getLatestPendingAdminReply(org.id);

    // Verificar si hay sesión de secretaria activa aunque no haya pendiente nuevo
    const hasActiveSession = !!secretary.getSession(org.id);

    if (!pending && !hasActiveSession) {
      await kapsoService.sendTextMessage(
        parsed.from,
        'ℹ️ No hay clientes esperando respuesta en este momento.',
        whatsappConfig
      ).catch(() => {});
      return;
    }

    console.log(`[AdminRelay] 📨 Admin escribe — conv #${pending?.conversation_id || 'sesión activa'}`);

    // ── Procesar con la secretaria (IA conversacional) ────────────────
    const result = await secretary.processAdminMessage(org.id, parsed.text, pending);

    if (!result) {
      await kapsoService.sendTextMessage(parsed.from, 'ℹ️ Sin conversación activa.', whatsappConfig).catch(() => {});
      return;
    }

    const { type, adminMessage, customerMessage, session } = result;

    // ── TAKEOVER: admin quiere atender directamente ───────────────────
    if (type === 'takeover') {
      const handoffMsg = 'En un momento alguien del equipo te escribe directamente 🙏';
      const sentHandoff = await kapsoService.sendTextMessage(session.customerPhone, handoffMsg, whatsappConfig).catch(() => null);
      if (sentHandoff) {
        const hMsg = await db.saveMessage({
          conversationId:    session.convId,
          whatsappMessageId: sentHandoff?.messages?.[0]?.id || null,
          direction:         'outbound',
          content:           handoffMsg,
          sentBy:            'ai',
          status:            'sent',
        });
        await db.updateConversationLastMessage(session.convId, handoffMsg);
        const hConv = await db.getConversationById(session.convId);
        io?.emit(`new_message_${org.id}`, { message: hMsg, conversation: hConv });
      }
      // Mantener human mode — el admin atiende desde acá o el CRM
      if (pending) await db.markAdminReplyHandled(pending.id);
      secretary.closeSession(org.id);

      await kapsoService.sendTextMessage(
        parsed.from,
        `${adminMessage}\n\nRespondé aquí para escribirle a *${session.customerName}*, o atiéndelo desde el CRM.`,
        whatsappConfig
      ).catch(() => {});
      return;
    }

    // ── ANSWER: el admin preguntó algo sobre el cliente — solo responderle a él ──
    if (type === 'answer') {
      await kapsoService.sendTextMessage(parsed.from, adminMessage, whatsappConfig).catch(() => {});
      // La sesión sigue abierta — el admin continúa la conversación
      return;
    }

    // ── SEND: enviar al cliente el mensaje generado ───────────────────
    const sentMsg = await kapsoService.sendTextMessage(session.customerPhone, customerMessage, whatsappConfig);

    const outMsg = await db.saveMessage({
      conversationId:    session.convId,
      whatsappMessageId: sentMsg?.messages?.[0]?.id || null,
      direction:         'outbound',
      content:           customerMessage,
      sentBy:            'ai',
      agentType:         'human_guided',
      status:            'sent',
    });
    await db.updateConversationLastMessage(session.convId, customerMessage);

    // Volver a modo IA y limpiar estado
    await db.setAgentMode(session.convId, 'ai');
    io?.emit(`agent_mode_changed_${org.id}`, { conversationId: session.convId, mode: 'ai' });
    if (pending) await db.markAdminReplyHandled(pending.id);
    secretary.closeSession(org.id);

    const finalConv = await db.getConversationById(session.convId);
    io?.emit(`new_message_${org.id}`, { message: outMsg, conversation: finalConv });

    // Confirmar al admin qué se mandó
    const preview = customerMessage.slice(0, 100);
    await kapsoService.sendTextMessage(
      parsed.from,
      `${adminMessage}\n\n📤 _"${preview}${customerMessage.length > 100 ? '...' : ''}"_\n\nEl bot retoma el hilo con *${session.customerName}*.`,
      whatsappConfig
    ).catch(() => {});

    // Avisar si hay otro cliente esperando
    const nextPending = await db.getLatestPendingAdminReply(org.id);
    if (nextPending) {
      const nextConv = await db.getConversationById(nextPending.conversation_id).catch(() => null);
      const nextName = nextConv?.contact_name || nextPending.customer_phone;
      await kapsoService.sendTextMessage(
        parsed.from,
        `📨 Hay otro cliente esperando: *${nextName}*\n"${nextPending.context || '(sin contexto)'}"\n\nRespondé cuando quieras.`,
        whatsappConfig
      ).catch(() => {});
    }

  } catch (err) {
    console.error('[AdminRelay] Error:', err.message);
  }
}

/**
 * Maneja una imagen entrante como posible comprobante de pago.
 * Guarda el comprobante, responde al cliente y notifica al admin.
 */
async function handlePaymentProof(org, whatsappConfig, parsed) {
  try {
    console.log(`[KapsoWebhook] 📸 Imagen de ${parsed.from} | mediaId: ${parsed.mediaId} — analizando con IA...`);

    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig).catch(() => {});

    // ── 1. Descargar imagen y analizar con Claude Vision ────────────
    // Kapso provee media_url directa en el webhook — usarla sin llamar getMediaUrl
    let analysis = { is_payment_proof: false };
    let data, contentType;
    const downloadUrl = parsed.mediaUrl; // URL directa de Kapso (preferred)
    pushDebug({ step: 'download_start', downloadUrl: downloadUrl?.slice(0, 80), mediaId: parsed.mediaId });
    try {
      if (downloadUrl) {
        ({ data, contentType } = await kapsoService.downloadMedia(downloadUrl, whatsappConfig));
      } else if (parsed.mediaId) {
        // Fallback: obtener URL a partir del media_id (más lento)
        const mediaInfo = await kapsoService.getMediaUrl(parsed.mediaId, whatsappConfig);
        ({ data, contentType } = await kapsoService.downloadMedia(mediaInfo.url, whatsappConfig));
      }
      pushDebug({ step: 'download_ok', bytes: data?.byteLength, contentType });
      if (data) {
        // Guardar en cache para que el proxy del browser pueda servirlo sin re-descargar
        const cacheKey = downloadUrl || parsed.mediaId;
        mediaCache.set(cacheKey, data, contentType);
        analysis = await analyzePaymentProof(data, contentType);
        console.log(`[KapsoWebhook] 🤖 Análisis IA:`, JSON.stringify(analysis));
      }
    } catch (aiErr) {
      pushDebug({ step: 'download_error', error: aiErr.message });
      console.warn('[KapsoWebhook] Error descargando/analizando imagen:', aiErr.message);
      // Si descarga o análisis falla, tratar como comprobante por seguridad
      analysis = { is_payment_proof: true, confidence: 'low' };
    }

    // Referencia de media: usar la URL directa de Active Storage (app.kapso.ai).
    // El proxy la descarga con X-API-Key desde Railway — funciona correctamente.
    // getMediaUrl(numericId) devuelve 404, así que no usamos el ID numérico.
    const mediaRef = downloadUrl || parsed.mediaId;
    pushDebug({ step: 'will_save', is_payment_proof: analysis.is_payment_proof, mediaRef: mediaRef?.slice(0, 80) });
    console.log(`[KapsoWebhook] 🔍 is_payment_proof=${analysis.is_payment_proof} | mediaRef=${mediaRef?.slice(0,60)}`);

    // ── 2. Si NO es comprobante → analizar con Vision y pasar al bot ────────
    if (!analysis.is_payment_proof) {
      await db.saveMessage({
        conversationId:    conversation.id,
        whatsappMessageId: parsed.messageId,
        direction:         'inbound',
        content:           '📷 [Imagen]',
        type:              'image',
        sentBy:            'client',
        mediaId:           mediaRef,
      });
      await db.updateConversationLastMessage(conversation.id, '📷 [Imagen]', true);
      await db.updateLastInbound(conversation.id);

      // Emitir al CRM inmediatamente — no esperar Vision ni pipeline
      const earlyConv = await db.getConversationById(conversation.id);
      io?.emit(`new_message_${org.id}`, {
        message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: mediaRef },
        conversation: earlyConv,
      });

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
          message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: mediaRef },
          conversation: updatedConv,
        });
        io?.emit(`new_message_${org.id}`, { message: outMsg, conversation: updatedConv });
      } else {
        const updatedConv = await db.getConversationById(conversation.id);
        io?.emit(`new_message_${org.id}`, {
          message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: mediaRef },
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
      mediaId:           mediaRef,
    });
    await db.updateConversationLastMessage(conversation.id, '📸 [Comprobante de pago]', true);
    await db.updateLastInbound(conversation.id);

    // Emitir al CRM inmediatamente — no esperar análisis ni notificaciones
    const earlyConv2 = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: '📸 [Comprobante de pago]', type: 'image', media_id: mediaRef },
      conversation: earlyConv2,
    });

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
      mediaId:            mediaRef,
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

    // ── 7b. Notificar a agentes con payments habilitado ──────────────
    const clientName  = conversation.contact_name || parsed.from;
    const amountStr   = analysis.amount ? `$${Number(analysis.amount).toLocaleString('es-CL')} ${analysis.currency || ''}` : null;
    notifyAgentsPayment(org.id, clientName, parsed.from, amountStr).catch(() => {});

    // ── 8. Emitir al CRM en tiempo real ─────────────────────────────
    const updatedConv = await db.getConversationById(conversation.id);
    io?.emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: '📸 [Comprobante de pago]', type: 'image', media_id: mediaRef },
      conversation: updatedConv,
    });
    io?.emit(`payment_proof_${org.id}`, { proof, conversationId: conversation.id });

  } catch (err) {
    console.error('[KapsoWebhook] Error procesando imagen:', err.message, err.stack?.split('\n')[1]);
  }
}

module.exports = router;
module.exports.setSocketIO = setSocketIO;
