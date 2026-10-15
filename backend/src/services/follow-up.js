/**
 * follow-up.js — Recupera conversaciones abandonadas dentro de la ventana de 24h
 *
 * Corre cada 30 minutos. Detecta clientes que mostraron interés pero dejaron
 * de responder. Genera mensajes humanos con el proveedor conversacional y los
 * envía gratis (dentro de la ventana de 24h de WhatsApp).
 *
 * NUNCA menciona "ventana", "bot", "sistema" ni nada técnico al cliente.
 * Suena como alguien de la tienda que se acordó del cliente.
 */

const { client, modelFor, responseText } = require('./ai-provider');
const db               = require('../db/database');
const whatsappProvider = require('./whatsapp-provider');
const {
  isCustomerMessagingHour,
  shouldSkipAutomatedFollowUp,
} = require('./outbound-policy');
const salesClosing = require('./sales-closing');
const personalOffers = require('./personal-offers');

const FOLLOW_UP_PROMPT = `Eres alguien que trabaja en una tienda y vas a escribirle a un cliente que estaba interesado pero dejó de responder.

CONTEXTO DE LA TIENDA: {STORE_CONTEXT}

ÚLTIMOS MENSAJES DE LA CONVERSACIÓN:
{HISTORIAL}

ESTADO DEL PEDIDO EN PROGRESO: {ORDER_DRAFT}

HORA CHILENA ACTUAL: {HORA}

Tu tarea: escribe UN solo mensaje de WhatsApp para retomar la conversación.

REGLAS CRÍTICAS:
- Máximo 2 líneas
- Tono casual y cálido, como un amigo del negocio
- Referencia algo específico de la conversación (el producto que vio, su nombre si lo sabes, etc.)
- NUNCA inventes stock limitado, urgencia, fechas de entrega ni eventos especiales que no sabes si son reales
- NUNCA menciones "ventana de chat", "bot", "sistema", "recordatorio automático" ni nada técnico
- NUNCA seas genérico: "Hola, ¿necesitas ayuda?" está PROHIBIDO
- Usa emojis con moderación (1-2 máximo)
- Este proceso solo se ejecuta entre las 09:00 y las 20:59 hora de Chile
- Si el cliente dijo que no necesita por ahora, que comprará cuando pueda o ya se cerró la conversación, devuelve exactamente: SKIP
- Si el cliente ya confirmó pedido, devuelve exactamente: SKIP

Solo el mensaje, nada más. Sin comillas.`;

async function generateFollowUpMessage(conv, history, storeContext) {
  const orderDraft = (() => { try { return JSON.parse(conv.order_draft || '{}'); } catch { return {}; } })();
  const draftStr = Object.keys(orderDraft).length > 0
    ? JSON.stringify(orderDraft)
    : 'Ninguno — el cliente mostró interés pero no llegó a dar datos';

  const historialStr = history
    .slice(-6)
    .map(m => `${m.direction === 'inbound' ? `${conv.contact_name || 'Cliente'}` : 'Nosotros'}: ${m.content}`)
    .join('\n');

  const hora = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });

  const system = FOLLOW_UP_PROMPT
    .replace('{STORE_CONTEXT}', storeContext || 'Tienda online, productos de calidad.')
    .replace('{HISTORIAL}', historialStr || 'Sin mensajes previos')
    .replace('{ORDER_DRAFT}', draftStr)
    .replace('{HORA}', hora);

  const response = await client.messages.create({
    model:      modelFor('fast'),
    max_tokens: 120,
    system,
    messages:   [{ role: 'user', content: 'Genera el mensaje de seguimiento.' }],
  });

  const text = responseText(response);
  return text;
}

async function runFollowUp(io = null, now = new Date(), options = {}) {
  let sent = 0, skipped = 0;

  try {
    if (!isCustomerMessagingHour(now)) {
      console.log('[FollowUp] Fuera del horario 09:00-20:59 de Chile — no se enviarán mensajes');
      return { sent, skipped, reason: 'outside_customer_hours' };
    }

    const stalled = await db.getStalledConversations({
      organizationId: options.organizationId || null,
      minIdleHours: options.minIdleHours || 4,
      maxIdleHours: options.maxIdleHours || 20,
    });
    if (!stalled.length) return { sent, skipped };

    console.log(`[FollowUp] 🔍 ${stalled.length} conversación(es) abandonada(s) encontradas`);

    for (const conv of stalled) {
      if (!await require('./commercial').permitted(conv.organization_id,'marketing')) continue;
      try {
        // Obtener historial y configuración de la org
        const history      = await db.getLastMessages(conv.id, 8);
        const storeContext = await db.getSetting(conv.organization_id, 'store_context') || '';

        if (shouldSkipAutomatedFollowUp(history)) {
          console.log(`[FollowUp] SKIP conv ${conv.id}: el cliente postergó o el hilo ya fue cerrado`);
          await db.updatePipelineState(conv.id, 'future_interest').catch(() => {});
          await db.updateFollowUpSent(conv.id).catch(() => {});
          skipped++;
          continue;
        }

        // Generar mensaje con IA
        const message = await generateFollowUpMessage(conv, history, storeContext);

        // Claude a veces devuelve "SKIP (explicación...)" en vez de solo "SKIP" — normalizar
        if (!message || message.trim().toUpperCase().startsWith('SKIP')) {
          console.log(`[FollowUp] SKIP conv ${conv.id} (${conv.contact_name})`);
          skipped++;
          continue;
        }

        // Obtener config de WhatsApp de la org
        const whatsappConfig = await whatsappProvider.configForConversation(conv.organization_id, conv);
        if (!whatsappConfig) {
          console.warn(`[FollowUp] Sin WhatsApp config para org ${conv.organization_id}`);
          continue;
        }

        // Enviar el mensaje
        const providerResult = await whatsappProvider.sendTextMessage(conv.phone_number, message, whatsappConfig);

        // Guardar en DB y marcar follow-up enviado
        await db.saveMessage({
          conversationId:    conv.id,
          whatsappMessageId: whatsappProvider.messageId(providerResult),
          direction:         'outbound',
          content:           message,
          sentBy:            'ai',
          agentType:         'follow_up',
        });
        await db.updateConversationLastMessage(conv.id, message, false);
        await db.updateFollowUpSent(conv.id);

        // Notificar al panel en tiempo real
        if (io) {
          const updatedConv = await db.getConversationById(conv.id);
          io.to(`org_${conv.organization_id}`).emit(`new_message_${conv.organization_id}`, {
            message:      { conversationId: conv.id, direction: 'outbound', content: message, agentType: 'follow_up' },
            conversation: updatedConv,
          });
        }

        console.log(`[FollowUp] ✅ Mensaje enviado a ${conv.contact_name} (${conv.phone_number}): "${message.slice(0, 60)}..."`);
        sent++;

        // Pausa entre envíos para no saturar la API
        await new Promise(r => setTimeout(r, 1500));

      } catch (convErr) {
        console.error(`[FollowUp] Error procesando conv ${conv.id}:`, convErr.message);
      }
    }

    if (sent > 0 || skipped > 0) {
      console.log(`[FollowUp] ✅ Resumen: ${sent} enviados, ${skipped} saltados`);
    }

  } catch (err) {
    console.error('[FollowUp] Error general:', err.message);
  }

  return { sent, skipped };
}

/**
 * Seguimiento corto y determinístico para conversaciones con intención real de
 * compra. Solo opera antes de las 13:00, dentro de la ventana de 24 horas, y
 * reclama cada etapa atómicamente para no duplicar mensajes entre instancias.
 */
async function runHotClosingFollowUp(io = null, now = new Date()) {
  let sent = 0, skipped = 0;
  if (!salesClosing.isHotClosingHour(now)) {
    return { sent, skipped, reason: 'outside_hot_closing_hours' };
  }

  const candidates = await db.getHotClosingCandidates(now);
  for (const candidate of candidates) {
    try {
      if (!await require('./commercial').permitted(candidate.organization_id, 'marketing')) {
        skipped++;
        continue;
      }
      const policy = salesClosing.sameDayPolicy({
        now,
        startedAt: candidate.sales_started_at,
        holdUntil: candidate.same_day_hold_until,
      });
      // Desde las 12:50 solo continuamos cierres que ya tenían reserva.
      if (!policy.offerOpen && !policy.canContinueSameDay) {
        skipped++;
        continue;
      }

      const history = await db.getLastMessages(candidate.id, 10);
      if (shouldSkipAutomatedFollowUp(history)) {
        await db.updatePipelineState(candidate.id, 'future_interest').catch(() => {});
        skipped++;
        continue;
      }

      const contact = await db.getContact(candidate.organization_id, candidate.phone_number).catch(() => null);
      if (contact?.opt_out) {
        skipped++;
        continue;
      }

      const whatsappConfig = await whatsappProvider.configForConversation(candidate.organization_id, candidate);
      if (!whatsappConfig) {
        skipped++;
        continue;
      }

      const stage = salesClosing.closingStage(candidate);
      const claimed = await db.claimHotClosingFollowUp(candidate.organization_id, candidate.id, stage);
      if (!claimed) {
        skipped++;
        continue;
      }

      const message = salesClosing.buildHotFollowUpMessage({ ...candidate, ...claimed }, now);
      const providerResult = await whatsappProvider.sendTextMessage(candidate.phone_number, message, whatsappConfig);
      const saved = await db.saveMessage({
        conversationId: candidate.id,
        whatsappMessageId: whatsappProvider.messageId(providerResult),
        direction: 'outbound',
        content: message,
        sentBy: 'ai',
        agentType: 'hot_closing_follow_up',
      });
      await db.updateConversationLastMessage(candidate.id, message, false);
      sent++;

      if (io) {
        const updatedConversation = await db.getConversationById(candidate.id, candidate.organization_id);
        io.to(`org_${candidate.organization_id}`).emit(`new_message_${candidate.organization_id}`, {
          message: saved || { conversationId: candidate.id, direction: 'outbound', content: message, agentType: 'hot_closing_follow_up' },
          conversation: updatedConversation,
        });
      }
    } catch (error) {
      console.error(`[HotClosing] Error en conversación ${candidate.id}:`, error.message);
    }
  }
  return { sent, skipped };
}

async function runPersonalOfferFollowUp(io = null, now = new Date(), options = {}) {
  let sent = 0, skipped = 0;
  if (!isCustomerMessagingHour(now)) return { sent, skipped, reason: 'outside_customer_hours' };

  try {
    const candidates = await db.getPersonalOfferCandidates({
      organizationId: options.organizationId || null,
      minIdleHours: options.minIdleHours || 18,
      maxIdleHours: options.maxIdleHours || 23,
      limit: options.limit || 100,
    });
    for (const candidate of candidates) {
      let claimed = null;
      try {
        if (!await require('./commercial').permitted(candidate.organization_id, 'marketing')) {
          skipped++;
          continue;
        }
        const history = await db.getLastMessages(candidate.id, 10);
        if (shouldSkipAutomatedFollowUp(history)) {
          skipped++;
          continue;
        }
        const contact = await db.getContact(candidate.organization_id, candidate.phone_number).catch(() => null);
        if (contact?.opt_out) {
          skipped++;
          continue;
        }
        const discountTiers = personalOffers.safeTiers(candidate);
        if (!discountTiers) {
          console.warn(`[PersonalOffer] Sin margen suficiente para conversación ${candidate.id}`);
          skipped++;
          continue;
        }
        const validHours = Number(await db.getSetting(candidate.organization_id, 'personal_offer_valid_hours')) || personalOffers.DEFAULT_VALID_HOURS;
        claimed = await db.claimPersonalOffer({
          organizationId: candidate.organization_id,
          conversationId: candidate.id,
          inboundAnchor: candidate.last_inbound_at,
          discountAmount: discountTiers.at(-1).amount,
          discountTiers,
          minTrays: personalOffers.DEFAULT_MIN_TRAYS,
          unitCost: Number(candidate.unit_cost) || personalOffers.DEFAULT_UNIT_COST,
          minMarginPct: Number(candidate.min_margin_pct) || personalOffers.DEFAULT_MIN_MARGIN_PCT,
          expiresAt: personalOffers.expiryFrom(now, validHours),
          priceReasonSource: candidate.price_reason_source,
          priceReasonConfidence: candidate.price_reason_confidence,
        });
        if (!claimed) {
          skipped++;
          continue;
        }

        const whatsappConfig = await whatsappProvider.configForConversation(candidate.organization_id, candidate);
        if (!whatsappConfig) throw new Error('Sin configuración de WhatsApp');
        const message = personalOffers.buildMessage(claimed, candidate);
        const providerResult = await whatsappProvider.sendTextMessage(candidate.phone_number, message, whatsappConfig);
        const saved = await db.saveMessage({
          conversationId: candidate.id,
          whatsappMessageId: whatsappProvider.messageId(providerResult),
          direction: 'outbound',
          content: message,
          sentBy: 'ai',
          agentType: 'personal_offer_follow_up',
        });
        await db.updateConversationLastMessage(candidate.id, message, false);
        await db.markPersonalOfferSent(candidate.organization_id, claimed.id, saved?.id || null);
        sent++;

        if (io) {
          const updatedConversation = await db.getConversationById(candidate.id, candidate.organization_id);
          io.to(`org_${candidate.organization_id}`).emit(`new_message_${candidate.organization_id}`, {
            message: saved || { conversationId: candidate.id, direction: 'outbound', content: message, agentType: 'personal_offer_follow_up' },
            conversation: updatedConversation,
          });
        }
      } catch (error) {
        if (claimed?.id) await db.markPersonalOfferFailed(candidate.organization_id, claimed.id, error.message).catch(() => null);
        console.error(`[PersonalOffer] Error en conversación ${candidate.id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PersonalOffer] Error general:', error.message);
  }
  return { sent, skipped };
}

/**
 * Inicia el job de follow-up con intervalo de 30 minutos.
 * @param {object} io - instancia de Socket.IO (opcional)
 */
function startFollowUpJob(io = null) {
  const INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

  console.log('[FollowUp] 🚀 Job iniciado — revisa cada 30 minutos y solo envía entre 09:00 y 20:59 (Chile)');

  // Primera corrida después de 5 minutos del arranque (para no saturar el inicio)
  setTimeout(() => {
    runFollowUp(io);
    runPersonalOfferFollowUp(io);
    setInterval(() => {
      runFollowUp(io);
      runPersonalOfferFollowUp(io);
    }, INTERVAL_MS);
  }, 5 * 60 * 1000);
}

function startHotClosingJob(io = null) {
  const INTERVAL_MS = 60 * 1000;
  console.log('[HotClosing] 🚀 Seguimiento de cierres iniciado — revisa cada minuto hasta las 13:00 (Chile)');
  setTimeout(() => {
    runHotClosingFollowUp(io).catch(error => console.error('[HotClosing] Error general:', error.message));
    setInterval(() => {
      runHotClosingFollowUp(io).catch(error => console.error('[HotClosing] Error general:', error.message));
    }, INTERVAL_MS);
  }, 30 * 1000);
}

module.exports = { startFollowUpJob, runFollowUp, runPersonalOfferFollowUp, startHotClosingJob, runHotClosingFollowUp };
