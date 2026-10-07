const crypto = require('crypto');
const db = require('../db/database');
const evolution = require('./evolution-whatsapp');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const safe = channel => channel ? ({ id: channel.id, name: channel.name, phone_number: channel.phone_number,
  expected_phone: channel.expected_phone, status: channel.status, assigned_user_id: channel.assigned_user_id }) : null;

async function getChannel(orgId, userId) {
  const { rows } = await db.getPool().query(
    'SELECT * FROM whatsapp_channels WHERE organization_id = $1 AND assigned_user_id = $2', [orgId, userId]);
  return rows[0] || null;
}

async function prepare(orgId, userId, phone) {
  const normalized = String(phone || '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(normalized)) throw fail('Ingresa el WhatsApp del despachador con código de país', 400);
  const client = await db.getPool().connect();
  let channel;
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE', [userId, orgId]);
    if (!user || user.merged_into_user_id || !['repartidor', 'coordinador'].includes(user.role)) throw fail('Despachador no encontrado', 404);
    channel = (await client.query('SELECT * FROM whatsapp_channels WHERE organization_id=$1 AND assigned_user_id=$2', [orgId, userId])).rows[0];
    if (channel && channel.expected_phone !== normalized) throw fail('Este usuario ya tiene otro WhatsApp asociado');
    if (!channel) {
      const source = await db.getEvolutionWhatsappChannel(orgId);
      if (!source) throw fail('Primero configura el servidor Evolution en Conexiones');
      const instance = `despacho-${orgId}-${userId}-${crypto.randomBytes(6).toString('hex')}`;
      channel = (await client.query(`INSERT INTO whatsapp_channels
        (organization_id,provider,name,evolution_api_url,evolution_api_key,evolution_instance,webhook_token,
         assigned_user_id,expected_phone,status,is_default)
        VALUES ($1,'evolution',$2,$3,$4,$5,$6,$7,$8,'pending',false) RETURNING *`,
      [orgId, `${user.name} · Despachador`, source.evolution_api_url, source.evolution_api_key,
        instance, crypto.randomBytes(24).toString('hex'), userId, normalized])).rows[0];
    }
    await client.query('UPDATE users SET whatsapp_phone=$1 WHERE id=$2 AND organization_id=$3', [normalized, userId, orgId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  // Save the dedicated instance before contacting Evolution, so retries reuse it.
  try { await evolution.getConnectionState(channel); }
  catch (error) {
    if (error.response?.status !== 404) throw fail('No se pudo consultar Evolution. Reintenta la conexión.', 502);
    try { await evolution.createInstance(channel); }
    catch { throw fail('No se pudo crear la conexión en Evolution. Revisa los permisos del servidor y reintenta.', 502); }
  }
  await webhook(channel);
  return inspect(orgId, userId, true);
}

async function webhook(channel) {
  const publicUrl = process.env.CRM_PUBLIC_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL;
  if (!publicUrl) throw fail('Falta configurar la dirección pública del servidor', 503);
  await evolution.configureWebhook(channel, `${publicUrl.replace(/\/$/, '')}/evolution-webhook/${channel.organization_id}/${channel.id}/${channel.webhook_token}`);
}

async function inspect(orgId, userId, withQr = false) {
  const channel = await getChannel(orgId, userId);
  if (!channel) return { channel: null, qr: null };
  let state = evolution.normalizeConnectionState(await evolution.getConnectionState(channel));
  let phone = null;
  if (state === 'connected') {
    phone = await evolution.getConnectedPhone(channel);
    state = !phone ? 'pending_verification' : phone === channel.expected_phone ? 'connected' : 'wrong_number';
    if (state === 'connected' && channel.status !== 'connected') await webhook(channel);
  }
  const updated = await db.updateWhatsappChannelStatus(orgId, channel.id, state, phone);
  const qr = withQr && ['pending', 'connecting', 'disconnected'].includes(state)
    ? await evolution.getConnectQr(channel) : null;
  return { channel: safe(updated), qr: qr ? { base64: qr.base64 || qr.qrcode?.base64 || null } : null };
}

async function route(orgId, stop, create = false) {
  if (!stop.driver_user_id) return null;
  const config = await getChannel(orgId, stop.driver_user_id);
  if (!config) return null;
  const available = config.status === 'connected' && config.phone_number === config.expected_phone;
  let conversation = (await db.getPool().query(`SELECT * FROM conversations
    WHERE organization_id=$1 AND whatsapp_channel_id=$2 AND phone_number=$3 LIMIT 1`,
  [orgId, config.id, db.normalizePhone(stop.phone)])).rows[0] || null;
  if (create && available && !conversation) {
    conversation = await db.upsertConversation(orgId, stop.phone, stop.customerName || stop.customer_name || 'Cliente', config.id);
  }
  if (conversation) await db.setAgentMode(conversation.id, 'human');
  return { config, conversation, available, personal: true, channel: 'evolution', fallback: false,
    window: {}, sender: safe(config), message: available
      ? `Envías desde ${config.name} · +${config.phone_number}`
      : `Vincula el WhatsApp +${config.expected_phone} del despachador desde Equipo para conversar.` };
}

module.exports = { prepare, inspect, getChannel, route, safe };
