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

    // Obtener últimos mensajes del cliente para dar contexto
    let contextLines = [];
    try {
      const lastMessages = await db.getLastMessages(conversation.id, 8);
      contextLines = lastMessages
        .filter(m => m.direction === 'inbound' && m.content && !m.content.startsWith('🎤 [Audio]'))
        .slice(-3)
        .map(m => `"${m.content.slice(0, 120)}"`);
    } catch { /* continuar sin contexto */ }

    const contextStr = contextLines.length > 0
      ? `\n\n💬 Últimos mensajes del cliente:\n${contextLines.join('\n')}`
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
      '👆 *Respóndeme aquí y envío tu mensaje al cliente directamente.*',
      '',
      '_Si hay varios clientes esperando, se responde el más reciente primero._',
    ].filter(Boolean).join('\n');

    await kapsoService.sendTextMessage(adminPhone, msg, wc);
    console.log(`[Notifications] ✅ Admin notificado (${adminPhone}) — conv #${conversation.id}`);
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

    const msg = [
      `💸 *Comprobante de pago recibido*`,
      `👤 ${clientName || clientPhone}`,
      amount ? `💰 ${amount}` : '',
      '',
      `_Revísalo en el CRM → Pagos_`,
    ].filter(Boolean).join('\n');

    await Promise.allSettled(agents.map(agent =>
      kapsoService.sendTextMessage(agent.whatsapp_phone, msg, wc).catch(() => {})
    ));
  } catch (err) {
    console.warn('[Notifications] Error notificando pago:', err.message);
  }
}

module.exports = { notifyAdminHandoff, notifyAgentsNewMessage, notifyAgentsPayment };
