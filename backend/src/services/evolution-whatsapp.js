const axios = require('axios');

function credentials(config = {}) {
  const baseUrl = String(config.evolution_api_url || '').trim().replace(/\/+$/, '');
  const apiKey = String(config.evolution_api_key || '').trim();
  const instance = String(config.evolution_instance || '').trim();
  if (!baseUrl || !apiKey || !instance) {
    const error = new Error('Evolution API no está configurada completamente');
    error.code = 'EVOLUTION_NOT_CONFIGURED';
    throw error;
  }
  return { baseUrl, apiKey, instance };
}

function client(config) {
  const { baseUrl, apiKey } = credentials(config);
  return axios.create({
    baseURL: baseUrl,
    timeout: 15000,
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
  });
}

async function sendTextMessage(to, text, config) {
  const { instance } = credentials(config);
  const response = await client(config).post(`/message/sendText/${encodeURIComponent(instance)}`, {
    number: String(to).replace(/\D/g, ''),
    text,
  });
  const messageId = response.data?.key?.id || response.data?.message?.key?.id || response.data?.id || null;
  return { ...response.data, messageId };
}

async function sendMediaMessage(to, media, config) {
  const { instance } = credentials(config);
  const response = await client(config).post(`/message/sendMedia/${encodeURIComponent(instance)}`, {
    number: String(to).replace(/\D/g, ''),
    mediatype: media.type === 'image' ? 'image' : 'document',
    mimetype: media.mimeType,
    caption: media.caption || '',
    media: media.mediaUrl || media.buffer?.toString('base64'),
    fileName: media.fileName,
  });
  const messageId = response.data?.key?.id || response.data?.message?.key?.id || response.data?.id || null;
  return { ...response.data, messageId };
}

async function markAsRead(messageId, remoteJid, config) {
  if (!messageId || !remoteJid) return;
  const { instance } = credentials(config);
  try {
    await client(config).post(`/chat/markMessageAsRead/${encodeURIComponent(instance)}`, {
      readMessages: [{ remoteJid, fromMe: false, id: messageId }],
    });
  } catch { /* No crítico: cambia entre versiones de Evolution. */ }
}

function unwrapData(body) {
  const data = body?.data;
  return Array.isArray(data) ? data[0] : data;
}

function eventName(body) {
  return String(body?.event || '').toLowerCase().replace(/_/g, '.');
}

function textFromMessage(message = {}) {
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.listResponseMessage?.title
    || message.templateButtonReplyMessage?.selectedDisplayText
    || null;
}

function parseWebhookMessage(body) {
  const event = eventName(body);
  if (event && event !== 'messages.upsert') return null;
  const data = unwrapData(body);
  const key = data?.key;
  if (!key?.id || key.fromMe) return null;
  const remoteJid = key.remoteJid || data.remoteJid;
  if (!remoteJid || /@(g\.us|broadcast)$/i.test(remoteJid)) return null;
  const source = key.senderPn || data.senderPn || remoteJid;
  const from = String(source).split('@')[0].replace(/\D/g, '');
  let message = data.message || {};
  for (let depth = 0; depth < 5; depth++) {
    const nested = message.ephemeralMessage?.message || message.viewOnceMessage?.message
      || message.viewOnceMessageV2?.message || message.documentWithCaptionMessage?.message;
    if (!nested) break;
    message = nested;
  }
  const type = message.imageMessage ? 'image' : message.audioMessage ? 'audio'
    : message.documentMessage ? 'document' : message.videoMessage ? 'video' : 'text';
  const text = textFromMessage(message);
  if (!from || (!text && type === 'text')) return null;
  return {
    messageId: key.id,
    from,
    remoteJid,
    contactName: data.pushName || body.sender || null,
    timestamp: data.messageTimestamp || null,
    type,
    text: text || '',
    ...(type !== 'text' ? {
      mimeType: message[`${type}Message`]?.mimetype || null,
      fileName: message[`${type}Message`]?.fileName || null,
      mediaMessage: { key, message },
    } : {}),
  };
}

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
function mediaReference(channelId, messageId) {
  return `evolution:${channelId}:${Buffer.from(String(messageId)).toString('base64url')}`;
}

async function downloadMessageMedia(parsed, config) {
  const { instance } = credentials(config);
  const response = await client(config).post(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    message: parsed.mediaMessage || { key: { id: parsed.messageId } },
    convertToMp4: false,
  }, { timeout: 30000, maxRedirects: 0, maxContentLength: 15 * 1024 * 1024, maxBodyLength: 1024 * 1024 });
  const payload = response.data;
  const raw = typeof payload?.base64 === 'string' ? payload.base64 : '';
  const base64 = raw.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!base64 || base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('Evolution no entregó un archivo válido de hasta 10 MB');
  }
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.length > MAX_MEDIA_BYTES) throw new Error('Archivo vacío o demasiado grande');
  const contentType = String(payload.mimetype || parsed.mimeType || '').split(';')[0].trim().toLowerCase();
  if (!/^(image\/(jpeg|png|webp|gif)|audio\/(ogg|opus|mpeg|mp3|mp4|aac|wav|x-wav|webm)|video\/(mp4|webm)|application\/pdf)$/.test(contentType)) {
    throw new Error('Tipo de archivo no compatible');
  }
  return { data, contentType };
}

async function downloadMediaReference(orgId, ref) {
  const match = /^evolution:(\d+):([A-Za-z0-9_-]+)$/.exec(ref);
  if (!match) throw new Error('Referencia Evolution inválida');
  const channel = await require('../db/database').getWhatsappChannel(orgId, Number(match[1]));
  if (!channel || channel.provider !== 'evolution') throw new Error('Canal no disponible');
  const messageId = Buffer.from(match[2], 'base64url').toString('utf8');
  return downloadMessageMedia({ messageId }, channel);
}

function parseStatusUpdate(body) {
  if (eventName(body) !== 'messages.update') return null;
  const data = unwrapData(body);
  const raw = data?.status || data?.update?.status;
  const statusMap = {
    ERROR: 'failed', PENDING: 'pending', SERVER_ACK: 'sent',
    DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read',
    0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read',
  };
  const messageId = data?.key?.id || data?.id;
  if (!messageId || raw === undefined || raw === null) return null;
  return { messageId, status: statusMap[raw] || String(raw).toLowerCase(), error: data?.error || null };
}

function normalizeConnectionState(value) {
  const raw = String(value?.instance?.state || value?.state || value?.status || value || '').toLowerCase();
  if (['open', 'connected'].includes(raw)) return 'connected';
  if (['close', 'closed', 'disconnected'].includes(raw)) return 'disconnected';
  if (['connecting', 'pending'].includes(raw)) return raw;
  return raw || 'pending';
}

function parseConnectionUpdate(body) {
  if (eventName(body) !== 'connection.update') return null;
  const data = unwrapData(body) || body?.data || {};
  const status = normalizeConnectionState(data?.instance || data?.state || data?.status);
  const identity = data?.wuid || data?.me?.id || data?.user?.id || body?.sender || '';
  const phoneNumber = String(identity).split('@')[0].split(':')[0].replace(/\D/g, '') || null;
  return { status, phoneNumber };
}

async function getConnectionState(config) {
  const { instance } = credentials(config);
  const response = await client(config).get(`/instance/connectionState/${encodeURIComponent(instance)}`);
  return response.data;
}

async function createInstance(config) {
  const { instance } = credentials(config);
  const response = await client(config).post('/instance/create', {
    instanceName: instance,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
  });
  return response.data;
}

async function getConnectQr(config) {
  const { instance } = credentials(config);
  const response = await client(config).get(`/instance/connect/${encodeURIComponent(instance)}`);
  return response.data;
}

async function configureWebhook(config, webhookUrl) {
  const { instance } = credentials(config);
  const response = await client(config).post(`/webhook/set/${encodeURIComponent(instance)}`, {
    webhook: {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
    },
  });
  return response.data;
}

module.exports = {
  mediaReference, downloadMessageMedia, downloadMediaReference,
  sendTextMessage, sendMediaMessage, markAsRead, parseWebhookMessage, parseStatusUpdate,
  parseConnectionUpdate, normalizeConnectionState,
  getConnectionState, createInstance, getConnectQr, configureWebhook,
};
