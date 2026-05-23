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
const { getPool } = require('../db/database');
const raigentic  = require('../services/raigentic');
const { requireAuth } = require('../middleware/auth');

/* ─────────────────────────────────────────────────────────────
   WHATSAPP
───────────────────────────────────────────────────────────── */

/**
 * POST /api/setup/whatsapp
 * Guarda las credenciales de WhatsApp — soporta Meta, Twilio y Kapso.
 *
 * Body Meta:   { provider:'meta',   phoneNumberId, businessAccountId, accessToken, webhookVerifyToken }
 * Body Twilio: { provider:'twilio', twilioAccountSid, twilioAuthToken, twilioPhoneNumber }
 * Body Kapso:  { provider:'kapso',  kapsoApiKey, phoneNumberId, webhookSecret? }
 */
router.post('/whatsapp', requireAuth, async (req, res) => {
  try {
    const { provider = 'meta' } = req.body;

    if (provider === 'twilio') {
      const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = req.body;
      if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
        return res.status(400).json({ success: false, error: 'Faltan campos Twilio requeridos' });
      }

      await db.upsertWhatsappConfig(req.orgId, {
        provider: 'twilio',
        twilioAccountSid, twilioAuthToken, twilioPhoneNumber,
      });

      res.json({ success: true, message: 'Twilio WhatsApp configurado correctamente' });

    } else if (provider === 'kapso') {
      // ── Kapso: sin proceso de Meta, solo API key y phone_number_id ──
      const { kapsoApiKey, phoneNumberId, webhookSecret } = req.body;
      if (!kapsoApiKey || !phoneNumberId) {
        return res.status(400).json({ success: false, error: 'Faltan campos Kapso requeridos: kapsoApiKey y phoneNumberId' });
      }

      await db.upsertWhatsappConfig(req.orgId, {
        provider: 'kapso',
        phoneNumberId,
        kapsoApiKey,
        webhookSecret: webhookSecret || null,
      });

      // Test rápido: verificar que la API key es válida listando números
      let warning = null;
      try {
        await axios.get('https://api.kapso.ai/v1/phone-numbers', {
          headers: { 'X-API-Key': kapsoApiKey },
          timeout: 8000,
        });
      } catch (err) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
          warning = 'La Kapso API Key no es válida. Verifica en app.kapso.ai → Settings → API Keys.';
        } else {
          // No bloqueamos si el test falla por otras razones (timeout, etc.)
          console.warn('[Setup/Kapso] Test de API Key falló:', err.message);
        }
      }

      res.json({
        success: true,
        message: 'Kapso WhatsApp configurado correctamente',
        warning,
        data: {
          webhookUrl: `${process.env.PUBLIC_URL || 'https://TU-BACKEND.onrender.com'}/kapso-webhook`,
          instructions: [
            '1. Ve a app.kapso.ai → tu número → Webhooks',
            '2. Agrega un webhook con la URL anterior',
            '3. Suscríbete al evento: whatsapp.message.received',
            '4. (Opcional) Habilita firma y guarda el secret en webhookSecret',
          ],
        },
      });

    } else {
      // ── Meta Cloud API ──────────────────────────────────────────────
      const { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken } = req.body;
      if (!phoneNumberId || !accessToken || !webhookVerifyToken) {
        return res.status(400).json({ success: false, error: 'Faltan campos Meta requeridos' });
      }

      await db.upsertWhatsappConfig(req.orgId, {
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
 * Body: { storeUrl: "mi-tienda.myshopify.com" }
 */
router.post('/shopify', requireAuth, async (req, res) => {
  try {
    const { storeUrl } = req.body;
    if (!storeUrl) {
      return res.status(400).json({ success: false, error: 'storeUrl es requerido' });
    }

    const shop = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

    let productCount = 0;
    let raigenticWarning = null;
    try {
      const result = await raigentic.getProductos(shop, { limit: 1 });
      productCount = result.total || (result.products?.length ? 'varios' : 0);
    } catch (err) {
      const status = err.response?.status;
      const isSleeping = !status || status === 502 || status === 503 || status === 504;

      if (isSleeping) {
        raigenticWarning = `raigentic está iniciando (cold start). Los productos se sincronizarán automáticamente en 1-2 minutos. Puedes continuar el setup.`;
        console.warn(`[Setup/Shopify] raigentic dormido (${status}), guardando tienda de todas formas: ${shop}`);
      } else {
        return res.status(400).json({
          success: false,
          error: `No se pudo verificar la tienda via raigentic. ¿Instalaste la app raigentic en ${shop}? (${err.message})`,
        });
      }
    }

    // Guardar el data source (sin accessToken — raigentic lo maneja)
    const existing = await db.getPrimaryDataSource(req.orgId);
    if (existing) {
      await getPool().query(
        'UPDATE data_sources SET name=$1, config=$2, status=$3 WHERE id=$4',
        [shop, JSON.stringify({ storeUrl: shop }), 'connected', existing.id]
      );
    } else {
      const ds = await db.createDataSource({
        organizationId: req.orgId,
        type: 'shopify',
        name: shop,
        config: { storeUrl: shop },
      });
      await db.updateDataSourceStatus(ds.id, 'connected');
      await db.createDefaultAgents(req.orgId, ds.id);
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
router.get('/shopify-status', requireAuth, async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
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
router.post('/complete', requireAuth, async (req, res) => {
  try {
    await db.markSetupDone(req.orgId);
    const wc = await db.getWhatsappConfig(req.orgId);
    const ds = await db.getPrimaryDataSource(req.orgId);
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
router.get('/status', requireAuth, async (req, res) => {
  try {
    const org    = await db.getOrgById(req.orgId);
    const wc     = await db.getWhatsappConfig(req.orgId);
    const ds     = await db.getPrimaryDataSource(req.orgId);
    const agents = await db.getAgents(req.orgId);

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
