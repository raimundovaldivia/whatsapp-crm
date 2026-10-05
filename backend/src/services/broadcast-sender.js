const db = require('../db/database');
const DIRECT_INTERVAL_SECONDS = 60;
const DIRECT_BATCH_SIZE = 10;
const DIRECT_BATCH_PAUSE_SECONDS = 300;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
async function resolveSender(orgId, provider, channelId) {
  if (provider === 'evolution') {
    if (!Number.isSafeInteger(Number(channelId)) || Number(channelId) < 1) throw error('Selecciona una conexión directa');
    const channel = await db.getWhatsappChannel(orgId, Number(channelId));
    if (!channel || channel.provider !== 'evolution') throw error('Conexión no disponible', 404);
    if (channel.status !== 'connected') throw error('La conexión directa está desconectada. Conéctala en Ajustes.', 409);
    return channel;
  }
  if (provider !== 'kapso') throw error('Método de envío inválido');
  const config = await db.getWhatsappConfig(orgId);
  if (!config || config.provider !== 'kapso') throw error('Kapso no está configurado', 409);
  return config;
}
async function sendingMethods(orgId) {
  const [config, channels] = await Promise.all([db.getWhatsappConfig(orgId), db.listWhatsappChannels(orgId)]);
  return [
    { provider: 'kapso', channelId: null, label: 'Kapso · API oficial', available: config?.provider === 'kapso' },
    ...channels.filter(c => c.provider === 'evolution').map(c => ({
      provider: 'evolution', channelId: c.id, label: `Directo · ${c.name || c.phone_number || 'Evolution'}`,
      available: c.status === 'connected', intervalSeconds: DIRECT_INTERVAL_SECONDS,
      batchSize: DIRECT_BATCH_SIZE, batchPauseSeconds: DIRECT_BATCH_PAUSE_SECONDS,
    })),
  ];
}
// Atomic permit shared by tabs, channels and campaigns; survives server restarts.
async function claimDirectSlot(orgId) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    `INSERT INTO broadcast_direct_pacing (organization_id, next_send_at)
     VALUES ($1, NOW() + $2 * INTERVAL '1 second')
     ON CONFLICT (organization_id) DO UPDATE SET
       batch_count = CASE WHEN broadcast_direct_pacing.next_send_at < NOW() - $4 * INTERVAL '1 second'
         THEN 1 ELSE (broadcast_direct_pacing.batch_count % $3) + 1 END,
       next_send_at = NOW() + CASE
         WHEN broadcast_direct_pacing.next_send_at >= NOW() - $4 * INTERVAL '1 second'
           AND (broadcast_direct_pacing.batch_count % $3) + 1 = $3 THEN $4
         ELSE $2 END * INTERVAL '1 second'
     WHERE broadcast_direct_pacing.next_send_at <= NOW()
     RETURNING next_send_at`, [orgId, DIRECT_INTERVAL_SECONDS, DIRECT_BATCH_SIZE, DIRECT_BATCH_PAUSE_SECONDS]);
  if (rows.length) return { allowed: true, retryAfterSeconds: 0 };
  const result = await pool.query(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (next_send_at - NOW()))))::int AS wait_seconds
     FROM broadcast_direct_pacing WHERE organization_id = $1`, [orgId]);
  return { allowed: false, retryAfterSeconds: result.rows[0]?.wait_seconds || DIRECT_INTERVAL_SECONDS };
}
module.exports = { resolveSender, sendingMethods, claimDirectSlot, DIRECT_INTERVAL_SECONDS, DIRECT_BATCH_SIZE, DIRECT_BATCH_PAUSE_SECONDS };
