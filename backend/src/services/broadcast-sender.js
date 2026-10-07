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
function pacingSettings(input = {}) {
  input = input || {};
  const defaults = { intervalSeconds: 60, batchSize: 10, batchPauseSeconds: 300 };
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = Number(input[key] ?? fallback);
    const min = key === 'batchPauseSeconds' ? 0 : 1;
    const max = key === 'batchSize' ? 5000 : 86400;
    if (!Number.isInteger(value) || value < min || value > max) throw error(`Valor inválido para ${key}`, 400);
    result[key] = value;
  }
  return result;
}
// Shared by all tabs using this channel. Campaign changes do not bypass an active wait.
async function claimDirectSlot(orgId, channelId, settings = {}, campaignId = null) {
  const { intervalSeconds, batchSize, batchPauseSeconds } = pacingSettings(settings);
  const pause = Math.max(intervalSeconds, batchPauseSeconds);
  const pool = db.getPool();
  const { rows } = await pool.query(
    `INSERT INTO broadcast_channel_pacing (organization_id, channel_id, campaign_id, batch_count, next_send_at)
     VALUES ($1, $2, $6, 1, NOW() + CASE WHEN $4 = 1 THEN $5::integer ELSE $3::integer END * INTERVAL '1 second')
     ON CONFLICT (organization_id, channel_id) DO UPDATE SET
       campaign_id = $6,
       batch_count = CASE WHEN broadcast_channel_pacing.campaign_id IS DISTINCT FROM $6
         THEN 1 ELSE (broadcast_channel_pacing.batch_count % $4) + 1 END,
       next_send_at = NOW() + CASE WHEN
         (CASE WHEN broadcast_channel_pacing.campaign_id IS DISTINCT FROM $6 THEN 1
          ELSE (broadcast_channel_pacing.batch_count % $4) + 1 END) = $4 THEN $5::integer ELSE $3::integer END * INTERVAL '1 second'
     WHERE broadcast_channel_pacing.next_send_at <= NOW()
     RETURNING next_send_at`, [orgId, channelId, intervalSeconds, batchSize, pause, campaignId]);
  if (rows.length) return { allowed: true, retryAfterSeconds: 0 };
  const result = await pool.query(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (next_send_at - NOW()))))::int AS wait_seconds
     FROM broadcast_channel_pacing WHERE organization_id = $1 AND channel_id = $2`, [orgId, channelId]);
  return { allowed: false, retryAfterSeconds: result.rows[0]?.wait_seconds || intervalSeconds };
}
module.exports = { resolveSender, sendingMethods, claimDirectSlot, pacingSettings, DIRECT_INTERVAL_SECONDS, DIRECT_BATCH_SIZE, DIRECT_BATCH_PAUSE_SECONDS };
