/**
 * setup.js — Wizard de configuración inicial del CRM
 *
 * Rutas:
 *   POST /api/setup/whatsapp      → Guardar credenciales de WhatsApp Business
 *   POST /api/setup/shopify       → Conectar tienda (legacy — ahora usar /shopify-oauth)
 *   GET  /api/setup/shopify-status → Estado de la conexión Shopify
 *   POST /api/setup/complete      → Marcar setup como terminado
 *   GET  /api/setup/status        → Estado general del setup
 */

const express    = require('express');
const router     = express.Router();
const axios      = require('axios');
const db         = require('../db/database');
const { getPool } = require('../db/database');
const shopifyApi = require('../services/shopify-api');
const kapsoPlatform = require('../services/kapso-platform');
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
   SHOPIFY (OAuth directo)
───────────────────────────────────────────────────────────── */

/**
 * POST /api/setup/shopify
 * Guarda la tienda Shopify. La conexión real se hace via OAuth en /shopify-oauth.
 * Este endpoint persiste el storeUrl para que el wizard sepa a qué tienda conectar.
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

    // Guardar el data source con storeUrl (accessToken llegará vía OAuth)
    const existing = await db.getPrimaryDataSource(req.orgId);
    if (existing) {
      const currentConfig = existing.config || {};
      await getPool().query(
        'UPDATE data_sources SET name=$1, config=$2 WHERE id=$3',
        [shop, JSON.stringify({ ...currentConfig, storeUrl: shop }), existing.id]
      );
    } else {
      const ds = await db.createDataSource({
        organizationId: req.orgId,
        type: 'shopify',
        name: shop,
        config: { storeUrl: shop },
      });
      await db.createDefaultAgents(req.orgId, ds.id);
    }

    res.json({
      success: true,
      message: `Tienda guardada: ${shop}. Ahora conecta via OAuth para obtener el token de acceso.`,
      data: { storeUrl: shop },
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

/* ─────────────────────────────────────────────────────────────
   KAPSO — ONBOARDING AUTOMÁTICO (Setup Links)
   El cliente hace clic en un link → login con Facebook → conecta WhatsApp
   Sin escribir ningún dato manualmente.
───────────────────────────────────────────────────────────── */

/**
 * POST /api/setup/kapso/connect
 * Crea (o reutiliza) un customer en Kapso y genera un setup link.
 * El cliente hace clic en el link y conecta su WhatsApp en ~5 min.
 *
 * Requiere KAPSO_API_KEY en variables de entorno (plan Platform de Kapso).
 */
router.post('/kapso/connect', requireAuth, async (req, res) => {
  try {
    if (!process.env.KAPSO_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'KAPSO_API_KEY no está configurada. Agrégala en las variables de entorno de Render.',
      });
    }

    const org = await db.getOrgById(req.orgId);
    if (!org) return res.status(404).json({ success: false, error: 'Organización no encontrada' });

    // Obtener o crear el customer en Kapso para esta org
    let wc = await db.getWhatsappConfig(req.orgId);
    let kapsoCustomerId = wc?.kapso_customer_id || null;

    if (!kapsoCustomerId) {
      // Buscar si ya existe en Kapso por external_customer_id
      const existing = await kapsoPlatform.findCustomerByExternalId(req.orgId);
      if (existing) {
        kapsoCustomerId = existing.id;
      } else {
        const customer = await kapsoPlatform.createCustomer(req.orgId, org.name);
        kapsoCustomerId = customer.id;
      }

      // Guardar el kapsoCustomerId en DB (proveedor kapso, sin phone_number_id aún)
      await db.upsertWhatsappConfig(req.orgId, {
        provider:         'kapso',
        kapsoCustomerId,
        // Preservar kapsoApiKey si ya tenía una configuración manual previa
        kapsoApiKey:      wc?.kapso_api_key || null,
        webhookSecret:    wc?.webhook_secret || null,
      });
    }

    // URL de retorno: el frontend detecta kapso_success=1 en la URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const successUrl  = `${frontendUrl}?kapso_success=1`;
    const failureUrl  = `${frontendUrl}?kapso_error=1`;

    const setupLink = await kapsoPlatform.generateSetupLink(kapsoCustomerId, successUrl, failureUrl);

    res.json({
      success: true,
      setupUrl:  setupLink.url,
      expiresAt: setupLink.expires_at,
    });

  } catch (err) {
    console.error('[Setup/Kapso/connect] Error:', err.message);
    const detail = err.response?.data?.error || err.response?.data?.message || err.message;
    res.status(500).json({ success: false, error: detail });
  }
});

/**
 * POST /api/setup/kapso/save
 * El frontend llama a esta ruta después de que Kapso redirige al cliente de vuelta.
 * Guarda el phone_number_id que viene en los query params de la URL de éxito.
 *
 * Body: { phoneNumberId, displayPhoneNumber?, businessAccountId? }
 */
router.post('/kapso/save', requireAuth, async (req, res) => {
  try {
    const { phoneNumberId, displayPhoneNumber, businessAccountId } = req.body;
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'phoneNumberId es requerido' });
    }

    const wc = await db.getWhatsappConfig(req.orgId);

    await db.upsertWhatsappConfig(req.orgId, {
      provider:           'kapso',
      phoneNumberId,
      businessAccountId:  businessAccountId || null,
      kapsoCustomerId:    wc?.kapso_customer_id || null,
      kapsoApiKey:        wc?.kapso_api_key     || null,
      webhookSecret:      wc?.webhook_secret    || null,
    });

    // Configurar el webhook en Kapso automáticamente usando la Platform API
    // Endpoint correcto: POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks
    const backendUrl = process.env.PUBLIC_URL || process.env.BACKEND_URL;
    let webhookRegistered = false;
    let webhookWarning    = null;

    if (backendUrl && process.env.KAPSO_API_KEY) {
      try {
        const webhookResult = await kapsoPlatform.registerNumberWebhook(
          phoneNumberId,
          `${backendUrl}/kapso-webhook`
        );
        webhookRegistered = true;
        console.log(`[Setup/Kapso] ✅ Webhook registrado automáticamente — número: ${phoneNumberId}, id: ${webhookResult?.id}`);

        // Guardar el secret generado en DB para verificar firmas HMAC entrantes
        if (webhookResult?.generatedSecret) {
          const wc2 = await db.getWhatsappConfig(req.orgId);
          await db.upsertWhatsappConfig(req.orgId, {
            provider:          'kapso',
            phoneNumberId,
            businessAccountId: businessAccountId || null,
            kapsoCustomerId:   wc2?.kapso_customer_id || null,
            kapsoApiKey:       wc2?.kapso_api_key     || null,
            webhookSecret:     webhookResult.generatedSecret,
          });
          console.log(`[Setup/Kapso] ✅ webhook_secret guardado en DB`);
        }
      } catch (whErr) {
        const detail = whErr.response?.data?.error || whErr.message;
        webhookWarning = `Webhook no pudo registrarse automáticamente: ${detail}. Ve a app.kapso.ai → tu número → Webhooks y agrega: ${backendUrl}/kapso-webhook`;
        console.warn('[Setup/Kapso] ⚠️ No se pudo auto-registrar webhook:', detail);
      }
    } else {
      const missing = !backendUrl ? 'PUBLIC_URL' : 'KAPSO_API_KEY';
      webhookWarning = `Falta la variable de entorno ${missing} en Render. El webhook debe configurarse manualmente en app.kapso.ai.`;
      console.warn(`[Setup/Kapso] ⚠️ ${webhookWarning}`);
    }

    res.json({
      success: true,
      message: webhookRegistered
        ? `✅ WhatsApp conectado y webhook configurado automáticamente`
        : `✅ WhatsApp conectado. ${webhookWarning || ''}`,
      warning: webhookWarning,
      data: { phoneNumberId, displayPhoneNumber, webhookRegistered },
    });

  } catch (err) {
    console.error('[Setup/Kapso/save] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
