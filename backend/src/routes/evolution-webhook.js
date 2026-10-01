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

  const status = evolution.parseStatusUpdate(req.body);
  if (status) {
    const updated = await db.updateMessageStatus(status.messageId, status.status, status.error, orgId);
    if (updated) io?.to(`org_${orgId}`).emit(`status_update_${orgId}`, { ...status, error: updated.delivery_error });
    return;
  }

  const parsed = evolution.parseWebhookMessage(req.body);
  if (!parsed) return;
  console.log(`[EvolutionWebhook] [Org:${org.name}] ${parsed.from}: ${parsed.text}`);

  await processInboundText({
    org,
    whatsappConfig: channel,
    parsed,
    io,
    whatsappChannelId: channel.id,
    markAsRead: () => evolution.markAsRead(parsed.messageId, parsed.remoteJid, channel),
  });
}));

module.exports = router;
module.exports.setSocketIO = setSocketIO;
