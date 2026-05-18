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

{CUSTOM_PROMPT}`;

/**
 * Agente de Ventas — recibe el catálogo ya formateado como texto
 * @param {Array}  conversationHistory
 * @param {string} userMessage
 * @param {string} productosTexto - catálogo formateado por raigentic.formatProductosParaIA()
 * @param {string} customPrompt
 */
async function generateSalesResponse(conversationHistory, userMessage, productosTexto = '', customPrompt = '') {
  const catalogoTexto = productosTexto || 'No hay productos disponibles en este momento.';

  const system = SALES_SYSTEM
    .replace('{PRODUCTOS}', catalogoTexto)
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
