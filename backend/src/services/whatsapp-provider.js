const meta = require('./whatsapp');
const twilio = require('./twilio-whatsapp');
const kapso = require('./kapso-whatsapp');
const evolution = require('./evolution-whatsapp');
const db = require('../db/database');

function serviceFor(config = {}) {
  if (config.provider === 'twilio') return twilio;
  if (config.provider === 'kapso') return kapso;
  if (config.provider === 'evolution') return evolution;
  return meta;
}

async function sendTextMessage(to, text, config) {
  return serviceFor(config).sendTextMessage(to, text, config);
}

async function sendMediaMessage(to, media, config) {
  const service = serviceFor(config);
  if (typeof service.sendMediaMessage !== 'function') throw new Error('El proveedor de WhatsApp no admite archivos');
  return service.sendMediaMessage(to, media, config);
}

function messageId(result) {
  return result?.messageId || result?.key?.id || result?.message?.key?.id || result?.messages?.[0]?.id || null;
}

async function configForConversation(orgId, conversation = null) {
  if (conversation?.whatsapp_channel_id) {
    const channel = await db.getWhatsappChannel(orgId, conversation.whatsapp_channel_id);
    if (channel) return channel;
  }
  const legacyConfig = await db.getWhatsappConfig(orgId);
  // Conversaciones creadas antes del soporte multicanal conservan su proveedor.
  if (conversation && legacyConfig) return legacyConfig;
  const defaultChannel = await db.getDefaultWhatsappChannel(orgId);
  if (defaultChannel) return defaultChannel;
  return legacyConfig;
}

module.exports = { serviceFor, sendTextMessage, sendMediaMessage, messageId, configForConversation };
