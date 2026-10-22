const db = require('../db/database');

// Pending jobs survive restarts. An interrupted provider request is never retried blindly.
const MAX_CONSECUTIVE_FAILURES = 3;
function createWorker(sendOne, pool = db.getPool()) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await pool.query(`WITH stale AS (
        UPDATE broadcast_jobs SET state = 'unknown', result = '{"error":"Envío interrumpido; revisar antes de reenviar"}'::jsonb
        WHERE state = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes' RETURNING campaign_id
      ) UPDATE broadcast_campaigns SET status = 'interrupted', completed_at = NOW()
        WHERE id IN (SELECT campaign_id FROM stale) AND status = 'processing'`);
      // Envíos directos (Evolution) solo dentro de la ventana horaria de Chile.
      const windowStart = Number(process.env.EVOLUTION_SEND_HOUR_START ?? 8);
      const windowLastHour = Number(process.env.EVOLUTION_SEND_HOUR_END ?? 21) - 1;
      const { rows } = await pool.query(`UPDATE broadcast_jobs j SET state = 'processing', claimed_at = NOW()
        WHERE j.id = (
          SELECT q.id FROM broadcast_jobs q JOIN broadcast_campaigns c ON c.id = q.campaign_id
          WHERE q.state = 'pending' AND q.available_at <= NOW() AND c.server_managed AND c.status = 'processing'
            AND (c.scheduled_for IS NULL OR c.scheduled_for <= NOW())
            AND (c.sending_provider IS DISTINCT FROM 'evolution'
                 OR EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Santiago')) BETWEEN $1 AND $2)
            AND NOT EXISTS (SELECT 1 FROM broadcast_jobs busy WHERE busy.campaign_id = q.campaign_id AND busy.state = 'processing')
          ORDER BY q.available_at, q.id FOR UPDATE OF q, c SKIP LOCKED LIMIT 1
        ) RETURNING j.*`, [windowStart, windowLastHour]);
      const job = rows[0];
      if (!job) return;
      let response;
      try { response = await sendOne(job); }
      catch (error) { response = { status: 500, body: { error: error.message } }; }
      if (response.status === 429 && response.body.rateLimited) {
        const seconds = Math.max(1, Number(response.body.retryAfterSeconds) || 60);
        await pool.query(`UPDATE broadcast_jobs SET state = 'pending', claimed_at = NULL,
          available_at = NOW() + $2 * INTERVAL '1 second' WHERE id = $1`, [job.id, seconds]);
        // Keep recipient order while waiting; do not let later jobs overtake this one.
        await pool.query(`UPDATE broadcast_jobs SET available_at = GREATEST(available_at, NOW() + $2 * INTERVAL '1 second')
          WHERE campaign_id = $1 AND state = 'pending'`, [job.campaign_id, seconds]);
        return;
      }
      const result = response.body.results?.[0];
      const uncertain = !result || result.pending || result.persistencePending;
      await pool.query(`UPDATE broadcast_jobs SET state = $2, result = $3 WHERE id = $1`,
        [job.id, uncertain ? 'unknown' : 'done', JSON.stringify(result || response.body)]);
      // Un resultado incierto detiene la campaña para no reenviar a ciegas. Un fallo
      // definitivo de un destinatario (p. ej. número sin WhatsApp) no debe dejar sin
      // enviar al resto: solo se detiene si fallan varios seguidos (proveedor caído).
      let stop = uncertain;
      if (!stop && !result.success && !result.skipped) {
        const { rows: recent } = await pool.query(`SELECT result FROM broadcast_jobs
          WHERE campaign_id = $1 AND state = 'done' ORDER BY position DESC LIMIT $2`,
          [job.campaign_id, MAX_CONSECUTIVE_FAILURES]);
        stop = recent.length >= MAX_CONSECUTIVE_FAILURES
          && recent.every(r => r.result && !r.result.success && !r.result.skipped);
      }
      if (stop) {
        await pool.query(`UPDATE broadcast_campaigns SET status = 'interrupted', completed_at = NOW()
          WHERE id = $1 AND status = 'processing'`, [job.campaign_id]);
      } else {
        await pool.query(`UPDATE broadcast_campaigns SET status = 'completed', completed_at = NOW()
          WHERE id = $1 AND status = 'processing' AND NOT EXISTS (
            SELECT 1 FROM broadcast_jobs WHERE campaign_id = $1 AND state <> 'done')`, [job.campaign_id]);
      }
    } finally { running = false; }
  }
  return { tick };
}

let started = false;
function start(sendOne) {
  if (started) return;
  started = true;
  // Pool initialization happens after route registration.
  let worker;
  const timer = setInterval(() => {
    worker ||= createWorker(sendOne);
    worker.tick().catch(error => console.error('[BroadcastWorker]', error.message));
  }, 1000);
  timer.unref?.();
}
module.exports = { createWorker, start };
