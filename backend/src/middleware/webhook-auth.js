const crypto = require('crypto');
const db = require('../db/database');

function validHmac(raw, signature, secret, encoding = 'hex', prefix = '') {
  if (!secret || !Buffer.isBuffer(raw) || typeof signature !== 'string') return false;
  const expected = prefix + crypto.createHmac('sha256', secret).update(raw).digest(encoding);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWebhook(provider) {
  return async (req, res, next) => {
    try {
      if (provider === 'meta') {
        if (!validHmac(req.rawBody, req.headers['x-hub-signature-256'], process.env.META_APP_SECRET, 'hex', 'sha256=')) return res.sendStatus(401);
        const events = require('../services/meta-events').splitMetaPayload(req.body);
        const configs = new Map();
        req.webhookDeliveries = [];
        for (const event of events) {
          if (!event.phoneNumberId) return res.sendStatus(401);
          if (!configs.has(event.phoneNumberId)) configs.set(event.phoneNumberId, await db.getOrgByPhoneNumberId(event.phoneNumberId));
          const result = configs.get(event.phoneNumberId);
          if (!result || result.whatsappConfig?.provider !== 'meta') return res.sendStatus(401);
          req.webhookDeliveries.push({ orgId: result.org.id, body: event.body });
        }
        return next();
      }
      let result, valid = false;
      if (provider === 'kapso') {
        const id = req.body?.phone_number_id;
        if (id) result = await db.getOrgByPhoneNumberId(id);
        if (!result) return res.sendStatus(401);
        const config = result.whatsappConfig;
        valid = config.provider === 'kapso' && validHmac(req.rawBody,
          req.headers['x-webhook-signature'], config.webhook_secret || process.env.KAPSO_WEBHOOK_SECRET);
      } else if (provider === 'twilio') {
        const number = req.body?.To?.replace('whatsapp:', '');
        if (number) result = await db.getOrgByTwilioNumber(number);
        if (!result || result.whatsappConfig.provider !== 'twilio') return res.sendStatus(401);
        const base = process.env.CRM_PUBLIC_URL;
        if (base && result.whatsappConfig.twilio_auth_token) {
          const url = new URL(req.originalUrl, base).href;
          valid = require('twilio').validateRequest(result.whatsappConfig.twilio_auth_token,
            req.headers['x-twilio-signature'] || '', url, req.body);
        }
      }
      if (!valid) return res.sendStatus(401);
      req.webhookOrg = result.org;
      next();
    } catch (err) {
      console.error('[WebhookAuth]', provider, err.message);
      res.sendStatus(503);
    }
  };
}

module.exports = { validHmac, verifyWebhook };
