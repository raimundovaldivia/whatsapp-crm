// Minutes in America/Santiago; PostgreSQL resolves daylight saving transitions.
function sendWindow(env = process.env) {
  const start = Number(env.EVOLUTION_SEND_HOUR_START ?? 8) * 60;
  const end = Number(env.EVOLUTION_SEND_HOUR_END ?? 22.5) * 60;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start >= end) {
    throw new Error('Horario Evolution inválido: requiere inicio < fin entre 0 y 24 horas');
  }
  return { start, end };
}

async function checkSendWindow(pool) {
  const { start, end } = sendWindow();
  const { rows: [row] } = await pool.query(`WITH clock AS (
    SELECT NOW() AS instant, NOW() AT TIME ZONE 'America/Santiago' AS local
  ), permitted_window AS (
    SELECT *, EXTRACT(HOUR FROM local) * 60 + EXTRACT(MINUTE FROM local) AS minute FROM clock
  ) SELECT CASE WHEN minute >= $1 AND minute < $2 THEN 0 ELSE
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
      ((local::date + CASE WHEN minute >= $2 THEN 1 ELSE 0 END)
        + make_interval(mins => $1::int)) AT TIME ZONE 'America/Santiago' - instant
    ))))::int END AS retry_after_seconds FROM permitted_window`, [start, end]);
  const seconds = Number(row?.retry_after_seconds);
  if (!Number.isFinite(seconds)) throw new Error('No se pudo verificar el horario de envío');
  return { allowed: seconds === 0, retryAfterSeconds: seconds, outsideSendWindow: seconds > 0 };
}
module.exports = { sendWindow, checkSendWindow };
