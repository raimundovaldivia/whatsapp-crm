/**
 * notifications.js — Alertas internas vía WhatsApp
 *
 * Envía un mensaje de WhatsApp al número de administrador configurado
 * cuando una conversación pasa a modo humano.
 *
 * Requiere en Ajustes → Bot:
 *   admin_alert_phone → número del admin (ej: 56912345678)
 */

const db          = require('../db/database');
const kapsoService = require('./kapso-whatsapp');

/**
 * Notifica al administrador que una conversación necesita atención humana.
 *
 * @param {number} orgId
 * @param {object} conversation  - objeto de la conversación (contact_name, phone_number)
 * @param {string} reason        - motivo del cambio (escalación, solicitud del cliente, manual)
 */
async function notifyAdminHandoff(orgId, conversation, reason = 'El cliente solicitó asistencia') {
  try {
    const adminPhone = await db.getSetting(orgId, 'admin_alert_phone');
    if (!adminPhone) return; // sin admin configurado → silencioso

    const wc = await db.getWhatsappConfig(orgId);
    if (!wc || wc.provider !== 'kapso') return; // solo Kapso por ahora

    const clientName = conversation.contact_name || conversation.phone_number || 'Cliente';
    const clientPhone = conversation.phone_number || '';

    const msg = [
      '🔔 *Atención requerida en el CRM*',
      '',
      `👤 *Cliente:* ${clientName}${clientPhone && clientPhone !== clientName ? ` (${clientPhone})` : ''}`,
      `📋 *Motivo:* ${reason}`,
      '',
      'Abre el CRM para responderle.',
    ].join('\n');

    await kapsoService.sendTextMessage(adminPhone, msg, wc);
    console.log(`[Notifications] ✅ Admin notificado (${adminPhone}) — conv #${conversation.id}`);
  } catch (err) {
    // No falla el flujo principal
    console.warn('[Notifications] No se pudo notificar al admin:', err.message);
  }
}

module.exports = { notifyAdminHandoff };
