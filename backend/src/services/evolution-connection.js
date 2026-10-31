'use strict';

const db = require('../db/database');
const evolution = require('./evolution-whatsapp');
const { createHash } = require('node:crypto');
const checks = new Map();
const hooks = new Set();
const TTL = 10000;
const failure = (message, status) => Object.assign(new Error(message), { status });

// Check the actual instance, independently of whether Settings was ever opened.
// Short-lived caching and shared promises avoid duplicate requests from multiple tabs.
async function refreshChannel(orgId, channelId, { force = false } = {}) {
  const channel = await db.getWhatsappChannel(orgId, Number(channelId));
  if (!channel || channel.provider !== 'evolution' || channel.assigned_user_id) {
    throw failure('Conexión comercial no disponible', 404);
  }
  const publicUrl = process.env.CRM_PUBLIC_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL;
  const identity = createHash('sha256').update(JSON.stringify([
    orgId, channel.id, channel.evolution_api_url, channel.evolution_instance,
    channel.evolution_api_key || process.env.EVOLUTION_API_KEY, channel.webhook_token, publicUrl,
  ])).digest('hex');
  const previous = checks.get(identity);
  if (previous?.pending) return previous.pending;
  if (!force && previous?.expires > Date.now() && previous.result.state === channel.status) {
    return { ...previous.result, channel: { ...channel, status: previous.result.state } };
  }
  const entry = {};
  const pending = (async () => {
    let state;
    try {
      state = evolution.normalizeConnectionState(await evolution.getConnectionState(channel, { timeout: 8000 }));
    } catch {
      // An API timeout is not evidence that WhatsApp disconnected. Keep the last
      // known DB state, but do not authorize a send using that stale state.
      throw failure('No se pudo verificar la conexión con Evolution. Reintenta en unos segundos.', 503);
    }
    if (!['connected', 'disconnected', 'connecting', 'pending'].includes(state)) {
      throw failure('Evolution devolvió un estado de conexión desconocido. Reintenta la consulta.', 503);
    }
    const updated = state === channel.status ? channel
      : await db.updateWhatsappChannelStatus(orgId, channel.id, state);
    if (!updated) throw failure('Conexión comercial no disponible', 404);
    let warning = null;
    if (state !== 'connected') hooks.delete(identity);
    // Retry failed registration even if the connection was already marked open.
    // Also repair missed connection webhooks once after a backend restart.
    if (state === 'connected' && !hooks.has(identity)) {
      if (!publicUrl || !channel.webhook_token) {
        warning = 'WhatsApp está conectado, pero falta configurar la recepción de respuestas.';
      } else {
        try {
          const url = `${publicUrl.replace(/\/$/, '')}/evolution-webhook/${orgId}/${channel.id}/${channel.webhook_token}`;
          await evolution.configureWebhook(channel, url, { timeout: 8000 });
          if (hooks.size >= 1000) hooks.clear();
          hooks.add(identity);
        } catch {
          warning = 'WhatsApp está conectado, pero no se pudo configurar la recepción de respuestas. Reintenta.';
        }
      }
    }
    return { channel: updated, state, warning, checkedAt: new Date().toISOString() };
  })();
  entry.pending = pending;
  if (checks.size >= 1000) for (const [key, value] of checks) if (!value.pending) checks.delete(key);
  checks.set(identity, entry);
  try {
    const result = await pending;
    entry.result = result;
    entry.expires = Date.now() + TTL;
    return result;
  } finally {
    delete entry.pending;
    if (!entry.result) checks.delete(identity);
  }
}

// Preserve the public channel shape; never return API keys or webhook tokens.
async function refreshedChannels(orgId) {
  const channels = await db.listWhatsappChannels(orgId);
  return Promise.all(channels.map(async channel => {
    if (channel.provider !== 'evolution') return channel;
    try {
      const result = await refreshChannel(orgId, channel.id);
      return { ...channel, status: result.state, checked_at: result.checkedAt,
        connection_warning: result.warning };
    } catch {
      return { ...channel, status: 'unverified', connection_warning: 'No se pudo verificar Evolution. Reintenta la consulta.' };
    }
  }));
}

module.exports = { refreshChannel, refreshedChannels };
