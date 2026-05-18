/**
 * settings.js — Ajustes globales del CRM
 *
 * GET  /api/settings                  → Obtener ajustes actuales
 * PUT  /api/settings                  → Actualizar ajustes
 * POST /api/settings/sync-products    → Forzar sincronización de productos desde raigentic
 * GET  /api/settings/products         → Listar productos en cache (raigentic)
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db/database');
const raigentic = require('../services/raigentic');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/settings
 */
router.get('/', (req, res) => {
  try {
    const settings = {
      ai_enabled_global:      db.getSetting('ai_enabled_global') === 'true',
      ai_system_prompt_extra: db.getSetting('ai_system_prompt_extra') || '',
    };
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/settings
 */
router.put('/', (req, res) => {
  try {
    const { ai_enabled_global, ai_system_prompt_extra } = req.body;
    if (ai_enabled_global !== undefined)
      db.setSetting('ai_enabled_global', ai_enabled_global ? 'true' : 'false');
    if (ai_system_prompt_extra !== undefined)
      db.setSetting('ai_system_prompt_extra', ai_system_prompt_extra);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/settings/sync-products
 * Fuerza la sincronización completa de productos desde raigentic (llama POST /api/sync).
 * Solo necesario después de cambios masivos en el catálogo de Shopify.
 * Los webhooks de productos (create/update/delete) mantienen la DB al día automáticamente.
 */
router.post('/sync-products', async (req, res) => {
  try {
    const ds = db.getPrimaryDataSource(req.orgId);
    if (!ds?.config?.storeUrl) {
      return res.status(400).json({ success: false, error: 'No hay tienda Shopify configurada' });
    }

    const result = await raigentic.sincronizarProductos(ds.config.storeUrl);
    res.json({ success: true, message: 'Sincronización iniciada', data: result });
  } catch (err) {
    console.error('[Settings] Error sincronizando productos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings/products
 * Devuelve el catálogo de productos desde raigentic (DB local, rápido).
 */
router.get('/products', async (req, res) => {
  try {
    const ds = db.getPrimaryDataSource(req.orgId);
    if (!ds?.config?.storeUrl) {
      return res.status(400).json({ success: false, error: 'No hay tienda Shopify configurada' });
    }

    const result = await raigentic.getProductos(ds.config.storeUrl);
    res.json({
      success: true,
      data:    result.products || [],
      total:   result.total   || 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings/whatsapp
 * Devuelve la config actual de WhatsApp (tokens enmascarados para seguridad)
 */
router.get('/whatsapp', (req, res) => {
  try {
    const wc = db.getWhatsappConfig(req.orgId);
    if (!wc) return res.json({ success: true, data: null });

    const mask = (v) => v ? v.slice(0, 6) + '••••••' + v.slice(-4) : null;

    res.json({
      success: true,
      data: {
        provider:           wc.provider || 'meta',
        // Meta
        phoneNumberId:      wc.phone_number_id       || '',
        businessAccountId:  wc.business_account_id   || '',
        accessToken:        mask(wc.access_token),
        webhookVerifyToken: mask(wc.webhook_verify_token),
        // Twilio
        twilioAccountSid:   mask(wc.twilio_account_sid),
        twilioAuthToken:    mask(wc.twilio_auth_token),
        twilioPhoneNumber:  wc.twilio_phone_number    || '',
        // Estado
        status:             wc.status || 'pending',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings/whatsapp/test
 * Verifica que la config guardada es válida haciendo una llamada real a la API
 */
router.get('/whatsapp/test', async (req, res) => {
  try {
    const wc = db.getWhatsappConfig(req.orgId);
    if (!wc) return res.json({ success: false, error: 'No hay configuración de WhatsApp guardada' });

    if (wc.provider === 'twilio') {
      // Verificar credenciales Twilio consultando el número
      const axios = require('axios');
      const sid   = wc.twilio_account_sid;
      const token = wc.twilio_auth_token;
      if (!sid || !token) return res.json({ success: false, error: 'Faltan credenciales de Twilio en la DB' });
      await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        auth: { username: sid, password: token }, timeout: 8000,
      });
      res.json({ success: true, message: `Twilio OK · Cuenta ${sid.slice(0,10)}...` });

    } else {
      // Verificar token Meta consultando el Phone Number ID
      const axios = require('axios');
      const phoneId = wc.phone_number_id;
      const token   = wc.access_token;
      if (!phoneId || !token) return res.json({ success: false, error: 'Faltan Phone Number ID o Access Token en la DB' });
      const r = await axios.get(`https://graph.facebook.com/v18.0/${phoneId}`, {
        params: { access_token: token }, timeout: 8000,
      });
      const name = r.data?.verified_name || r.data?.display_phone_number || phoneId;
      res.json({ success: true, message: `Meta WhatsApp OK · ${name}` });
    }
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    res.json({ success: false, error: detail });
  }
});

/**
 * PUT /api/settings/whatsapp
 * Actualiza la config de WhatsApp/Twilio
 */
router.put('/whatsapp', (req, res) => {
  try {
    const { provider = 'meta' } = req.body;

    if (provider === 'twilio') {
      const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = req.body;
      if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
        return res.status(400).json({ success: false, error: 'Twilio requiere Account SID, Auth Token y número de teléfono' });
      }
      db.upsertWhatsappConfig(req.orgId, {
        provider: 'twilio',
        twilioAccountSid, twilioAuthToken, twilioPhoneNumber,
        status: 'connected',
      });
    } else {
      const { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken } = req.body;
      if (!phoneNumberId || !accessToken || !webhookVerifyToken) {
        return res.status(400).json({ success: false, error: 'Meta requiere Phone Number ID, Access Token y Webhook Verify Token' });
      }
      db.upsertWhatsappConfig(req.orgId, {
        provider: 'meta',
        phoneNumberId, businessAccountId, accessToken, webhookVerifyToken,
        status: 'connected',
      });
    }

    res.json({ success: true, message: `WhatsApp (${provider}) actualizado correctamente` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
