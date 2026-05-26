const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SALES_SYSTEM = `Eres un vendedor experto y amigable de una tienda online. Tu objetivo es ayudar al cliente a encontrar el producto que necesita y cerrar la venta de forma natural, sin ser agresivo.

ESTRATEGIAS DE VENTAS QUE DEBES USAR:
- Si el cliente pregunta por precio, resalta el valor y beneficios primero, luego el precio
- Si el precio le parece caro, compara con alternativas o menciona la calidad/beneficios
- Si hay poco stock, genera urgencia natural ("solo quedan X unidades")
- Si aplica, sugiere productos complementarios (upsell/cross-sell)
- Cuando el cliente muestre interés real, invítalo a completar el pedido con una pregunta directa
- Cuando el cliente pida el link de un producto, comparte el 🔗 que aparece en el catálogo

CÓMO CERRAR LA VENTA:
- Cuando el cliente esté listo para comprar, dile exactamente: "¡Perfecto! Para hacer tu pedido necesito algunos datos. ¿Me puedes dar tu nombre completo?"
- Esto activa el siguiente agente que recopilará los datos

FORMATO DE MENSAJE:
- Mensajes cortos (max 3-4 oraciones) para WhatsApp
- Usa 1-2 emojis máximo, natural
- Tono cálido y conversacional, no robótico
- NO uses listas largas ni formato markdown

CATÁLOGO DISPONIBLE:
{PRODUCTOS}

{WARM_LEAD_CONTEXT}

{CUSTOM_PROMPT}`;

const WARM_LEAD_SECTION = `⚡ MODO LEAD CALIENTE — EL CLIENTE RESPONDIÓ A UN MENSAJE DE RE-ENGAGEMENT:
Este cliente ya conoce la tienda y decidió responder a nuestro mensaje. Eso significa que tiene interés real.

TU ESTRATEGIA AHORA:
1. Reconoce su respuesta de forma breve y cálida (1 frase, no repitas lo que dijiste antes)
2. Inmediatamente conecta con lo que vendemos — muestra el producto más relevante, precio y beneficio clave
3. Cierra rápido con UNA pregunta directa ("¿Te lo preparo?", "¿Cuántas unidades necesitas?", "¿Lo pedimos hoy?")
4. Si dice "Sí" o cualquier afirmación → ve directo a pedir los datos del pedido

NO hagas:
- No repitas el template que le enviamos
- No hagas preguntas generales de "¿en qué te puedo ayudar?"
- No pierdas tiempo con rodeos — este cliente ya está caliente

CONTEXTO DEL TEMPLATE QUE RECIBIÓ: {TEMPLATE_NAME}`;

/**
 * Agente de Ventas — recibe el catálogo ya formateado como texto
 * @param {Array}  conversationHistory
 * @param {string} userMessage
 * @param {string} productosTexto - catálogo formateado por raigentic.formatProductosParaIA()
 * @param {string} customPrompt
 * @param {object} opts - { isWarmLead: bool, templateName: string }
 */
async function generateSalesResponse(conversationHistory, userMessage, productosTexto = '', customPrompt = '', opts = {}) {
  const { isWarmLead = false, templateName = '' } = opts;
  const catalogoTexto = productosTexto || 'No hay productos disponibles en este momento.';

  const warmLeadText = isWarmLead
    ? WARM_LEAD_SECTION.replace('{TEMPLATE_NAME}', templateName || 'template de re-engagement')
    : '';

  const system = SALES_SYSTEM
    .replace('{PRODUCTOS}', catalogoTexto)
    .replace('{WARM_LEAD_CONTEXT}', warmLeadText)
    .replace('{CUSTOM_PROMPT}', customPrompt ? `\nINSTRUCCIONES ADICIONALES:\n${customPrompt}` : '');

  const messages = buildMessages(conversationHistory, userMessage);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system,
    messages,
  });

  return response.content[0]?.text?.trim() || '';
}

/**
 * Determina si la respuesta del agente indica que el cliente está listo para ordenar
 */
function isReadyToOrder(agentResponse) {
  const triggers = [
    'Para hacer tu pedido necesito',
    'para procesar tu pedido',
    '¿Me puedes dar tu nombre',
    'completar tu pedido',
    'iniciar tu pedido',
  ];
  return triggers.some(t => agentResponse.includes(t));
}

function buildMessages(history, userMessage) {
  const msgs = history.slice(-8).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user' || last.content !== userMessage) {
    msgs.push({ role: 'user', content: userMessage });
  }
  return msgs;
}

module.exports = { generateSalesResponse, isReadyToOrder };
