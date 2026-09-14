/**
 * escalation-watch.js — Nadie deja al cliente colgado
 *
 * Cuando el bot escala una conversación a humano, el cliente ya recibió un
 * acuse ("le paso tu caso al equipo"). Si pasan N minutos sin que ningún
 * humano responda, este job:
 *   1. Le manda al cliente UN recordatorio de que sigue pendiente.
 *   2. Vuelve a avisar al admin por WhatsApp.
 * Solo una vez por escalación (escalation_reminder_at). La vuelta automática
 * al bot a las 24 h la hace el webhook al siguiente mensaje del cliente.
 *
 * Setting por org: escalation_reminder_minutes (default 45).
 */

const { getPool } = require('../db/database');
const db          = require('../db/database');
const kapso       = require('./kapso-whatsapp');
const { notifyAdmin } = require('./admin-notify');

const DEFAULT_REMINDER_MINUTES = 45;
const CHECK_EVERY_MS = 10 * 60 * 1000;

let running = false;

async function sweepEscalations() {
  if (running) return;
  running = true;
  const pool = getPool();
  try {
    // Conversaciones en modo humano, escaladas por el bot, sin respuesta
    // humana desde la escalación, sin recordatorio todavía y con el cliente
    // aún dentro de la ventana de 24 h (si no, el texto libre no llega).
    const { rows } = await pool.query(`
      SELECT c.id, c.organization_id, c.phone_number, c.contact_name,
             c.last_escalation_at, c.last_escalation_reason,
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
        const wc = await db.getWhatsappConfig(c.organization_id);
        if (!wc || wc.provider !== 'kapso') continue;

        const waited = Math.round((Date.now() - new Date(c.last_escalation_at).getTime()) / 60000);
        const text = 'Sigo con tu consulta pendiente con el equipo 🙏 Te escribimos por aquí apenas la revisen. ¡Gracias por la paciencia!';

        let sent = null;
        try { sent = await kapso.sendTextMessage(c.phone_number, text, wc); }
        catch (e) { if (!e.is24hWindow) throw e; }

        await db.saveMessage({
          conversationId:    c.id,
          whatsappMessageId: sent?.messages?.[0]?.id || null,
          direction:         'outbound',
          content:           text,
          sentBy:            'ai',
          agentType:         'system',
          status:            sent ? 'sent' : 'failed',
        });
        await pool.query('UPDATE conversations SET escalation_reminder_at = NOW() WHERE id = $1', [c.id]);

        const who = c.contact_name || c.phone_number;
        await notifyAdmin(c.organization_id, {
          body: `⏰ *${who}* lleva ${waited} min esperando respuesta.\n📝 Motivo: ${c.last_escalation_reason || 'escalación del bot'}\n\nRespóndele desde el CRM o contesta aquí.`,
          kind: 'help',
          conversationId: c.id,
        }).catch(() => {});

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
