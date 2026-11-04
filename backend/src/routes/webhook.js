const express = require('express');
const router = express.Router();
const db = require('../db/database');
const whatsappService = require('../services/whatsapp');
const official = require('./kapso-webhook');
const setSocketIO = official.setSocketIO;

/**
 * GET /webhook — Verificación de Meta
 * Meta envía hub.verify_token; lo comparamos con el de la org
 * También acepta WEBHOOK_VERIFY_TOKEN como fallback de env var
 */
router.get('/', async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (typeof token !== 'string' || typeof challenge !== 'string' || challenge.length > 1024) return res.sendStatus(403);

  if (mode !== 'subscribe') {
    console.warn('[Webhook] ❌ hub.mode inválido:', mode);
    return res.sendStatus(403);
  }

  // 1. Verificar con token global de env var (fallback para setup inicial)
  const envToken = process.env.WEBHOOK_VERIFY_TOKEN;
  if (envToken && token === envToken) {
    console.log('[Webhook] ✅ Verificado via WEBHOOK_VERIFY_TOKEN env var');
    return res.status(200).send(challenge);
  }

  // 2. Cada cliente tiene su propio token guardado en la DB al hacer el setup
  const result = await db.getOrgByWebhookToken(token);
  if (!result) {
    console.warn('[Webhook] Token de verificación inválido');
    return res.sendStatus(403);
  }

  console.log(`[Webhook] ✅ Verificado para org: ${result.org.name}`);
  return res.status(200).send(challenge);
});

/**
 * POST /webhook — Mensajes entrantes de WhatsApp
 */
router.post('/', require('../middleware/webhook-auth').verifyWebhook('meta'),
  require('../services/webhook-inbox').durableWebhook('meta', (req, res) =>
    official.handleOfficialWebhook(req, res, 'meta', whatsappService)));

module.exports = router;
module.exports.setSocketIO = setSocketIO;
