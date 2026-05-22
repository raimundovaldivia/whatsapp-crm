/**
 * setup.js — Wizard de configuración inicial del CRM
 *
 * Rutas:
 *   POST /api/setup/whatsapp      → Guardar credenciales de WhatsApp Business
 *   POST /api/setup/shopify       → Conectar tienda (via raigentic)
 *   GET  /api/setup/shopify-status → Estado de la conexión Shopify
 *   POST /api/setup/complete      → Marcar setup como terminado
 *   GET  /api/setup/status        → Estado general del setup
 */

const express    = require('express');
const router     = express.Router();
const axios      = require('axios');
const db         = require('../db/database');
const raigentic  = require('../services/raigentic');
const { requireAuth } = require('../middleware/auth');

/* ─────────────────────────────────────────────────────────────
   WHATSAPP
───────────────────────────────────────────────────────────── */

/**
 * POST /api/setup/whatsapp
 * Guarda las credenciales de WhatsApp — soporta Meta y Twilio.
 *
 * Body Meta:   { provider:'meta', phoneNumberId, businessAccountId, accessToken, webhookVerifyToken }
 * Body Twilio: { provider:'twilio', twilioAccountSid, twilioAuthToken, twilioPhoneNumber }
 */
router.post('/whatsapp', requireAuth, async (req, res) => {
  try {
    const { provider = 'meta' } = req.body;

    if (provider === 'twilio') {
      const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = req.body;
      if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
        return res.status(400).json({ success: false, error: 'Faltan campos Twilio requeridos' });
      }

      db.upsertWhatsappConfig(req.orgId, {
        provider: 'twilio',
        twilioAccountSid, twilioAuthToken, twilioPhoneNumber,
      });

      res.json({ success: true, message: 'Twilio WhatsApp configurado correctamente' });

    } else {
      // Meta Cloud API
      const { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken } = req.body;
      if (!phoneNumberId || !accessToken || !webhookVerifyToken) {
        return res.status(400).json({ success: false, error: 'Faltan campos Meta requeridos' });
      }

      db.upsertWhatsappConfig(req.orgId, {
        provider: 'meta',
        phoneNumberId, businessAccountId, accessToken, webhookVerifyToken,
      });

      // Test rápido del token (no bloquea si falla)
      let tokenWarning = null;
      try {
        await axios.get('https://graph.facebook.com/v19.0/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch {
        tokenWarning = 'El token podría estar expirado. Genera uno permanente desde Usuarios del sistema en Meta.';
      }

      res.json({ success: true, message: 'WhatsApp Meta configurado', warning: tokenWarning });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   SHOPIFY (via raigentic)
───────────────────────────────────────────────────────────── */

/**
 * POST /api/setup/shopify
 * Guarda la tienda Shopify y verifica la conexión via raigentic.
 *
 * Requisito previo: el merchant debe haber instalado la app raigentic
 * en su tienda (Shopify Partner App). raigentic tiene el token OAuth;
 * el CRM solo necesita saber el dominio de la tienda.
 *
 * Body: { storeUrl: "mi-tienda.myshopify.com" }
 */
router.post('/shopify', requireAuth, async (req, res) => {
  try {
    const { storeUrl } = req.body;
    if (!storeUrl) {
      return res.status(400).json({ success: false, error: 'storeUrl es requerido' });
    }

    const shop = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Verificar que raigentic puede alcanzar esa tienda
    // Si raigentic está dormido (502/503/504) guardamos igual y avisamos
    let productCount = 0;
    let raigenticWarning = null;
    try {
      const result = await raigentic.getProductos(shop, { limit: 1 });
      productCount = result.total || (result.products?.length ? 'varios' : 0);
    } catch (err) {
      const status = err.response?.status;
      const isSleeping = !status || status === 502 || status === 503 || status === 504;

      if (isSleeping) {
        // Raigentic está despertando — guardar tienda igual, el bot se conectará cuando despierte
        raigenticWarning = `raigentic está iniciando (cold start). Los productos se sincronizarán automáticamente en 1-2 minutos. Puedes continuar el setup.`;
        console.warn(`[Setup/Shopify] raigentic dormido (${status}), guardando tienda de todas formas: ${shop}`);
      } else {
        // Error real: tienda no instaló la app raigentic
        return res.status(400).json({
          success: false,
          error: `No se pudo verificar la tienda via raigentic. ¿Instalaste la app raigentic en ${shop}? (${err.message})`,
        });
      }
    }

    // Guardar el data source (sin accessToken — raigentic lo maneja)
    const existing = db.getPrimaryDataSource(req.orgId);
    if (existing) {
      // Actualizar si ya existía
      db.getDb().prepare('UPDATE data_sources SET name=?, config=?, status=? WHERE id=?')
        .run(shop, JSON.stringify({ storeUrl: shop }), 'connected', existing.id);
    } else {
      const ds = db.createDataSource({
        organizationId: req.orgId,
        type: 'shopify',
        name: shop,
        config: { storeUrl: shop },
      });
      db.updateDataSourceStatus(ds.id, 'connected');
      db.createDefaultAgents(req.orgId, ds.id);
    }

    res.json({
      success: true,
      message: `Shopify conectado: ${shop}`,
      warning: raigenticWarning,
      data: { storeUrl: shop, productCount },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/setup/shopify-status
 * Devuelve si la tienda Shopify está configurada.
 */
router.get('/shopify-status', requireAuth, (req, res) => {
  try {
    const ds = db.getPrimaryDataSource(req.orgId);
    res.json({
      success:   true,
      connected: !!ds,
      storeName: ds?.name || null,
      storeUrl:  ds?.config?.storeUrl || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   COMPLETAR SETUP
───────────────────────────────────────────────────────────── */

/**
 * POST /api/setup/complete
 * Marca el setup como terminado y habilita el CRM.
 */
router.post('/complete', requireAuth, (req, res) => {
  try {
    db.markSetupDone(req.orgId);
    const wc = db.getWhatsappConfig(req.orgId);
    const ds = db.getPrimaryDataSource(req.orgId);
    res.json({
      success: true,
      message: '¡Setup completado!',
      warnings: [
        ...(!wc ? ['WhatsApp no configurado — conéctalo desde Ajustes'] : []),
        ...(!ds  ? ['Shopify no conectado — conéctalo desde Ajustes'] : []),
      ],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/setup/status
 * Estado general del setup para el wizard.
 */
router.get('/status', requireAuth, (req, res) => {
  try {
    const org    = db.getOrgById(req.orgId);
    const wc     = db.getWhatsappConfig(req.orgId);
    const ds     = db.getPrimaryDataSource(req.orgId);
    const agents = db.getAgents(req.orgId);

    res.json({
      success: true,
      data: {
        setupDone: !!org.setup_done,
        steps: {
          whatsapp: { done: !!(wc?.status === 'connected'), phoneNumberId: wc?.phone_number_id },
          shopify:  { done: !!(ds?.status === 'connected'), storeName: ds?.name },
          agents:   { done: agents.length >= 3, count: agents.length },
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
