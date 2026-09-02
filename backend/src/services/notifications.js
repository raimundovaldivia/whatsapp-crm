/**
 * notifications.js — Alertas internas vía WhatsApp
 *
 * Cuando el bot detecta que una conversación necesita atención humana,
 * notifica al admin en su WhatsApp personal con el contexto.
 * El admin puede responder directamente desde WhatsApp y su respuesta
 * se reenvía al cliente automáticamente (admin relay).
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

module.exports = { notifyAdminHandoff };
