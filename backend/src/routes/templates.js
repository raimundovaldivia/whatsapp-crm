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

    // Limpiar header: Meta no permite emojis, asteriscos ni saltos de línea en HEADER
    const cleanHeader = (header?.trim() || '')
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')   // emojis supplementary
      .replace(/[☀-➿]/gu, '')           // emojis misc symbols
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')     // emojis extended
      .replace(/[*_~`]/g, '')                     // markdown formatting
      .replace(/\n/g, ' ')                        // newlines
      .trim();

    // Construir componentes
    const components = [];

    if (cleanHeader) {
      components.push({ type: 'HEADER', format: 'TEXT', text: cleanHeader });
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

/* ─────────────────────────────────────────────────────────────────────
   POST /api/templates/generate
   La IA genera el contenido de un template dado un objetivo en lenguaje
   natural. No crea el template en Meta — solo devuelve el draft para
   que el usuario lo revise antes de enviarlo.

   Body: { goal, category?, language? }
     goal: descripción libre de lo que debe hacer el template
           ej: "recordarle al cliente sus productos favoritos cuando
                hace mucho que no compra"

   Response: { name, header, body, footer, variables: ["1":"nombre", ...] }
───────────────────────────────────────────────────────────────────── */
router.post('/generate', async (req, res) => {
  try {
    const { goal, category = 'MARKETING', language = 'es' } = req.body;
    if (!goal?.trim()) {
      return res.status(400).json({ success: false, error: 'goal requerido' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `Eres un experto en WhatsApp Business Templates para una tienda de productos frescos del campo (huevos, aceitunas, quesos, miel, conservas, etc.) en Chile.

El usuario quiere crear un template de WhatsApp con este objetivo:
"${goal.trim()}"

Categoría: ${category}
Idioma: ${language}

Genera un template de WhatsApp que cumpla ese objetivo. Reglas:
- El nombre debe ser en snake_case, todo minúsculas, descriptivo (ej: reenganche_clientes_inactivos)
- El body puede tener variables numeradas {{1}}, {{2}}, etc. para personalizar por cliente
  - {{1}} = nombre del cliente (casi siempre recomendado)
  - {{2}}, {{3}}... = otros datos (productos, días inactivo, etc.) — solo si aportan valor
- Máximo 3-4 variables, no más (Meta rechaza templates muy complejos)
- Tono: cercano, cálido, como un amigo que cuida al cliente
- Body: máximo 160 caracteres, directo y natural
- Header: opcional, corto (máximo 60 chars). CRÍTICO: sin emojis, sin asteriscos, sin caracteres especiales — solo texto plano. Meta rechaza headers con emojis. Si no hay un header útil en texto plano, pon null.
- Footer: opcional, solo para instrucciones de baja (STOP) o info legal. Generalmente no es necesario.
- Variables deben ser numeradas consecutivamente empezando por 1

Responde ÚNICAMENTE con este JSON (sin markdown, sin explicaciones):
{
  "name": "nombre_del_template",
  "header": "Texto de encabezado o null",
  "body": "Cuerpo del mensaje con {{1}} y otras variables si aplica",
  "footer": "Texto de pie o null",
  "variables": {
    "1": "descripción de qué va aquí (ej: nombre del cliente)",
    "2": "descripción de qué va aquí si hay más variables"
  }
}`;

    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw   = response.content[0]?.text?.trim() || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ success: false, error: 'La IA no devolvió un JSON válido', raw: raw.slice(0, 200) });
    }

    const generated = JSON.parse(match[0]);

    // Asegurar que name sea snake_case válido
    if (generated.name) {
      generated.name = generated.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_');
    }

    // Limpiar nulls
    if (!generated.header) generated.header = '';
    if (!generated.footer) generated.footer = '';

    console.log(`[Templates/generate] Org ${req.orgId} generó draft: "${generated.name}"`);
    res.json({ success: true, data: generated });
  } catch (err) {
    console.error('[Templates/generate]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
