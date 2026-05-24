/**
 * templates.js — Gestión de WhatsApp Message Templates vía Kapso
 *
 * GET    /api/templates            → lista todos los templates de la org
 * POST   /api/templates            → crea un nuevo template (queda PENDING hasta aprobación)
 * DELETE /api/templates/:name      → elimina un template por nombre
 */

const express      = require('express');
const router       = express.Router();
const db           = require('../db/database');
const kapsoService = require('../services/kapso-whatsapp');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/* ─────────────────────────────────────────────────────────────────────
   GET /api/templates
   Lista todos los templates (de todos los estados) de la cuenta WABA.
───────────────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
      return res.json({ success: true, data: [], message: 'Templates disponibles solo para Kapso o Meta' });
    }

    // Sin filtro de estado: traer todos (APPROVED, PENDING, REJECTED)
    const apiKey = wc.kapso_api_key || process.env.KAPSO_API_KEY;
    const wabaId = wc.business_account_id || process.env.KAPSO_WABA_ID;

    if (!wabaId) {
      return res.status(400).json({
        success: false,
        error: 'WABA ID no configurado. Ve a Configuración → WhatsApp y agrega tu WABA ID.',
      });
    }

    const axios = require('axios');
    const response = await axios.get(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${wabaId}/message_templates?limit=100`,
      { headers: { 'X-API-Key': apiKey } }
    );

    const templates = (response.data?.data || response.data || []).map(t => ({
      id:         t.id,
      name:       t.name,
      language:   t.language,
      status:     t.status,
      category:   t.category,
      components: t.components || [],
      rejectedReason: t.quality_score?.reasons?.[0] || t.rejected_reason || null,
    }));

    // Ordenar: APPROVED primero, luego PENDING, luego REJECTED
    const order = { APPROVED: 0, PENDING: 1, REJECTED: 2 };
    templates.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

    res.json({ success: true, data: templates, total: templates.length });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Templates/GET]', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/templates
   Crea un template nuevo. Quedará en estado PENDING hasta que Meta lo apruebe.

   Body:
   {
     name:       "reenganche_frescos",    // snake_case, letras minúsculas y _
     language:   "es",                    // es | en_US | pt_BR | es_MX | ...
     category:   "MARKETING",            // MARKETING | UTILITY | AUTHENTICATION
     header?:    "Productos frescos 🌿",  // texto de cabecera (opcional)
     body:       "Hola {{1}}, tus {{2}} favoritos te esperan. ¿Hacemos un pedido?",
     footer?:    "Responde STOP para darte de baja",
   }
───────────────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  try {
    const { name, language, category, header, body, footer } = req.body;

    if (!name?.trim())     return res.status(400).json({ success: false, error: 'name requerido' });
    if (!language?.trim()) return res.status(400).json({ success: false, error: 'language requerido' });
    if (!category?.trim()) return res.status(400).json({ success: false, error: 'category requerido' });
    if (!body?.trim())     return res.status(400).json({ success: false, error: 'body requerido' });

    // Validar nombre: solo minúsculas, números y _
    if (!/^[a-z0-9_]+$/.test(name.trim())) {
      return res.status(400).json({
        success: false,
        error: 'El nombre solo puede contener letras minúsculas, números y guiones bajos (_)',
      });
    }

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    const apiKey = wc.kapso_api_key || process.env.KAPSO_API_KEY;
    const wabaId = wc.business_account_id || process.env.KAPSO_WABA_ID;

    if (!apiKey) return res.status(400).json({ success: false, error: 'Kapso API Key no configurada' });
    if (!wabaId) return res.status(400).json({ success: false, error: 'WABA ID no configurado' });

    // Construir componentes
    const components = [];

    if (header?.trim()) {
      components.push({ type: 'HEADER', format: 'TEXT', text: header.trim() });
    }

    components.push({ type: 'BODY', text: body.trim() });

    if (footer?.trim()) {
      components.push({ type: 'FOOTER', text: footer.trim() });
    }

    const axios = require('axios');
    const response = await axios.post(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${wabaId}/message_templates`,
      {
        name:       name.trim(),
        language:   language.trim(),
        category:   category.trim(),
        components,
      },
      {
        headers: {
          'X-API-Key':    apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[Templates/POST] Org ${req.orgId} creó template "${name}" — status: ${response.data?.status || 'PENDING'}`);
    res.json({ success: true, data: response.data, status: response.data?.status || 'PENDING' });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Templates/POST]', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   DELETE /api/templates/:name
   Elimina un template por nombre (o ID si se pasa como parámetro).
───────────────────────────────────────────────────────────────────── */
router.delete('/:name', async (req, res) => {
  try {
    const templateName = req.params.name;
    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    const apiKey = wc.kapso_api_key || process.env.KAPSO_API_KEY;
    const wabaId = wc.business_account_id || process.env.KAPSO_WABA_ID;

    if (!apiKey || !wabaId) {
      return res.status(400).json({ success: false, error: 'Kapso API Key o WABA ID no configurados' });
    }

    const axios = require('axios');
    await axios.delete(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`,
      { headers: { 'X-API-Key': apiKey } }
    );

    console.log(`[Templates/DELETE] Org ${req.orgId} eliminó template "${templateName}"`);
    res.json({ success: true });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Templates/DELETE]', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

module.exports = router;
