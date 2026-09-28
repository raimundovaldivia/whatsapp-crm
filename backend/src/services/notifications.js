/**
 * notifications.js — Alertas internas vía WhatsApp
 *
 * Cuando el bot detecta que una conversación necesita atención humana,
 * notifica al admin en su WhatsApp personal con el contexto.
 * El admin puede responder directamente desde WhatsApp y su respuesta
 * se reenvía al cliente automáticamente (admin relay).
 *
 * También notifica a los agentes con wa_notifications habilitadas.
 */

const db           = require('../db/database');
const kapsoService = require('./kapso-whatsapp');
const { notifyAdmin } = require('./admin-notify');

function cleanContextText(value, max = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function contextSpeaker(message) {
  if (message.direction === 'inbound') return 'Cliente';
  return message.sent_by === 'human' || message.agent_type === 'human_guided'
    ? 'Equipo'
    : 'Diva';
}

/**
 * Resume los últimos turnos en orden cronológico. Así cada aviso conserva la
 * conversación necesaria para que el administrador pueda decidir qué hacer.
 */
async function getRecentConversationContext(conversationId, limit = 8) {
  try {
    const messages = await db.getLastMessages(conversationId, Math.max(limit + 2, 8));
    return messages
      .filter(message => message.content && !String(message.content).startsWith('🎤 [Audio]'))
      .slice(-limit)
      .map(message => `${contextSpeaker(message)}: ${cleanContextText(message.content)}`);
  } catch {
    return [];
  }
}

function fallbackConversationBrief(contextLines, reason = '') {
  const lastClient = [...contextLines].reverse().find(line => line.startsWith('Cliente:'));
  const previous = contextLines.length > 1 ? contextLines.at(-2) : null;
  const situationParts = [];
  if (reason) situationParts.push(cleanContextText(reason, 320));
  if (previous && lastClient) {
    situationParts.push(`El último intercambio relevante fue “${cleanContextText(previous, 180)}” y luego “${cleanContextText(lastClient, 180)}”.`);
  } else if (lastClient) {
    situationParts.push(`El último mensaje fue “${cleanContextText(lastClient, 220)}”.`);
  }
  return {
    situation: situationParts.join(' ') || 'No fue posible recuperar suficiente conversación para resumir el caso.',
    customerNeed: lastClient
      ? `Interpretar y responder el último mensaje del cliente sin repetir lo ya conversado.`
      : 'Revisar el chat antes de responder.',
    recommendation: contextLines.length
      ? 'Responder únicamente al estado actual de la conversación y evitar reiniciar la venta.'
      : 'Abrir la conversación en el CRM; no responder desde este aviso sin historial.',
    evidence: contextLines.slice(-3),
  };
}

/**
 * Analiza el historial para el administrador. No copia todo el chat: explica
 * qué ocurrió, qué parece necesitar el cliente y cuál es el siguiente paso.
 */
async function getAdminConversationBrief(conversationId, reason = '') {
  const contextLines = await getRecentConversationContext(conversationId, 10);
  const fallback = fallbackConversationBrief(contextLines, reason);
  if (!contextLines.length || !process.env.ANTHROPIC_API_KEY) return fallback;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      system: `Analiza una conversación de atención comercial para informar al administrador. Debes comprender la secuencia, no copiarla ni describir cada turno.

Devuelve SOLO JSON válido con:
{"situation":"qué pasó y por qué llegó a este punto, máximo 2 frases","customerNeed":"qué necesita o expresa ahora el cliente, 1 frase","recommendation":"qué conviene responder o hacer ahora, 1 frase","evidence":["máximo 2 mensajes textuales indispensables"]}

Reglas:
- No inventes hechos, fechas, intenciones ni emociones. Si un emoji es ambiguo, dilo.
- Identifica si Diva repitió, insistió, contradijo un acuerdo o escribió en un momento inadecuado.
- Distingue el problema original del estado actual. Si el equipo ya se disculpó, indícalo.
- La recomendación debe ser concreta y evitar nuevas preguntas o seguimientos innecesarios.`,
      messages: [{
        role: 'user',
        content: `${reason ? `MOTIVO DEL AVISO: ${cleanContextText(reason, 400)}\n\n` : ''}CONVERSACIÓN (más reciente al final):\n${contextLines.join('\n')}`,
      }],
    });
    const raw = response.content?.[0]?.text?.trim() || '';
    const parsed = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    return {
      situation: cleanContextText(parsed.situation, 420) || fallback.situation,
      customerNeed: cleanContextText(parsed.customerNeed, 260) || fallback.customerNeed,
      recommendation: cleanContextText(parsed.recommendation, 300) || fallback.recommendation,
      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.map(item => cleanContextText(item, 220)).filter(Boolean).slice(0, 2)
        : fallback.evidence.slice(-2),
    };
  } catch (err) {
    console.warn('[Notifications] No se pudo analizar el contexto; usando resumen seguro:', err.message);
    return fallback;
  }
}

function formatConversationBrief(brief) {
  return [
    `🧭 *Qué pasó:* ${brief.situation}`,
    `🎯 *Qué necesita ahora:* ${brief.customerNeed}`,
    `💡 *Recomendación:* ${brief.recommendation}`,
    brief.evidence?.length ? `🔎 *Mensajes clave:*\n${brief.evidence.map(line => `• ${line}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Notifica al administrador que una conversación necesita atención humana.
 * Crea un registro en admin_pending_replies para que la respuesta del admin
 * sea enrutada al cliente automáticamente.
 *
 * @param {number} orgId
 * @param {object} conversation  - objeto de la conversación (id, contact_name, phone_number)
 * @param {string} reason        - motivo del cambio (escalación, solicitud del cliente, manual)
 */
async function notifyAdminHandoff(orgId, conversation, reason = 'El cliente solicitó asistencia') {
  try {
    const adminPhone = await db.getSetting(orgId, 'admin_alert_phone');
    if (!adminPhone) return;

    const wc = await db.getWhatsappConfig(orgId);
    if (!wc || wc.provider !== 'kapso') return;

    const clientName  = conversation.contact_name || conversation.phone_number || 'Cliente';
    const clientPhone = conversation.phone_number || '';

    const brief = await getAdminConversationBrief(conversation.id, reason);
    const briefText = formatConversationBrief(brief);

    // Crear registro pendiente para el admin relay
    await db.createAdminPendingReply(
      orgId,
      conversation.id,
      clientPhone,
      briefText
    );

    const msg = [
      '🔔 *Cliente necesita tu respuesta*',
      '',
      `👤 *${clientName}*${clientPhone && clientPhone !== clientName ? ` (+${clientPhone})` : ''}`,
      '',
      briefText,
      '',
      `👉 *Qué necesito de ti:* confirma la recomendación, corrígela o escribe el mensaje exacto para ${clientName}.`,
      'Cuando me des una instrucción clara, te mostraré qué se envió.',
      '',
      clientPhone ? `_Si tienes varios avisos abiertos, elige este chat con: #msg ${clientPhone} <respuesta>_` : '',
    ].filter(Boolean).join('\n');

    // Va por notifyAdmin: si tu ventana de 24h está cerrada, queda en cola y se
    // entrega apenas escribas al número, en vez de perderse.
    await notifyAdmin(orgId, { body: msg, kind: 'handoff', conversationId: conversation.id, wc });
    console.log(`[Notifications] Handoff encaminado al admin — conv #${conversation.id}`);
  } catch (err) {
    console.warn('[Notifications] No se pudo notificar al admin:', err.message);
  }
}

/**
 * Notifica a todos los agentes con notify_new_messages=true cuando llega un mensaje nuevo.
 * @param {number} orgId
 * @param {object} conversation  - conversación del cliente
 * @param {string} messageText   - texto del último mensaje
 */
async function notifyAgentsNewMessage(orgId, conversation, messageText) {
  try {
    const wc = await db.getWhatsappConfig(orgId);
    if (!wc || wc.provider !== 'kapso') return;

    const agents = await db.getAgentsWithNotification(orgId, 'new_messages');
    if (!agents.length) return;

    const clientName  = conversation.contact_name || conversation.phone_number || 'Cliente';
    const clientPhone = conversation.phone_number || '';

    const msg = [
      `💬 *Nuevo mensaje de ${clientName}*`,
      clientPhone && clientPhone !== clientName ? `📱 ${clientPhone}` : '',
      '',
      `"${(messageText || '').slice(0, 150)}"`,
      '',
      `_Responde con: MSG ${clientPhone} <tu respuesta>_`,
      `_O pausa el bot con: PAUSAR ${clientPhone}_`,
    ].filter(Boolean).join('\n');

    const sends = agents.map(agent =>
      kapsoService.sendTextMessage(agent.whatsapp_phone, msg, wc).catch(err =>
        console.warn(`[Notifications] No se pudo notificar al agente ${agent.email}:`, err.message)
      )
    );
    await Promise.allSettled(sends);
    console.log(`[Notifications] 📣 ${agents.length} agente(s) notificados — nuevo msg de ${clientPhone}`);
  } catch (err) {
    console.warn('[Notifications] Error notificando agentes:', err.message);
  }
}

/**
 * Avisa que llegó una respuesta mientras una persona conserva el control.
 * El primer mensaje avisa de inmediato; mensajes consecutivos se agrupan
 * durante unos minutos para no bombardear al administrador.
 */
async function notifyAdminHumanPendingReply(orgId, conversation, messageText) {
  try {
    if (!conversation?.id || conversation.agent_mode !== 'human') return { sent: false, reason: 'modo_inactivo' };
    const claimed = await db.claimHumanPendingNotification(conversation.id, 5);
    if (!claimed) return { sent: false, reason: 'aviso_reciente' };

    const clientName = conversation.contact_name || conversation.phone_number || 'Cliente';
    const clientPhone = conversation.phone_number || '';
    const text = String(messageText || '').slice(0, 300);
    const brief = await getAdminConversationBrief(
      conversation.id,
      `El chat está en modo humano y el cliente acaba de enviar: “${cleanContextText(text, 220)}”.`
    );
    const briefText = formatConversationBrief(brief);

    await db.createAdminPendingReply(orgId, conversation.id, clientPhone, briefText);
    const body = [
      '🔔 *Hay una conversación esperando por ti*',
      '',
      `👤 *${clientName}*${clientPhone && clientPhone !== clientName ? ` (+${clientPhone})` : ''}`,
      '🟡 *Estado:* el chat está en modo humano; Diva no responderá mientras lo atiendes.',
      '',
      briefText,
      '',
      `👉 *Qué necesito de ti:* confirma la recomendación, corrígela o escribe el mensaje exacto para ${clientName}.`,
      clientPhone ? `_Si hay varios clientes esperando, usa: #msg ${clientPhone} <respuesta>_` : '',
    ].filter(Boolean).join('\n');

    const result = await notifyAdmin(orgId, {
      body,
      kind: 'handoff',
      conversationId: conversation.id,
    });
    console.log(`[Notifications] Respuesta humana pendiente avisada — conv #${conversation.id}`);
    return result;
  } catch (err) {
    console.warn('[Notifications] No se pudo avisar la respuesta pendiente:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Notifica a agentes con notify_payments=true cuando llega un comprobante de pago.
 * @param {number} orgId
 * @param {string} clientName
 * @param {string} clientPhone
 * @param {string} amount
 */
async function notifyAgentsPayment(orgId, clientName, clientPhone, amount) {
  try {
    const wc = await db.getWhatsappConfig(orgId);
    if (!wc || wc.provider !== 'kapso') return;

    const agents = await db.getAgentsWithNotification(orgId, 'payments');
    if (!agents.length) return;

    // El administrador ya recibe el aviso detallado. Si también figura como
    // agente de pagos, no mandarle una segunda notificación simplificada.
    const adminPhone = await db.getSetting(orgId, 'admin_alert_phone').catch(() => null);
    const digits = value => String(value || '').replace(/\D/g, '');
    const recipients = agents.filter(agent => !adminPhone || digits(agent.whatsapp_phone) !== digits(adminPhone));
    if (!recipients.length) return;

    const msg = [
      `💸 *Comprobante de pago recibido*`,
      `👤 ${clientName || clientPhone}`,
      amount ? `💰 ${amount}` : '',
      '',
      `_Revísalo en el CRM → Pagos_`,
    ].filter(Boolean).join('\n');

    await Promise.allSettled(recipients.map(agent =>
      kapsoService.sendTextMessage(agent.whatsapp_phone, msg, wc).catch(() => {})
    ));
  } catch (err) {
    console.warn('[Notifications] Error notificando pago:', err.message);
  }
}

/**
 * Consulta silenciosa al admin: el bot no sabe cómo responder y le pide guía.
 * El admin responde con el texto a enviar (bot lo manda como si fuera él),
 * o escribe "TOMAR" para tomar el control directamente.
 *
 * @param {number} orgId
 * @param {object} conversation     - objeto conversación (id, contact_name, phone_number)
 * @param {string} botWasGoingToSay - lo que el bot iba a responder (contexto para el admin)
 * @param {string} reason           - motivo de la consulta
 */
async function notifyAdminHelp(orgId, conversation, botWasGoingToSay, reason) {
  try {
    const adminPhone = await db.getSetting(orgId, 'admin_alert_phone');
    if (!adminPhone) return;

    const wc = await db.getWhatsappConfig(orgId);
    if (!wc || wc.provider !== 'kapso') return;

    const clientName  = conversation.contact_name || conversation.phone_number || 'Cliente';
    const clientPhone = conversation.phone_number || '';

    const brief = await getAdminConversationBrief(conversation.id, reason);
    const briefText = formatConversationBrief(brief);

    // createAdminPendingReply actualiza el contexto si ya existía un pendiente
    // para este mismo chat, sin crear duplicados.
    await db.createAdminPendingReply(orgId, conversation.id, clientPhone, briefText);

    const msg = [
      `❓ *Necesito tu criterio con ${clientName}*`,
      clientPhone && clientPhone !== clientName ? `📱 ${clientPhone}` : '',
      '',
      briefText,
      '',
      botWasGoingToSay ? `🛑 *Respuesta que Diva detuvo para no enviarla sin tu aprobación:*\n“${cleanContextText(botWasGoingToSay, 240)}”` : '',
      '',
      `👉 *Qué necesito de ti:* confirma la recomendación, corrígela o escribe el mensaje exacto para ${clientName}.`,
      'Si escribes *TOMAR*, te paso el control del chat y Diva deja de responder.',
      clientPhone ? `_Con varios avisos abiertos, responde directamente con: #msg ${clientPhone} <respuesta>_` : '',
    ].filter(Boolean).join('\n');

    // Va por notifyAdmin: si la ventana está cerrada, la consulta queda en cola
    // (deduplicada por conversación) y llega cuando el admin reabra el canal.
    const r = await notifyAdmin(orgId, { body: msg, kind: 'help', conversationId: conversation.id, wc });
    console.log(`[Notifications] ❓ Admin consultado — conv #${conversation.id} (${r.sent ? 'entregado' : r.queued ? 'en cola' : r.reason})`);
  } catch (err) {
    console.warn('[Notifications] notifyAdminHelp error:', err.message);
  }
}

module.exports = {
  notifyAdminHandoff,
  notifyAdminHelp,
  notifyAdminHumanPendingReply,
  notifyAgentsNewMessage,
  notifyAgentsPayment,
  getRecentConversationContext,
  getAdminConversationBrief,
  formatConversationBrief,
};
