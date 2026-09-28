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
async function getRecentConversationContext(conversationId, limit = 6) {
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

    const contextLines = await getRecentConversationContext(conversation.id);

    const contextStr = contextLines.length > 0
      ? `\n\n🧭 *Contexto reciente* (de más antiguo a más nuevo):\n${contextLines.join('\n')}`
      : '';

    // Crear registro pendiente para el admin relay
    await db.createAdminPendingReply(
      orgId,
      conversation.id,
      clientPhone,
      contextLines.join(' | ')
    );

    const msg = [
      '🔔 *Cliente necesita tu respuesta*',
      '',
      `👤 *${clientName}*${clientPhone && clientPhone !== clientName ? ` (+${clientPhone})` : ''}`,
      `📋 *Motivo:* ${reason}`,
      contextStr,
      '',
      `👉 *Qué necesito de ti:* indícame qué responderle a ${clientName}. También puedes preguntarme qué ocurrió antes de decidir.`,
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
    let contextLines = await getRecentConversationContext(conversation.id);
    if (!contextLines.length && text) contextLines = [`Cliente: ${cleanContextText(text)}`];

    await db.createAdminPendingReply(orgId, conversation.id, clientPhone, text);
    const body = [
      '🔔 *Hay una conversación esperando por ti*',
      '',
      `👤 *${clientName}*${clientPhone && clientPhone !== clientName ? ` (+${clientPhone})` : ''}`,
      '🟡 *Estado:* el chat está en modo humano; Diva no responderá mientras lo atiendes.',
      '',
      contextLines.length ? `🧭 *Contexto reciente:*\n${contextLines.join('\n')}` : '',
      '',
      `👉 *Qué necesito de ti:* responde qué quieres decirle a ${clientName}, o pregúntame primero por el contexto.`,
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

    const contextLines = await getRecentConversationContext(conversation.id);

    // No crear pendiente duplicado si ya hay uno activo para esta conversación
    const existingPending = await db.getLatestPendingAdminReply(orgId);
    if (existingPending && existingPending.conversation_id === conversation.id) {
      console.log(`[Notifications] Ya hay pendiente activo para conv #${conversation.id} — actualizando contexto`);
      // Solo re-notificar si cambió algo sustancial (no crear nuevo registro)
    } else {
      await db.createAdminPendingReply(
        orgId, conversation.id, clientPhone,
        contextLines.filter(line => line.startsWith('Cliente:')).join(' | ')
      );
    }

    const msg = [
      `❓ *Necesito tu criterio con ${clientName}*`,
      clientPhone && clientPhone !== clientName ? `📱 ${clientPhone}` : '',
      reason ? `🧭 *Qué ocurrió:* ${reason}` : '',
      '',
      contextLines.length ? `*Conversación reciente:*\n${contextLines.join('\n')}` : '(No pude recuperar el historial reciente)',
      '',
      botWasGoingToSay ? `🛑 *Respuesta que Diva detuvo para no enviarla sin tu aprobación:*\n“${cleanContextText(botWasGoingToSay, 240)}”` : '',
      '',
      `👉 *Qué necesito de ti:* dime qué responderle a ${clientName}. También puedes preguntarme algo sobre la conversación antes de decidir.`,
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
};
