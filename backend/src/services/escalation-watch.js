/**
 * escalation-watch.js — Nadie deja al cliente colgado
 *
 * Cuando el bot escala una conversación a humano, el cliente ya recibió un
 * acuse ("le paso tu caso al equipo"). Si pasan N minutos sin que ningún
 * humano responda, este job:
 *   avisa internamente al admin con el contexto del caso.
 * Solo una vez por escalación (escalation_reminder_at). La vuelta automática
 * al bot a las 24 h la hace el webhook al siguiente mensaje del cliente.
 *
 * Setting por org: escalation_reminder_minutes (default 45).
 */

const { getPool } = require('../db/database');
const { notifyAdmin, isWindowOpen } = require('./admin-notify');
const { getAdminConversationBrief, formatConversationBrief } = require('./notifications');
const { isCustomerMessagingHour } = require('./outbound-policy');

const DEFAULT_REMINDER_MINUTES = 45;
const CHECK_EVERY_MS = 10 * 60 * 1000;

let running = false;

async function sweepEscalations(now = new Date()) {
  if (running) return;
  if (!isCustomerMessagingHour(now)) {
    console.log('[EscalationWatch] Fuera del horario 09:00-20:59 de Chile — no se contactará a clientes');
    return { processed: 0, reason: 'outside_customer_hours' };
  }
  running = true;
  const pool = getPool();
  try {
    // Conversaciones en modo humano, escaladas por el bot, sin respuesta
    // humana desde la escalación, sin recordatorio todavía y con el cliente
    // aún dentro de la ventana de 24 h (si no, el texto libre no llega).
    const { rows } = await pool.query(`
      SELECT c.id, c.organization_id, c.phone_number, c.contact_name, c.whatsapp_channel_id,
             c.last_escalation_at::text AS last_escalation_at, c.last_escalation_reason,
             COALESCE(NULLIF(s.value, ''), '${DEFAULT_REMINDER_MINUTES}')::int AS reminder_minutes
        FROM conversations c
        LEFT JOIN settings s
               ON s.organization_id = c.organization_id AND s.key = 'escalation_reminder_minutes'
       WHERE c.agent_mode <> 'ai'
         AND c.last_escalation_at IS NOT NULL
         AND c.escalation_reminder_at IS NULL
         AND c.last_escalation_at < NOW() - (COALESCE(NULLIF(s.value, ''), '${DEFAULT_REMINDER_MINUTES}')::int || ' minutes')::interval
         AND c.last_escalation_at > NOW() - INTERVAL '23 hours'
         AND NOT EXISTS (
               SELECT 1 FROM messages m
                WHERE m.conversation_id = c.id
                  AND m.direction = 'outbound' AND m.sent_by = 'human'
                  AND m.created_at > c.last_escalation_at)
       LIMIT 50
    `);

    for (const c of rows) {
      try {
        const waited = Math.round((now.getTime() - new Date(c.last_escalation_at).getTime()) / 60000);
        const who = c.contact_name || c.phone_number;
        const adminWindowOpen = await isWindowOpen(c.organization_id);
        const brief = await getAdminConversationBrief(
          c.id,
          c.last_escalation_reason || 'Diva pidió apoyo del equipo',
          { allowAi: adminWindowOpen }
        );
        const notification = await notifyAdmin(c.organization_id, {
          body: [
            `⏰ *${who} sigue esperando hace ${waited} min*`,
            '',
            formatConversationBrief(brief),
            '',
            `👉 *Qué necesito de ti:* confirma la recomendación, corrígela o atiende a ${who} desde el CRM.`,
            `_Si tienes varios avisos abiertos: #msg ${c.phone_number} <respuesta>_`,
          ].filter(Boolean).join('\n'),
          kind: 'help',
          conversationId: c.id,
        });
        if (!notification?.sent && !notification?.queued) continue;
        await pool.query('UPDATE conversations SET escalation_reminder_at = NOW() WHERE organization_id = $1 AND id = $2 AND last_escalation_at = $3', [c.organization_id, c.id, c.last_escalation_at]);

        console.log(`[EscalationWatch] ⏰ Recordatorio enviado a conv ${c.id} (${waited} min esperando)`);
      } catch (err) {
        console.warn(`[EscalationWatch] conv ${c.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[EscalationWatch] sweep falló:', err.message);
  } finally {
    running = false;
  }
}

function startEscalationWatchJob() {
  setTimeout(sweepEscalations, 90 * 1000);
  setInterval(sweepEscalations, CHECK_EVERY_MS);
  console.log('[EscalationWatch] job iniciado (cada 10 min)');
}

module.exports = { startEscalationWatchJob, sweepEscalations, DEFAULT_REMINDER_MINUTES };
