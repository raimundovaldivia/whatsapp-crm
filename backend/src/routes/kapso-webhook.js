/**
 * kapso-webhook.js — Recibe mensajes entrantes de WhatsApp via Kapso
 *
 * Configura este webhook en app.kapso.ai:
 *   Tu número → Webhooks → Add webhook
 *   URL:    POST https://whatsapp-crm-api-production-f804.up.railway.app/kapso-webhook
 *   Events: whatsapp.message.received, whatsapp.message.sent, whatsapp.message.delivered, whatsapp.message.read, whatsapp.message.failed
 *   Habilita firma y copia el secret → guárdalo en KAPSO_WEBHOOK_SECRET
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
const adminRelay = require('../services/admin-relay');
const adminAssignment = require('../services/admin-assignment');
const delivery = require('../services/admin-delivery');
const { analyzePaymentProof }   = require('../services/analyzePaymentProof');
const { createBotLogger }       = require('../services/bot-logger');
const mediaCache                = require('../services/media-cache');
const staffIdentity = require('../services/staff-identity');
const guardrail                 = require('../services/response-guardrail');
const { notifyAdmin, markAdminWindowOpen, drainAdminOutbox } = require('../services/admin-notify');

let io;
function setSocketIO(socketIO) { io = socketIO; }

// Debounce and exclusion live in PostgreSQL streams. The worker persists
// each message in the batch before running its latest scheduled response.
function schedulePipeline(orgId, conversationId, fn) {
  require('../services/webhook-inbox').defer(orgId + ':' + conversationId, fn);
}

/**
 * POST /kapso-webhook
 * Kapso envía JSON; ya está parseado por express.json() en index.js
 */
router.post('/', require('../middleware/webhook-auth').verifyWebhook('kapso'), require('../services/webhook-inbox').durableWebhook('kapso', async (req, res) => {
  // Responder 200 inmediatamente (Kapso reintenta si no recibe respuesta rápida)
  res.sendStatus(200);

  const body = req.body;

  // En Kapso v2 el evento va en el HEADER X-Webhook-Event (no en el body)
  // Fallback a body.event por compatibilidad futura
  const event = req.headers['x-webhook-event'] || body?.event;

  const msgType = body?.message?.type || '—';
  console.log(`[KapsoWebhook] ← ${event || '(sin evento)'} | type:${msgType} | phone_number_id: ${body?.phone_number_id || '?'}`);

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

  // ── Actualizar estado de mensaje (delivered/read/failed) ─────────────
  const statusUpdate = kapsoService.parseStatusUpdate(body, event);
  if (statusUpdate) {
    const updated = await db.updateMessageStatus(statusUpdate.messageId, statusUpdate.status, statusUpdate.error, org.id);
    await delivery.receipt(org.id, statusUpdate);
    if (updated) io?.to(`org_${org.id}`).emit(`status_update_${org.id}`, { ...statusUpdate, error: updated.delivery_error });
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

  // Si quien escribe es un miembro del equipo (admin, coordinador, agente con
  // teléfono cargado), reabrir su ventana de 24h. Así el aviso preventivo de
  // cierre se mide por persona y sus respuestas por WhatsApp siguen entregándose.
  if (parsed.from) db.touchUserWaWindow(org.id, parsed.from).catch(() => {});

  // Registered staff always converse privately with the secretary, without a # prefix.
  const staff = await staffIdentity.resolve(org.id, parsed.from);
  if (staff) {
    if (staffIdentity.canAttend(staff)) {
      const adminPhone = await db.getSetting(org.id, 'admin_alert_phone');
      if (adminPhone && db.normalizePhone(adminPhone) === db.normalizePhone(parsed.from)) {
        await markAdminWindowOpen(org.id, whatsappConfig);
      } else {
        await drainAdminOutbox(org.id, whatsappConfig, parsed.from);
      }
    }
    await require('../services/staff-secretary').handle(org, whatsappConfig, parsed, io);
    return;
  }

  // An assigned conversation bypasses every automated reply, including media/payment flows.
  if (await adminRelay.receive(org, whatsappConfig, parsed, io)) return;

  // ── Imagen o documento-imagen entrante → posible comprobante de pago ────
  // WhatsApp puede enviar imágenes como type:'image' o type:'document' (PNG/JPG como archivo)
  if ((parsed.type === 'image' || parsed.type === 'document') && (parsed.mediaId || parsed.mediaUrl)) {
    await handlePaymentProof(org, whatsappConfig, parsed);
    return;
  }

  // ── Ubicación compartida → convertir a texto para el pipeline ────────
  // Antes un pin de Google Maps no generaba nada: ni respuesta ni registro.
  if (parsed.type === 'location' && parsed.location) {
    const addr = await reverseGeocode(parsed.location).catch(() => null);
    const label = addr
      || [parsed.location.name, parsed.location.address].filter(Boolean).join(', ')
      || `${parsed.location.lat.toFixed(5)}, ${parsed.location.lng.toFixed(5)}`;
    parsed.text = `📍 [Ubicación compartida: ${label}]`;
    console.log(`[KapsoWebhook] 📍 Ubicación de ${parsed.from} → ${label}`);
  }

  // ── Audio sin transcript → transcribir si hay OPENAI_API_KEY (Whisper) ──
  // Kapso ya transcribe si la opción está activa en su panel; esto es el
  // respaldo cuando no viene transcript.
  if (parsed.type === 'audio' && !parsed.text && await require('../services/commercial').permitted(org.id,'sales_ai') && process.env.OPENAI_API_KEY && (parsed.mediaUrl || parsed.mediaId)) {
    const transcript = await transcribeAudio(parsed, whatsappConfig).catch(e => {
      console.warn('[KapsoWebhook] transcripción falló:', e.message);
      return null;
    });
    if (transcript) parsed.text = `🎤 ${transcript}`;
  }

  // ── Audio (sin transcript) o video → avisar que no se puede procesar ──
  if ((parsed.type === 'audio' || parsed.type === 'video') && !parsed.text) {
    const isVideo   = parsed.type === 'video';
    const mediaRef  = parsed.mediaUrl || parsed.mediaId;
    const label     = isVideo ? '🎥 [Video]' : '🎤 [Audio]';
    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});
    await db.saveMessage({
      conversationId:    conversation.id,
      whatsappMessageId: parsed.messageId,
      direction:         'inbound',
      content:           label,
      type:              parsed.type,
      sentBy:            'client',
      mediaId:           mediaRef,
    });
    await db.updateConversationLastMessage(conversation.id, label, true);
    await db.updateLastInbound(conversation.id);
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig).catch(() => {});
    // En modo humano el ejecutivo lo ve en el CRM — no contestar encima
    if (!await require('../services/commercial').permitted(org.id,'sales_ai') || (conversation.agent_mode && conversation.agent_mode !== 'ai')) {
      const updatedConv = await db.getConversationById(conversation.id);
      io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: { conversationId: conversation.id, direction: 'inbound', content: label, type: parsed.type, media_id: mediaRef }, conversation: updatedConv });
      return;
    }
    const reply = isVideo
      ? 'Recibí tu video, pero no puedo verlo por aquí 😊 ¿Me cuentas por escrito qué necesitas?'
      : '¡Hola! No puedo escuchar audios 😊 ¿Puedes escribirme lo que necesitas?';
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
    io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: label, type: parsed.type, media_id: mediaRef },
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
    io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: savedMsg, conversation: updatedConv });

    // 3b. Notificar a agentes con new_messages habilitado (sin await para no bloquear)
    notifyAgentsNewMessage(org.id, updatedConv, parsed.text).catch(() => {});

    // Manual attention never expires back to AI. Notify even after an old/closed case.
    if (updatedConv.agent_mode !== 'ai') {
      await require('../services/human-attention').incoming(org.id, updatedConv, parsed.text);
      return;
    }

    // 5. Debounce: esperar 3s desde el ÚLTIMO mensaje antes de ejecutar pipeline.
    //    Si el cliente manda varios mensajes rápidos, solo se procesa el último.
    const capturedText  = parsed.text;
    const capturedFrom  = parsed.from;
    const capturedConvId = conversation.id;

    schedulePipeline(org.id, capturedConvId, async () => {
      const current = await db.getConversationById(capturedConvId);
      if (!current || current.agent_mode !== 'ai') return;
      const log = createBotLogger(org.name, capturedFrom);
      // Leer de la DB los mensajes del cliente que llegaron seguidos (pueden ser
      // varios durante el debounce: "Buenas tardes" + "¿Mañana reparten?").
      // Se procesan JUNTOS como un solo texto — así el bot responde una vez a
      // la pregunta real y no una vez al saludo y otra a la pregunta.
      // OJO: getLastMessages() devuelve orden ASCENDENTE (más antiguo primero).
      const lastMessages = await db.getLastMessages(capturedConvId, 10).catch(() => []);
      let trailing = [];
      for (const m of (lastMessages || [])) {
        if (m.direction === 'inbound') trailing.push(m); else trailing = [];
      }
      // Solo los de los últimos 2 minutos: lo anterior ya tuvo su turno (o el
      // bot estaba en modo humano y no corresponde reprocesarlo).
      const recentCut = Date.now() - 2 * 60 * 1000;
      trailing = trailing.filter(m => !m.created_at || new Date(m.created_at).getTime() >= recentCut);
      const lastInbound = trailing[trailing.length - 1];
      // Red de seguridad: si por lo que sea el inbound recuperado es anterior al mensaje
      // que disparó este pipeline, usar el texto capturado en el webhook.
      const inboundIsStale = lastInbound && savedMsg?.created_at
        && new Date(lastInbound.created_at).getTime() < new Date(savedMsg.created_at).getTime();
      const merged = trailing.map(m => String(m.content || '').trim()).filter(Boolean).join('\n');
      const textToProcess = (!inboundIsStale && merged) || capturedText;
      if (trailing.length > 1) console.log(`[KapsoWebhook] 🧩 ${trailing.length} mensajes seguidos de ${capturedFrom} se procesan juntos`);
      log.in(textToProcess);

      try {
        io?.to(`org_${org.id}`).emit(`bot_typing_${org.id}`, { conversationId: capturedConvId, typing: true });
        const tPipeline = Date.now();
        const result = await pipeline.processMessage(org.id, capturedConvId, textToProcess, log);
        io?.to(`org_${org.id}`).emit(`bot_typing_${org.id}`, { conversationId: capturedConvId, typing: false });

        if (result.skipped) { log.done(); return; }
        const activeAssignment = await adminAssignment.forConversation(org.id, capturedConvId);
        if (activeAssignment?.conversation_id === capturedConvId) { log.done(); return; }
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

        // ── Guardrail de frescura ──────────────────────────────────────────
        // Último filtro antes de enviar: si el mensaje le afirma al cliente algo
        // que la DB no respalda (una fecha que ya pasó, un pedido cerrado o
        // estancado), no sale. El bot no se equivoca al razonar — se equivoca
        // porque le pasamos un dato viejo. Ante eso, mejor que hable un humano.
        // Acuse al cliente cuando el bot pausa y pasa el hilo al equipo.
        // Antes el cliente recibía silencio; si nadie respondía, se quedaba
        // así para siempre. Ahora: acuse inmediato + recordatorio si el equipo
        // tarda (escalation-watch.js) + vuelta al bot a las 24 h.
        const escalateWithAck = async (ackText, reason, botWasGoingToSay) => {
          await db.setAgentMode(capturedConvId, 'human');
          await db.setLastEscalation(capturedConvId, textToProcess, reason).catch(() => {});
          io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: capturedConvId, mode: 'human' });
          notifyAdminHelp(org.id, updatedConv || conversation, botWasGoingToSay, reason).catch(() => {});

          let ackSent = null;
          try {
            ackSent = await kapsoService.sendTextMessage(capturedFrom, ackText, whatsappConfig);
          } catch (e) {
            if (!e.is24hWindow) console.warn('[KapsoWebhook] no se pudo enviar acuse de escalación:', e.message);
          }
          const ackMsg = await db.saveMessage({
            conversationId:    capturedConvId,
            whatsappMessageId: ackSent?.messages?.[0]?.id || null,
            direction:         'outbound',
            content:           ackText,
            sentBy:            'ai',
            agentType:         'orchestrator',
            status:            ackSent ? 'sent' : 'failed',
          });
          await db.updateConversationLastMessage(capturedConvId, ackText);
          const convNow = await db.getConversationById(capturedConvId);
          io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: ackMsg, conversation: convNow });
        };

        if (!result.switchToHuman) {
          const fresh = await guardrail.checkResponseFreshness(org.id, capturedConvId, result.response, {
            orderCreated: result.orderCreated, orderUpdated: result.orderUpdated,
          });
          if (!fresh.ok) {
            console.error(`[KapsoWebhook] ⛔ Dato rancio (${fresh.reason}) para ${capturedFrom}: ${fresh.detail}`);
            log.step('guardrail', `bloqueado: ${fresh.reason}`);
            await escalateWithAck(
              'Déjame revisar esto con el equipo para darte la información correcta y te escribo por aquí 🙏',
              `Dato desactualizado — ${fresh.detail}`,
              result.response
            );
            log.done();
            return;
          }

          // El bot prometió "consultar con el equipo y confirmar" pero la
          // pipeline no escaló → esa promesa no le llega a nadie. La
          // convertimos en escalación real: se avisa al admin y la
          // conversación pasa a humano, usando el mismo texto como acuse.
          if (guardrail.promisesTeamFollowup(result.response)) {
            log.step('promise_escalate', 'el bot prometió consultar con el equipo → escalando de verdad');
            await escalateWithAck(
              result.response,
              result.escalationReason || 'El bot le dijo al cliente que consultaría algo con el equipo',
              result.response
            );
            log.done();
            return;
          }
        }

        if (result.switchToHuman) {
          const reason = result.escalationReason || 'Necesita validación del ejecutivo';
          const ack = result.response || 'Déjame consultarlo con el equipo y te confirmo por aquí 🙏';
          await escalateWithAck(ack, reason, result.response);
          log.step('switchToHuman', `admin consultado — conv ${capturedConvId} en pausa, cliente avisado`);
          log.done();
          return;
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
            io?.to(`org_${org.id}`).emit(`window_expired_${org.id}`, { conversationId: capturedConvId, phone: capturedFrom });
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
          io?.to(`org_${org.id}`).emit(`order_created_${org.id}`, {
            conversationId: capturedConvId,
            order: result.orderCreated,
          });
        }
        // Aviso al admin como copia (el bot sigue atendiendo, no pasa a modo humano)
        if (result.adminNotice) {
          notifyAdmin(org.id, { body: result.adminNotice, kind: 'order', conversationId: capturedConvId }).catch(() => {});
        }
        if (result.orderUpdated || result.orderCancelled) {
          const ev = result.orderUpdated ? 'modificó' : 'canceló';
          const oid = (result.orderUpdated || result.orderCancelled).orderId;
          io?.to(`org_${org.id}`).emit(`order_updated_${org.id}`, { conversationId: capturedConvId, orderId: oid, event: result.orderUpdated ? 'updated' : 'cancelled' });
          const who = (updatedConv || conversation).contact_name || capturedFrom;
          const shopifyNote = result.orderUpdated?.shopifyDraftId ? '\n⚠️ Este pedido tiene Draft Order en Shopify — ajústalo allá también.' : '';
          notifyAdmin(org.id, {
            body: `✏️ *${who}* ${ev} su pedido #${oid} desde WhatsApp.${shopifyNote}\n\nRevísalo en el CRM → Pedidos.`,
            kind: 'order',
            conversationId: capturedConvId,
          }).catch(() => {});
        }

        const finalConv = await db.getConversationById(capturedConvId);
        io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: outMsg, conversation: finalConv });

        log.done();

      } catch (err) {
        io?.to(`org_${org.id}`).emit(`bot_typing_${org.id}`, { conversationId: capturedConvId, typing: false });
        if (err.response) {
          log.error('HTTP', new Error(`${err.response.status} ${err.config?.url} — ${JSON.stringify(err.response.data)}`));
        } else {
          log.error('pipeline', err);
        }
        log.done();
        throw err;
      }
    });

  } catch (outerErr) {
    console.error('[KapsoWebhook] Error procesando mensaje entrante:', outerErr.message);
    throw outerErr;
  }
}));

/**
 * Maneja respuestas del admin desde su WhatsApp personal.
 * Cuando el admin responde, su mensaje se reenvía al cliente pendiente más reciente.
 */
async function handlePaymentProof(org, whatsappConfig, parsed) {
  try {
    const commercial = require('../services/commercial');
    const payments = await commercial.permitted(org.id,'payments');
    const sales = await commercial.permitted(org.id,'sales_ai');
    if (!payments && !sales) {
      const conversation = await db.upsertConversation(org.id,parsed.from,parsed.contactName);
      const message = await db.saveMessage({conversationId:conversation.id,whatsappMessageId:parsed.messageId,direction:'inbound',content:'📷 [Imagen]',type:'image',sentBy:'client',mediaId:parsed.mediaUrl || parsed.mediaId});
      await db.updateConversationLastMessage(conversation.id,'📷 [Imagen]',true);
      await db.updateLastInbound(conversation.id);
      io?.to(`org_${org.id}`).emit(`new_message_${org.id}`,{message,conversation:await db.getConversationById(conversation.id)});
      return;
    }
    console.log(`[KapsoWebhook] 📸 Imagen de ${parsed.from} | mediaId: ${parsed.mediaId} — analizando con IA...`);

    const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName);
    db.touchLead(org.id, parsed.from, parsed.contactName).catch(() => {});
    await kapsoService.markAsRead(parsed.messageId, whatsappConfig).catch(() => {});

    // ── 1. Descargar imagen y analizar con Claude Vision ────────────
    // Kapso provee media_url directa en el webhook — usarla sin llamar getMediaUrl
    let analysis = { is_payment_proof: false };
    let data, contentType;
    const downloadUrl = parsed.mediaUrl; // URL directa de Kapso (preferred)
    try {
      if (downloadUrl) {
        ({ data, contentType } = await kapsoService.downloadMedia(downloadUrl, whatsappConfig));
      } else if (parsed.mediaId) {
        // Fallback: obtener URL a partir del media_id (más lento)
        const mediaInfo = await kapsoService.getMediaUrl(parsed.mediaId, whatsappConfig);
        ({ data, contentType } = await kapsoService.downloadMedia(mediaInfo.url, whatsappConfig));
      }
      if (data) {
        // Guardar en cache para que el proxy del browser pueda servirlo sin re-descargar
        const cacheKey = downloadUrl || parsed.mediaId;
        mediaCache.set(org.id + ':' + cacheKey, data, contentType);
        if (payments) analysis = await analyzePaymentProof(data, contentType);
        console.log(`[KapsoWebhook] 🤖 Análisis IA:`, JSON.stringify(analysis));
      }
    } catch (aiErr) {
      console.warn('[KapsoWebhook] Error descargando/analizando imagen:', aiErr.message);
      // Si descarga o análisis falla, tratar como comprobante por seguridad
      analysis = { is_payment_proof: true, confidence: 'low' };
    }

    // Referencia de media: usar la URL directa de Active Storage (app.kapso.ai).
    // El proxy la descarga con X-API-Key desde Railway — funciona correctamente.
    // getMediaUrl(numericId) devuelve 404, así que no usamos el ID numérico.
    const mediaRef = downloadUrl || parsed.mediaId;
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
      io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, {
        message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: mediaRef },
        conversation: earlyConv,
      });

      if (!sales) return;
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
      io?.to(`org_${org.id}`).emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: true });
      let imgResult;
      try {
        imgResult = await pipeline.processMessage(org.id, conversation.id, imageContext, imgLog);
      } finally {
        io?.to(`org_${org.id}`).emit(`bot_typing_${org.id}`, { conversationId: conversation.id, typing: false });
      }

      if (imgResult && !imgResult.duplicate && !imgResult.skipped && imgResult.response) {
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
        io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, {
          message: { conversationId: conversation.id, direction: 'inbound', content: '📷 [Imagen]', type: 'image', media_id: mediaRef },
          conversation: updatedConv,
        });
        io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: outMsg, conversation: updatedConv });
      } else {
        const updatedConv = await db.getConversationById(conversation.id);
        io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, {
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
    io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: '📸 [Comprobante de pago]', type: 'image', media_id: mediaRef },
      conversation: earlyConv2,
    });

    // ── 4. Elegir el pedido al que corresponde el comprobante ─────────
    // Match against the remaining documented balance. Ambiguous orders need review.
    const candidates = await db.getOrdersAwaitingPayment(conversation.id).catch(() => []);
    const { positiveAmount, getOrderProofBalance, balanceText } = require('../services/payment-proof-balance');
    const balances = new Map();
    for (const candidate of candidates) {
      balances.set(candidate.id, await getOrderProofBalance(org.id, candidate.id, candidate.total_price));
    }
    const paidCents = positiveAmount(analysis.amount);
    const paidAmt = paidCents === null ? NaN : paidCents / 100;
    let pendingOrder = null;
    if (!isNaN(paidAmt)) {
      const matching = candidates.filter(o => balances.get(o.id).remaining > 0
        && Math.abs(balances.get(o.id).remaining - paidAmt) <= 1);
      if (matching.length === 1) pendingOrder = matching[0];
    }
    if (!pendingOrder && candidates.length === 1) pendingOrder = candidates[0];
    const wasDelivered = !!pendingOrder && pendingOrder.status === 'entregado';

    let amountMatches  = null;
    let proofStatus    = 'pending';

    if (!isNaN(paidAmt) && pendingOrder?.total_price) {
      const orderAmt = Number(pendingOrder.total_price);
      if (!isNaN(orderAmt)) {
        // A partial payment is pending coverage, not an amount discrepancy.
        amountMatches = Math.abs(orderAmt - paidAmt) <= 1 ? true : paidAmt > orderAmt ? false : null;
        // Cumulative receipts remain pending bank review; matching an image is not settlement.
        proofStatus = amountMatches && !balances.get(pendingOrder.id).count
          && analysis.confidence === 'high' && analysis.currency === 'CLP' ? 'pre_verified' : 'pending';
        console.log(`[KapsoWebhook] 💰 Pedido #${pendingOrder.id} (${pendingOrder.status}) $${orderAmt} | Pagado: $${paidAmt} | Match: ${amountMatches}`);
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
      extractedAmount:    Number.isFinite(paidAmt) ? paidAmt : null,
      extractedDate:      analysis.date      || null,
      extractedBank:      analysis.bank      || null,
      extractedReference: analysis.reference || null,
      aiConfidence:       analysis.confidence || null,
      amountMatches,
      status:             proofStatus,
      imageSha256:        data ? require('crypto').createHash('sha256').update(Buffer.from(data)).digest('hex') : null,
      extractedCurrency:  typeof analysis.currency === 'string' ? analysis.currency.trim().toUpperCase() : null,
    });

    const balance = pendingOrder
      ? await getOrderProofBalance(org.id, pendingOrder.id, pendingOrder.total_price) : null;

    // Actualizar estado del pedido. Un pedido YA ENTREGADO no retrocede a
    // "pago recibido": se queda en entregado y el comprobante pre_verified lo
    // saca de "Por cobrar" (la conciliación con la cartola lo pasa a pagado).
    if (pendingOrder && !wasDelivered && proofStatus === 'pre_verified') {
      await db.updateOrder(pendingOrder.id, { status: 'payment_received' }).catch(() => {});
    }

    // ── 6. Responder al cliente ──────────────────────────────────────
    const firstName = (conversation.contact_name || parsed.contactName || '').trim().split(/\s+/)[0] || '';
    const hi = firstName ? ` ${firstName}` : '';
    let reply;
    if (balance) {
      reply = `✅ Comprobante recibido${hi} para tu pedido #${pendingOrder.id}. ${balanceText(balance)}`;
    } else {
      reply = `✅ Recibimos tu comprobante${hi}. El equipo revisará a qué pedido corresponde y te confirmará por aquí.`;
    }

    const sentMsg = await kapsoService.sendTextMessage(parsed.from, reply, whatsappConfig).catch(() => null);
    await db.saveMessage({
      conversationId: conversation.id, whatsappMessageId: sentMsg?.messages?.[0]?.id || null,
      direction: 'outbound', content: reply, sentBy: 'ai', agentType: 'system',
    });
    await db.updateConversationLastMessage(conversation.id, reply);

    // ── 7. Notificar al admin (con cola si la ventana está cerrada) ───
    {
      const clientName  = conversation.contact_name || parsed.from;
      const orderLine   = pendingOrder
        ? `\n📦 *Pedido:* #${pendingOrder.id} ${pendingOrder.customer_name || ''} — $${Number(pendingOrder.total_price || 0).toLocaleString('es-CL')}${wasDelivered ? ' (ya entregado — cobranza)' : ''}`
        : '\n📦 *Pedido:* no encontré uno pendiente para este cliente';
      const amountLine  = analysis.amount  ? `\n💵 *Monto pagado:* $${analysis.amount?.toLocaleString('es-CL')} ${analysis.currency || ''}` : '';
      const bankLine    = analysis.bank    ? `\n🏦 *Banco:* ${analysis.bank}` : '';
      const matchLine = balance ? `\n📊 ${balanceText(balance)}` : '\nPedido por identificar.';
      const adminMsg = `📸 *Comprobante de pago recibido*\n\n👤 *Cliente:* ${clientName} (${parsed.from})${orderLine}${amountLine}${bankLine}${matchLine}\n\nRevísalo en el CRM → Pagos.`;
      notifyAdmin(org.id, { body: adminMsg, kind: 'payment', conversationId: conversation.id })
        .catch(() => {});
    }

    // ── 7b. Notificar a agentes con payments habilitado ──────────────
    const clientName  = conversation.contact_name || parsed.from;
    const amountStr   = analysis.amount ? `$${Number(analysis.amount).toLocaleString('es-CL')} ${analysis.currency || ''}` : null;
    notifyAgentsPayment(org.id, clientName, parsed.from, amountStr).catch(() => {});

    // ── 8. Emitir al CRM en tiempo real ─────────────────────────────
    const updatedConv = await db.getConversationById(conversation.id);
    io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, {
      message: { conversationId: conversation.id, direction: 'inbound', content: '📸 [Comprobante de pago]', type: 'image', media_id: mediaRef },
      conversation: updatedConv,
    });
    io?.to(`org_${org.id}`).emit(`payment_proof_${org.id}`, { proof, conversationId: conversation.id });

  } catch (err) {
    console.error('[KapsoWebhook] Error procesando imagen:', err.message, err.stack?.split('\n')[1]);
    throw err;
  }
}

/**
 * Ubicación → dirección legible con la Geocoding API de Google (la misma key
 * que usa la optimización de rutas). Sin key devuelve null y se usa lo que
 * mandó WhatsApp (nombre/dirección del lugar) o las coordenadas.
 */
async function reverseGeocode({ lat, lng }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const axios = require('axios');
  const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: { latlng: `${lat},${lng}`, key: apiKey, language: 'es', region: 'cl' },
    timeout: 8000,
  });
  if (data?.status !== 'OK' || !data.results?.length) return null;
  // Preferir el resultado con número de calle; quitar el país del final
  const best = data.results.find(r => r.types?.includes('street_address')) || data.results[0];
  return (best.formatted_address || '').replace(/,\s*Chile$/i, '').trim() || null;
}

/**
 * Transcribe un audio de WhatsApp con Whisper (OpenAI). Solo se usa si hay
 * OPENAI_API_KEY y Kapso no entregó transcript. Node 18+ trae fetch/FormData/Blob.
 */
async function transcribeAudio(parsed, whatsappConfig) {
  let data, contentType;
  if (parsed.mediaUrl) {
    ({ data, contentType } = await kapsoService.downloadMedia(parsed.mediaUrl, whatsappConfig));
  } else {
    const info = await kapsoService.getMediaUrl(parsed.mediaId, whatsappConfig);
    ({ data, contentType } = await kapsoService.downloadMedia(info.url, whatsappConfig));
  }
  if (!data) return null;
  const ext = /mpeg|mp3/.test(contentType || '') ? 'mp3' : /ogg|opus/.test(contentType || '') ? 'ogg' : /mp4|m4a|aac/.test(contentType || '') ? 'm4a' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(data)], { type: contentType || 'audio/ogg' }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}`);
  const json = await res.json();
  const text = (json.text || '').trim();
  return text || null;
}

module.exports = router;
module.exports.setSocketIO = setSocketIO;
