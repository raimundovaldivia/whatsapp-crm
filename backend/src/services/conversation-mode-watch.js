/**
 * Cierra estados de atención que quedaron abiertos cuando ya terminó el hilo.
 * Una intervención humana vence tras 2 horas sin actividad; una coordinación
 * pendiente conserva 24 horas para que el equipo pueda responder.
 */
const db = require('../db/database');
const { HUMAN_IDLE_MINUTES, COORDINATION_IDLE_MINUTES } = require('./conversation-mode');

const CHECK_EVERY_MS = 10 * 60 * 1000;
let running = false;

async function sweepConversationModes(io = null) {
  if (running) return [];
  running = true;
  try {
    const pool = db.getPool();
    const { rows } = await pool.query(`
      UPDATE conversations
         SET agent_mode = 'ai',
             agent_mode_changed_at = NOW(),
             last_escalation_trigger = NULL,
             last_escalation_reason = NULL,
             last_escalation_at = NULL,
             escalation_reminder_at = NULL,
             updated_at = NOW()
       WHERE (
         agent_mode = 'human'
         AND GREATEST(
               COALESCE(last_message_at, '-infinity'::timestamp),
               COALESCE(agent_mode_changed_at, created_at),
               COALESCE((
                 SELECT MAX(m.created_at) FROM messages m
                  WHERE m.conversation_id = conversations.id
                    AND m.direction = 'outbound'
                    AND m.sent_by = 'human'
               ), '-infinity'::timestamp)
             ) < NOW() - INTERVAL '${HUMAN_IDLE_MINUTES} minutes'
       ) OR (
         agent_mode = 'coordinating'
         AND GREATEST(
               COALESCE(last_message_at, '-infinity'::timestamp),
               COALESCE(agent_mode_changed_at, created_at),
               COALESCE(last_escalation_at, '-infinity'::timestamp)
             ) < NOW() - INTERVAL '${COORDINATION_IDLE_MINUTES} minutes'
       )
       RETURNING id, organization_id`);

    if (rows.length) {
      const ids = rows.map(row => row.id);
      await pool.query(
        `UPDATE admin_pending_replies SET status = 'expired'
          WHERE status = 'pending' AND conversation_id = ANY($1::int[])`,
        [ids]
      ).catch(() => {});
      for (const row of rows) {
        io?.to(`org_${row.organization_id}`).emit(`agent_mode_changed_${row.organization_id}`, {
          conversationId: row.id,
          mode: 'ai',
        });
      }
      console.log(`[ConversationModeWatch] ${rows.length} hilo(s) inactivo(s) volvieron a Diva`);
    }
    return rows;
  } catch (err) {
    console.error('[ConversationModeWatch] sweep falló:', err.message);
    return [];
  } finally {
    running = false;
  }
}

function startConversationModeWatchJob(io = null) {
  setTimeout(() => sweepConversationModes(io), 2 * 60 * 1000);
  setInterval(() => sweepConversationModes(io), CHECK_EVERY_MS);
  console.log('[ConversationModeWatch] job iniciado (cada 10 min)');
}

module.exports = {
  sweepConversationModes,
  startConversationModeWatchJob,
  HUMAN_IDLE_MINUTES,
  COORDINATION_IDLE_MINUTES,
};
