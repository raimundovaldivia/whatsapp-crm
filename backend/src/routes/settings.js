/**
 * settings.js — Ajustes globales del CRM
 *
 * GET  /api/settings                  → Obtener ajustes actuales
 * PUT  /api/settings                  → Actualizar ajustes
 * POST /api/settings/sync-products    → Forzar resync de productos desde Shopify directo
 * GET  /api/settings/products         → Listar productos desde Shopify directo
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../db/database');
const shopifyApi   = require('../services/shopify-api');
const orchestrator = require('../services/agents/orchestrator');
const salesAgent   = require('../services/agents/sales');
const ordersAgent  = require('../services/agents/orders');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/settings
 */
router.get('/', async (req, res) => {
  try {
    const settings = {
      ai_enabled_global:      (await db.getSetting(req.orgId, 'ai_enabled_global')) === 'true',
      ai_system_prompt_extra: (await db.getSetting(req.orgId, 'ai_system_prompt_extra')) || '',
      payment_mode:           (await db.getSetting(req.orgId, 'payment_mode')) || 'link',
    };
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/settings
 */
router.put('/', async (req, res) => {
  try {
    const { ai_enabled_global, ai_system_prompt_extra, payment_mode } = req.body;
    if (ai_enabled_global !== undefined)
      await db.setSetting(req.orgId, 'ai_enabled_global', ai_enabled_global ? 'true' : 'false');
    if (ai_system_prompt_extra !== undefined)
      await db.setSetting(req.orgId, 'ai_system_prompt_extra', ai_system_prompt_extra);
    if (payment_mode !== undefined)
      await db.setSetting(req.orgId, 'payment_mode', payment_mode);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/settings/test-bot
 * Simula una conversación con el bot SIN guardar nada en DB.
 * El cliente pasa el historial completo en cada request (stateless).
 *
 * Body: { message, history: [{role, content}], orderDraft: {}, pipelineState: 'exploring' }
 * Response: { response, agentType, newState, orderDraft }
 */
router.post('/test-bot', async (req, res) => {
  try {
    const { message, history = [], orderDraft = {}, pipelineState = 'exploring' } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

    // ── Cargar catálogo y configuración ──────────────────────────
    const ds = await db.getPrimaryDataSource(req.orgId);
    let productosTexto = '';
    if (ds?.config?.accessToken) {
      try {
        const { shop, token } = shopifyApi.credentialsFrom(ds);
        const r = await shopifyApi.getProducts(shop, token, { limit: 250 });
        productosTexto = shopifyApi.formatProductsForAI(r.products || [], shop);
      } catch {}
    }

    const storeContext = await db.getSetting(req.orgId, 'store_context') || '';
    const extraPrompt  = await db.getSetting(req.orgId, 'ai_system_prompt_extra') || '';
    const deliveryRaw  = await db.getSetting(req.orgId, 'delivery_info');
    let deliverySection = '';
    if (deliveryRaw) {
      try {
        const d = JSON.parse(deliveryRaw);
        const lines = [];
        if (d.schedule)       lines.push(`📅 Horarios: ${d.schedule}`);
        if (d.zone)           lines.push(`📍 Zona: ${d.zone}`);
        if (d.minimum)        lines.push(`💰 Mínimo: ${d.minimum}`);
        if (d.paymentMethods) lines.push(`💳 Pago: ${d.paymentMethods}`);
        if (lines.length) deliverySection = `## Entrega\n${lines.join('\n')}`;
      } catch {}
    }
    const storeCustomPrompt = [deliverySection, storeContext, extraPrompt].filter(Boolean).join('\n\n---\n\n');

    // Convertir historial al formato interno del pipeline
    const convHistory = history.map(m => ({
      direction: m.role === 'user' ? 'inbound' : 'outbound',
      content:   m.content,
    }));

    let response, agentType, newState = pipelineState, newOrderDraft = { ...orderDraft };

    // ── Agente de órdenes (recopilando datos) ─────────────────────
    if (pipelineState === 'collecting_order') {
      newOrderDraft = await ordersAgent.extractOrderData(convHistory, orderDraft);
      const agentResponse = await ordersAgent.generateOrderResponse(convHistory, message, newOrderDraft, productosTexto);
      const confirmed = ordersAgent.isOrderConfirmed(agentResponse, message);

      if (confirmed && ordersAgent.hasRequiredData(newOrderDraft)) {
        const paymentMode = (await db.getSetting(req.orgId, 'payment_mode')) || 'link';
        const payMsg = paymentMode === 'cod'
          ? 'confirmaría el pedido con despacho por pagar (sin link de pago).'
          : 'generaría el link de pago de Shopify y lo enviaría al cliente.';
        response = `✅ *(Modo prueba — pedido no procesado)*\n\nEn producción, el bot ${payMsg}\n\n📦 *${newOrderDraft.product_name}* x${newOrderDraft.quantity}\n👤 ${newOrderDraft.customer_name}\n📍 ${newOrderDraft.address}, ${newOrderDraft.city}`;
        newState = 'test_complete';
      } else {
        response = agentResponse.replace(/ORDEN_CONFIRMADA/g, '').trim() || '¡Déjame verificar los datos!';
        newState = 'collecting_order';
      }
      agentType = 'orders';

    // ── Agente de ventas + orquestador ───────────────────────────
    } else {
      const { intent } = await orchestrator.classifyIntent(message, convHistory, pipelineState);
      const salesResponse = await salesAgent.generateSalesResponse(convHistory, message, productosTexto, storeCustomPrompt);
      response  = salesResponse;
      agentType = 'sales';
      newState  = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : pipelineState;
    }

    res.json({ response, agentType, newState, orderDraft: newOrderDraft });
  } catch (err) {
    console.error('[TestBot]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/settings/sync-products
 * Descarga el catálogo completo desde Shopify y lo devuelve (no cachea en DB).
 */
router.post('/sync-products', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    const { shop, token } = shopifyApi.credentialsFrom(ds);

    const products = await shopifyApi.getAllProducts(shop, token);
    res.json({ success: true, message: `${products.length} productos sincronizados`, data: { count: products.length } });
  } catch (err) {
    console.error('[Settings] Error sincronizando productos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings/products
 * Devuelve el catálogo de productos directo desde Shopify.
 */
router.get('/products', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    const { shop, token } = shopifyApi.credentialsFrom(ds);

    const result = await shopifyApi.getProducts(shop, token, { limit: 250 });
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
router.get('/whatsapp', async (req, res) => {
  try {
    const wc = await db.getWhatsappConfig(req.orgId);
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
        // Kapso
        kapsoApiKey:        mask(wc.kapso_api_key),
        webhookSecret:      mask(wc.webhook_secret),
        // Estado
        status:             wc.status || 'pending',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/settings/whatsapp/debug
 * Diagnóstico: qué hay guardado en DB y qué env vars están presentes.
 * No devuelve secretos completos, solo indica si están presentes (true/false).
 */
router.get('/whatsapp/debug', requireAuth, async (req, res) => {
  const wc = await db.getWhatsappConfig(req.orgId);
  res.json({
    db: {
      provider:         wc?.provider          || null,
      phone_number_id:  wc?.phone_number_id   || null,
      kapso_api_key:    wc?.kapso_api_key     ? `${wc.kapso_api_key.slice(0, 8)}...` : null,
      kapso_customer_id: wc?.kapso_customer_id || null,
      webhook_secret:   wc?.webhook_secret    ? '(configurado)' : null,
      status:           wc?.status            || null,
    },
    env: {
      KAPSO_API_KEY:   process.env.KAPSO_API_KEY  ? `${process.env.KAPSO_API_KEY.slice(0, 8)}...` : null,
      PUBLIC_URL:      process.env.PUBLIC_URL     || null,
      FRONTEND_URL:    process.env.FRONTEND_URL   || null,
    },
    effective: {
      apiKeySource: wc?.kapso_api_key ? 'db (org)' : process.env.KAPSO_API_KEY ? 'env (platform)' : 'NINGUNA ❌',
      webhookUrl:   `${process.env.PUBLIC_URL || process.env.BACKEND_URL || '???'}/kapso-webhook`,
      canSend:      !!(wc?.phone_number_id && (wc?.kapso_api_key || process.env.KAPSO_API_KEY)),
    },
  });
});

/**
 * GET /api/settings/whatsapp/test
 * Verifica que la config guardada es válida haciendo una llamada real a la API
 */
router.get('/whatsapp/test', async (req, res) => {
  try {
    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.json({ success: false, error: 'No hay configuración de WhatsApp guardada' });

    if (wc.provider === 'twilio') {
      const axios = require('axios');
      const sid   = wc.twilio_account_sid;
      const token = wc.twilio_auth_token;
      if (!sid || !token) return res.json({ success: false, error: 'Faltan credenciales de Twilio en la DB' });
      await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        auth: { username: sid, password: token }, timeout: 8000,
      });
      res.json({ success: true, message: `Twilio OK · Cuenta ${sid.slice(0,10)}...` });

    } else if (wc.provider === 'kapso') {
      const axios   = require('axios');
      const apiKey  = wc.kapso_api_key || process.env.KAPSO_API_KEY;
      const phoneId = wc.phone_number_id;
      if (!phoneId) return res.json({ success: false, error: 'Falta Phone Number ID. Reconecta WhatsApp con Kapso.' });
      if (!apiKey)  return res.json({ success: false, error: 'No hay Kapso API Key. Agrega KAPSO_API_KEY en Render o reconecta.' });

      // Verificar API key consultando el perfil del número vía Kapso
      try {
        const r = await axios.get(
          `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneId}/whatsapp_business_profile`,
          { headers: { 'X-API-Key': apiKey }, timeout: 8000 }
        );
        const profile = r.data?.data?.[0] || {};
        const display = profile?.about || phoneId;
        res.json({ success: true, message: `Kapso ✅ conectado · Phone ID: ${phoneId}` });
      } catch (kapsoErr) {
        const status  = kapsoErr.response?.status;
        const detail  = kapsoErr.response?.data?.error?.message || kapsoErr.message;
        // 401 = API key inválida, otros = puede ser config de Meta pero key OK
        if (status === 401) {
          return res.json({ success: false, error: `API Key inválida: ${detail}` });
        }
        // Si la key es válida pero el número tiene restricciones, igual está conectado
        res.json({ success: true, message: `Kapso conectado · Phone ID: ${phoneId} (status ${status || 'OK'})` });
      }
      return;

    } else {
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
router.put('/whatsapp', async (req, res) => {
  try {
    const { provider = 'meta' } = req.body;

    if (provider === 'twilio') {
      const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = req.body;
      if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
        return res.status(400).json({ success: false, error: 'Twilio requiere Account SID, Auth Token y número de teléfono' });
      }
      await db.upsertWhatsappConfig(req.orgId, {
        provider: 'twilio',
        twilioAccountSid, twilioAuthToken, twilioPhoneNumber,
        status: 'connected',
      });
    } else if (provider === 'kapso') {
      const { kapsoApiKey, phoneNumberId, webhookSecret, businessAccountId } = req.body;
      if (!kapsoApiKey || !phoneNumberId) {
        return res.status(400).json({ success: false, error: 'Kapso requiere API Key y Phone Number ID' });
      }
      await db.upsertWhatsappConfig(req.orgId, {
        provider: 'kapso',
        phoneNumberId, kapsoApiKey,
        businessAccountId: businessAccountId || null,  // WABA ID para templates
        webhookSecret: webhookSecret || null,
        status: 'connected',
      });
    } else {
      const { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken } = req.body;
      if (!phoneNumberId || !accessToken || !webhookVerifyToken) {
        return res.status(400).json({ success: false, error: 'Meta requiere Phone Number ID, Access Token y Webhook Verify Token' });
      }
      await db.upsertWhatsappConfig(req.orgId, {
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
