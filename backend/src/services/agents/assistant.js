/**
 * assistant.js — Agente asistente del CRM
 *
 * Modo onboarding (setup_done = false):
 *   Guía al usuario a través de la configuración completa de forma conversacional.
 *   Conecta Shopify, conecta WhatsApp, configura personalidad, entrega y pago.
 *
 * Modo asistente (setup_done = true):
 *   Responde preguntas, actualiza configuración, muestra stats, prueba el bot.
 *
 * Usa Claude con tool use para ejecutar acciones reales.
 */

const Anthropic  = require('@anthropic-ai/sdk');
const db         = require('../../db/database');
const shopifyApi = require('../shopify-api');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Herramientas disponibles ────────────────────────────────────

const TOOLS = [
  {
    name: 'save_config',
    description: 'Guarda uno o más campos de configuración del CRM. Úsalo cuando el usuario proporcione información sobre su tienda, personalidad del bot, horarios, modo de pago, etc.',
    input_schema: {
      type: 'object',
      properties: {
        store_context:          { type: 'string', description: 'Contexto general de la tienda (nombre, descripción, qué vende)' },
        ai_system_prompt_extra: { type: 'string', description: 'Instrucciones de personalidad del bot' },
        delivery_info:          { type: 'object', description: 'Info de entrega: { schedule, zone, minimum, paymentMethods }' },
        payment_mode:           { type: 'string', enum: ['link', 'cod'], description: 'Modo de cobro: link (Shopify) o cod (contra entrega)' },
        store_name:             { type: 'string', description: 'Nombre de la tienda' },
      },
    },
  },
  {
    name: 'trigger_oauth',
    description: 'Inicia el flujo de conexión OAuth con Shopify o WhatsApp. Úsalo cuando sea el momento de conectar uno de estos servicios.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: ['shopify', 'whatsapp'], description: 'Servicio a conectar' },
        message: { type: 'string', description: 'Mensaje para mostrar al usuario junto al botón de conexión' },
      },
      required: ['service', 'message'],
    },
  },
  {
    name: 'get_status',
    description: 'Obtiene el estado actual de la configuración: qué está conectado, qué falta, métricas básicas.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'complete_setup',
    description: 'Marca el onboarding como completado. Úsalo SOLO cuando Shopify y WhatsApp estén ambos conectados y la configuración básica esté lista.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'test_bot',
    description: 'Prueba cómo respondería el bot a un mensaje de cliente.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Mensaje de prueba del cliente' },
      },
      required: ['message'],
    },
  },
];

// ─── System prompt dinámico ──────────────────────────────────────

function buildSystemPrompt(orgState, isOnboarding) {
  const { shopifyConnected, whatsappConnected, storeContext, personalitySet, deliverySet } = orgState;

  if (isOnboarding) {
    return `Eres el asistente de configuración de WhatsApp CRM. Tu trabajo es guiar al dueño de una tienda Shopify para dejar el bot de ventas funcionando en ${isOnboarding ? '5' : 'pocos'} minutos.

ESTADO ACTUAL:
- Shopify: ${shopifyConnected ? '✅ Conectado' : '❌ No conectado'}
- WhatsApp: ${whatsappConnected ? '✅ Conectado' : '❌ No conectado'}
- Contexto de tienda: ${storeContext ? '✅ Configurado' : '❌ Falta'}
- Personalidad del bot: ${personalitySet ? '✅ Configurada' : '❌ Falta'}
- Info de entrega: ${deliverySet ? '✅ Configurada' : '❌ Falta'}

ORDEN DE CONFIGURACIÓN:
1. Si no tiene Shopify → pedirle nombre de tienda y conectar (trigger_oauth shopify)
2. Si no tiene WhatsApp → preguntar si tiene WhatsApp Business, explicar el intercambio, conectar (trigger_oauth whatsapp)
3. Si no tiene contexto → preguntar qué vende, horarios, zona de reparto (save_config)
4. Si no tiene personalidad → hacer las preguntas de personalidad de forma natural (save_config)
5. Si no tiene delivery → preguntar horarios y zona de entrega (save_config)
6. Cuando todo esté listo → complete_setup

REGLAS:
- Haz UNA sola pregunta a la vez
- Tono casual y cálido, como un colega que te ayuda a configurar algo
- Cuando uses trigger_oauth, el frontend mostrará el botón — tú solo explica qué va a pasar
- Cuando uses save_config, no lo menciones al usuario — solo guarda en silencio
- Si el usuario pregunta algo fuera del setup, responde brevemente y vuelve al flujo
- NUNCA digas "voy a llamar a una herramienta" ni menciones las tools técnicamente`;
  }

  return `Eres el asistente de ${storeContext ? `la tienda ${storeContext.slice(0, 50)}` : 'esta tienda'} en WhatsApp CRM.

ESTADO DE LA CONFIGURACIÓN:
- Shopify: ${shopifyConnected ? '✅ Conectado' : '❌ No conectado'}
- WhatsApp: ${whatsappConnected ? '✅ Conectado' : '❌ No conectado'}
- Personalidad del bot: ${personalitySet ? '✅ Configurada' : '❌ Falta'}

Puedes ayudar con:
- Cambiar configuración del bot (tono, personalidad, horarios, modo de pago)
- Ver estado de la tienda y métricas
- Probar cómo responde el bot
- Reconectar Shopify o WhatsApp si algo falla
- Resolver dudas sobre cómo usar el CRM

Cuando el usuario quiera cambiar algo, usa save_config para guardarlo directamente.
Tono: cercano, útil, directo. Máximo 3 líneas por respuesta salvo que sea necesario más.`;
}

// ─── Ejecutar herramientas ────────────────────────────────────────

async function executeTool(toolName, toolInput, orgId) {
  switch (toolName) {

    case 'save_config': {
      const saves = [];
      if (toolInput.store_context !== undefined) {
        // Guardar en reengagement store_context vía DB directa
        await db.setSetting(orgId, 'store_context', toolInput.store_context);
        saves.push('store_context');
      }
      if (toolInput.ai_system_prompt_extra !== undefined) {
        await db.setSetting(orgId, 'ai_system_prompt_extra', toolInput.ai_system_prompt_extra);
        saves.push('ai_system_prompt_extra');
      }
      if (toolInput.payment_mode !== undefined) {
        await db.setSetting(orgId, 'payment_mode', toolInput.payment_mode);
        saves.push('payment_mode');
      }
      if (toolInput.delivery_info !== undefined) {
        const d = toolInput.delivery_info;
        await db.setSetting(orgId, 'delivery_info', JSON.stringify({
          schedule: d.schedule || '',
          zone: d.zone || '',
          minimum: d.minimum || '',
          paymentMethods: d.paymentMethods || '',
        }));
        saves.push('delivery_info');
      }
      if (toolInput.store_name !== undefined) {
        // Guardar nombre como parte del contexto
        const existing = await db.getSetting(orgId, 'store_context') || '';
        if (!existing.includes(toolInput.store_name)) {
          await db.setSetting(orgId, 'store_context', `Tienda: ${toolInput.store_name}\n${existing}`.trim());
        }
        saves.push('store_name');
      }
      return { saved: saves, success: true };
    }

    case 'trigger_oauth': {
      // No ejecuta nada en el backend — el frontend maneja el redirect
      return { action: 'oauth', service: toolInput.service, message: toolInput.message };
    }

    case 'get_status': {
      const ds = await db.getPrimaryDataSource(orgId).catch(() => null);
      const whatsapp = await db.getWhatsappConfig(orgId).catch(() => null);
      const context  = await db.getSetting(orgId, 'store_context');
      const personality = await db.getSetting(orgId, 'ai_system_prompt_extra');
      const delivery = await db.getSetting(orgId, 'delivery_info');

      let stats = {};
      try {
        const { getPool } = require('../../db/database');
        const pool = getPool();
        const { rows } = await pool.query(`
          SELECT
            COUNT(DISTINCT c.id) AS total_conversations,
            COUNT(DISTINCT CASE WHEN c.created_at > NOW() - INTERVAL '7 days' THEN c.id END) AS new_this_week,
            COUNT(DISTINCT o.id) AS total_orders
          FROM conversations c
          LEFT JOIN orders o ON o.organization_id = c.organization_id
          WHERE c.organization_id = $1
        `, [orgId]);
        stats = rows[0] || {};
      } catch {}

      return {
        shopify_connected:   !!(ds?.config?.accessToken),
        whatsapp_connected:  !!(whatsapp?.kapso_api_key || whatsapp?.phone_number_id),
        store_context_set:   !!context,
        personality_set:     !!personality,
        delivery_set:        !!delivery,
        stats,
      };
    }

    case 'complete_setup': {
      const { getPool } = require('../../db/database');
      await getPool().query(
        'UPDATE organizations SET setup_done = true WHERE id = $1',
        [orgId]
      );
      return { success: true, setup_complete: true };
    }

    case 'test_bot': {
      // Llama al endpoint de test-bot internamente
      const salesAgent = require('./sales');
      const ds = await db.getPrimaryDataSource(orgId).catch(() => null);
      let productosTexto = '';
      if (ds?.config?.accessToken) {
        try {
          const { shop, token } = shopifyApi.credentialsFrom(ds);
          const r = await shopifyApi.getProducts(shop, token, { limit: 50 });
          productosTexto = shopifyApi.formatProductsForAI(r.products || [], shop);
        } catch {}
      }
      const storeContext = await db.getSetting(orgId, 'store_context') || '';
      const extraPrompt  = await db.getSetting(orgId, 'ai_system_prompt_extra') || '';
      try {
        const response = await salesAgent.generateSalesResponse(
          [], toolInput.message, productosTexto,
          [storeContext, extraPrompt].filter(Boolean).join('\n\n')
        );
        return { bot_response: response };
      } catch (e) {
        return { bot_response: 'Error al probar el bot: ' + e.message };
      }
    }

    default:
      return { error: 'Herramienta desconocida' };
  }
}

// ─── Función principal ───────────────────────────────────────────

async function chat(orgId, isSetupDone, history, userMessage) {
  // Obtener estado actual de la org
  const ds        = await db.getPrimaryDataSource(orgId).catch(() => null);
  const whatsapp  = await db.getWhatsappConfig(orgId).catch(() => null);
  const context   = await db.getSetting(orgId, 'store_context');
  const personality = await db.getSetting(orgId, 'ai_system_prompt_extra');
  const delivery  = await db.getSetting(orgId, 'delivery_info');

  const orgState = {
    shopifyConnected:  !!(ds?.config?.accessToken),
    whatsappConnected: !!(whatsapp?.kapso_api_key || whatsapp?.phone_number_id),
    storeContext:      context,
    personalitySet:    !!personality,
    deliverySet:       !!delivery,
  };

  const isOnboarding = !isSetupDone;
  const system = buildSystemPrompt(orgState, isOnboarding);

  // Construir mensajes — siempre deben empezar con rol 'user'
  const historyMsgs = history.slice(-12).map(m => ({
    role:    m.role,
    content: m.content || '',
  })).filter(m => m.role === 'user' || m.role === 'assistant');

  // Si el historial empieza con 'assistant', lo descartamos para no violar la API
  const safeHistory = historyMsgs.length > 0 && historyMsgs[0].role === 'assistant'
    ? historyMsgs.slice(1)
    : historyMsgs;

  let currentMessages = [
    ...safeHistory,
    { role: 'user', content: userMessage },
  ];

  // Primera llamada a Claude con tools
  let response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    system,
    tools:      TOOLS,
    messages:   currentMessages,
  });

  // Agentic loop — cada iteración actualiza currentMessages correctamente
  let finalText    = '';
  let clientAction = null;

  while (response.stop_reason === 'tool_use') {
    const assistantMsg          = { role: 'assistant', content: response.content };
    const iterationToolResults  = []; // fresco en cada iteración

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const result = await executeTool(block.name, block.input, orgId);

      if (block.name === 'trigger_oauth') {
        clientAction = { type: 'oauth', service: result.service };
      }
      if (block.name === 'complete_setup' && result.setup_complete) {
        clientAction = { type: 'setup_complete' };
      }

      iterationToolResults.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     JSON.stringify(result),
      });
    }

    // Acumular la conversación para la próxima llamada
    currentMessages = [
      ...currentMessages,
      assistantMsg,
      { role: 'user', content: iterationToolResults },
    ];

    response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      system,
      tools:      TOOLS,
      messages:   currentMessages,
    });
  }

  // Extraer texto final
  for (const block of response.content) {
    if (block.type === 'text') finalText += block.text;
  }

  return {
    response:     finalText.trim(),
    clientAction, // null | { type: 'oauth', service: 'shopify'|'whatsapp' } | { type: 'setup_complete' }
    orgState,
  };
}

module.exports = { chat };
