const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Campos requeridos para crear la orden (zip_code NO es obligatorio)
const REQUIRED_FIELDS = ['customer_name', 'product_name', 'quantity', 'address', 'city'];

const ORDERS_SYSTEM = `Eres el asistente de pedidos de una tienda online. El cliente ya decidió comprar y tu trabajo es recopilar los datos necesarios para crear su orden de forma conversacional y amigable.

DATOS QUE NECESITAS RECOPILAR (en este orden):
1. Nombre completo del cliente (si no lo tienes ya)
2. Producto específico que quiere + cantidad (confirmar variante exacta si aplica)
3. Dirección de envío completa (calle, número, sector/barrio)
4. Ciudad
5. Confirmación final del pedido

REGLAS IMPORTANTES:
- Pide UN dato a la vez, no todos de golpe
- NO pidas código postal — no es necesario
- Si ya tienes un dato del cliente (viene en DATOS RECOPILADOS), NO vuelvas a pedirlo
- Cuando tengas todos los datos, muestra un resumen y pide confirmación con "¿Todo correcto? Responde SÍ para confirmar tu pedido."
- Si el cliente confirma con "sí", "si", "correcto", "confirmo", "di", "listo", responde ÚNICAMENTE con la palabra: ORDEN_CONFIRMADA
- No respondas nada más cuando confirmes — solo ORDEN_CONFIRMADA
- Si hay algún error, corrígelo amablemente
- Sé breve y directo

DATOS RECOPILADOS HASTA AHORA:
{ORDER_DRAFT}

PRODUCTOS DISPONIBLES:
{PRODUCTOS}`;

/**
 * Agente de Órdenes — Recopila datos y confirma el pedido
 */
async function generateOrderResponse(conversationHistory, userMessage, orderDraft, productosTexto) {
  const productContext = productosTexto || 'Sin productos disponibles.';
  const draftContext = Object.keys(orderDraft).length > 0
    ? JSON.stringify(orderDraft, null, 2)
    : 'Ninguno aún';

  const system = ORDERS_SYSTEM
    .replace('{ORDER_DRAFT}', draftContext)
    .replace('{PRODUCTOS}', productContext);

  const messages = conversationHistory.slice(-8).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || last.content !== userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 350,
    system,
    messages,
  });

  return response.content[0]?.text?.trim() || '';
}

/**
 * Extrae datos del pedido del historial de conversación
 * Usa Claude para parsear la información dada por el cliente
 */
async function extractOrderData(conversationHistory, currentDraft) {
  const EXTRACT_SYSTEM = `Extrae los datos del pedido de esta conversación de WhatsApp.
Devuelve SOLO un JSON con los campos que encuentres. Si no encuentras un campo, omítelo.
Campos posibles:
- customer_name: nombre completo del cliente
- product_name: nombre exacto del producto y variante (ej: "Huevos XL Bandeja 30 unidades")
- quantity: número entero de unidades/packs pedidos
- address: dirección de envío (calle, número, sector)
- city: ciudad de envío
- variant_id: ID de variante Shopify si aparece en la conversación
- price: precio unitario si se mencionó

Ejemplo: {"customer_name": "Juan Pérez", "product_name": "Huevos XL Bandeja 30 unidades", "quantity": 2, "address": "Av. Principal 123", "city": "La Serena"}

Solo el JSON, nada más.`;

  const recent = conversationHistory.slice(-10).map(m =>
    `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.content}`
  ).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: recent }],
    });

    const text = response.content[0]?.text || '{}';
    const extracted = JSON.parse(text.match(/\{.*\}/s)?.[0] || '{}');

    // Merge con el draft existente (los nuevos datos sobreescriben)
    return { ...currentDraft, ...extracted };
  } catch {
    return currentDraft;
  }
}

/**
 * Verifica si el cliente confirmó la orden
 */
function isOrderConfirmed(agentResponse, userMessage) {
  // El agente dice "ORDEN_CONFIRMADA" o
  // el mensaje es la confirmación final del agente
  if (agentResponse.includes('ORDEN_CONFIRMADA')) return true;

  // El cliente dice sí después del resumen
  const confirmWords = ['sí', 'si', 'yes', 'confirmo', 'correcto', 'adelante', 'procede', 'ok'];
  const lowerMsg = userMessage.toLowerCase().trim();
  return confirmWords.some(w => lowerMsg === w || lowerMsg.startsWith(w + ' ') || lowerMsg.endsWith(' ' + w));
}

/**
 * Verifica si tenemos suficientes datos para crear la orden
 */
function hasRequiredData(draft) {
  return REQUIRED_FIELDS.every(f => draft[f]);
}


module.exports = { generateOrderResponse, extractOrderData, isOrderConfirmed, hasRequiredData };
