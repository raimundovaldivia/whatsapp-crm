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
  if (!key || key.fromMe) return null;
  const remoteJid = key.remoteJid || data.remoteJid;
  if (!remoteJid || /@(g\.us|broadcast)$/i.test(remoteJid)) return null;
  const source = key.senderPn || data.senderPn || remoteJid;
  const from = String(source).split('@')[0].replace(/\D/g, '');
  const text = textFromMessage(data.message || {});
  if (!from || !text) return null;
  return {
    messageId: key.id,
    from,
    remoteJid,
    contactName: data.pushName || body.sender || null,
    timestamp: data.messageTimestamp || null,
    type: 'text',
    text,
  };
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
  sendTextMessage, sendMediaMessage, markAsRead, parseWebhookMessage, parseStatusUpdate,
  getConnectionState, createInstance, getConnectQr, configureWebhook,
};
