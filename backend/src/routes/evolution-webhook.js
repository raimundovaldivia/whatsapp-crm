const crypto = require('node:crypto');
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const evolution = require('../services/evolution-whatsapp');
const { processInboundText } = require('../services/inbound-text');
const { durableWebhook } = require('../services/webhook-inbox');

let io;
function setSocketIO(socketIO) { io = socketIO; }

function sameToken(received, expected) {
  const a = Buffer.from(String(received || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function authenticate(req, res, next) {
  try {
    const orgId = Number(req.params.orgId);
    const channel = await db.getWhatsappChannel(orgId, Number(req.params.channelId));
    if (!channel || channel.provider !== 'evolution' || !sameToken(req.params.token, channel.webhook_token)) {
      return res.sendStatus(401);
    }
    req.evolutionChannel = channel;
    next();
  } catch (error) {
    console.error('[EvolutionWebhook] autenticación:', error.message);
    res.sendStatus(500);
  }
}

router.post('/:orgId/:channelId/:token', authenticate, durableWebhook('evolution', async (req, res) => {
  res.sendStatus(200);
  const orgId = Number(req.params.orgId);
  const channelId = Number(req.params.channelId);
  const [org, channel] = await Promise.all([
    db.getOrgById(orgId),
    db.getWhatsappChannel(orgId, channelId),
  ]);
  if (!org || channel?.provider !== 'evolution') return;

  const connection = evolution.parseConnectionUpdate(req.body);
  if (connection) {
    const updated = await db.updateWhatsappChannelStatus(orgId, channelId, channel.assigned_user_id && connection.status === 'connected'
      ? (!connection.phoneNumber ? 'pending_verification' : connection.phoneNumber === channel.expected_phone ? 'connected' : 'wrong_number')
      : connection.status, connection.phoneNumber);
    if (updated) io?.to(`org_${orgId}`).emit(`whatsapp_channel_update_${orgId}`, {
      id: channelId,
      status: updated.status,
      phoneNumber: connection.phoneNumber || updated.phone_number || null,
    });
    console.log(`[EvolutionWebhook] [Org:${org.name}] canal ${channelId}: ${connection.status}`);
    return;
  }

  const status = evolution.parseStatusUpdate(req.body);
  if (status) {
    const updated = await db.updateMessageStatus(status.messageId, status.status, status.error, orgId);
    if (updated) io?.to(`org_${orgId}`).emit(`status_update_${orgId}`, { ...status, error: updated.delivery_error });
    return;
  }

  const messages = Array.isArray(req.body.data) ? req.body.data : [req.body.data];
  for (const data of messages) {
    const parsed = evolution.parseWebhookMessage({ ...req.body, data }, {
      includeOwn: true,
      ownPhone: channel.phone_number || channel.expected_phone,
    });
    if (!parsed) continue;
    // Evolution can replay the same phone message after reconnecting. Check it
    // before upserting the conversation so a stale echo cannot leave an empty chat.
    if (db.getMessageByWhatsappId && await db.getMessageByWhatsappId(org.id, parsed.messageId)) continue;
    if (channel.assigned_user_id) {
      // Dispatcher messages are human conversations: no sales bot, payment parser or scheduled response.
      const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName, channel.id);
      await db.setAgentMode(conversation.id, 'human');
      const content = parsed.text || (parsed.type === 'audio' ? '🎤 [Audio]' : '📎 [Archivo]');
      const message = await db.saveMessage({ conversationId: conversation.id, whatsappMessageId: parsed.messageId,
        direction: parsed.fromMe ? 'outbound' : 'inbound', content, type: parsed.type,
        sentBy: parsed.fromMe ? 'human' : 'client',
        mediaId: parsed.type === 'text' ? null : evolution.mediaReference(channel.id, parsed.messageId) });
      if (message) {
        await db.updateConversationLastMessage(conversation.id, content);
        io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message, conversation: await db.getConversationById(conversation.id, org.id) });
      }
      continue;
    }
    if (parsed.fromMe) {
      if (await evolution.isApiMessage(parsed.messageId, channel)) continue;
      const conversation = await db.upsertConversation(org.id, parsed.from, null, channel.id);
      const content = parsed.text || (parsed.type === 'audio' ? '🎤 [Audio enviado]' : '📎 [Archivo enviado]');
      const message = await db.saveMessage({ conversationId: conversation.id, whatsappMessageId: parsed.messageId,
        direction: 'outbound', content, type: parsed.type, sentBy: 'human',
        mediaId: parsed.type === 'text' ? null : evolution.mediaReference(channel.id, parsed.messageId) });
      if (message) {
        await require('../services/conversation-mode').keepHumanAfterReply(conversation.id, db);
        io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'human' });
        await db.updateConversationLastMessage(conversation.id, content);
        io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message, conversation: await db.getConversationById(conversation.id, org.id) });
      }
      continue;
    }
    const markAsRead = () => evolution.markAsRead(parsed.messageId, parsed.remoteJid, channel);
    let prepareMedia = null;
    if (parsed.type !== 'text') {
      parsed.mediaId = evolution.mediaReference(channel.id, parsed.messageId);
      const mediaService = {
        getMediaUrl: async () => ({ url: parsed.mediaId }),
        downloadMedia: async () => {
          const media = await evolution.downloadMessageMedia(parsed, channel);
          require('../services/media-cache').set(`${org.id}:${parsed.mediaId}`, media.data, media.contentType);
          return media;
        },
        markAsRead,
        sendTextMessage: evolution.sendTextMessage,
      };
      const image = parsed.type === 'image' || (parsed.type === 'document' && /^image\/(jpeg|png|gif|webp)(;|$)/i.test(parsed.mimeType || ''));
      if (image) {
        await require('./kapso-webhook').handlePaymentProof(org, channel, parsed, { service: mediaService, io, channelId: channel.id });
        continue;
      }
      const caption = parsed.text;
      parsed.text = caption || (parsed.type === 'audio' ? '🎤 [Audio]' : parsed.type === 'video' ? '🎥 [Video]' : '📎 [Documento]');
      prepareMedia = async () => {
        if (parsed.type === 'audio' && process.env.OPENAI_API_KEY) {
          try {
            const transcript = await require('./kapso-webhook').transcribeAudio(parsed, channel, mediaService);
            if (transcript) return { text: `🎤 ${transcript}` };
          } catch (error) { console.warn('[EvolutionWebhook] No se pudo transcribir el audio:', error.message); }
        }
        if (caption) return { text: caption };
        return { fallback: parsed.type === 'audio'
          ? 'Recibí tu audio, pero no pude transcribirlo esta vez. ¿Puedes escribirme lo que necesitas?'
          : 'Recibí tu archivo. ¿Puedes contarme por escrito qué necesitas revisar?' };
      };
    }
    await processInboundText({
      org,
      whatsappConfig: channel,
      parsed,
      io,
      whatsappChannelId: channel.id,
      markAsRead,
      prepareMedia,
      scheduleResponse: fn => require('../services/webhook-inbox').defer(`${org.id}:${channel.id}:${parsed.from}`, fn),
    });
  }
}));

module.exports = router;
module.exports.setSocketIO = setSocketIO;
