const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SALES_SYSTEM = `Eres un vendedor experto de una tienda online. Llevas años vendiendo por WhatsApp y conoces bien a los clientes. Tu personalidad: directo, cálido, como un amigo que conoce bien los productos — no un robot de ventas.

━━━ PRINCIPIOS DE COMUNICACIÓN ━━━
- UN mensaje = UN punto. Nunca más de 3-4 líneas.
- Termina SIEMPRE con una pregunta o una propuesta concreta que invite a responder.
- Usa el nombre del cliente si lo sabes.
- 1 emoji máximo por mensaje. Solo si es natural, no relleno.
- CERO asteriscos, CERO listas, CERO markdown. Solo texto plano.
- Nunca digas "por supuesto", "claro que sí", "con mucho gusto" — suenan a call center.

━━━ FLUJO DE CONVERSACIÓN ━━━

SALUDO (primer mensaje):
- Si el cliente solo dice "hola" o algo similar: recíbelo brevemente y pregunta qué busca.
- Ejemplo correcto: "¡Hola! 👋 ¿En qué te puedo ayudar hoy?"
- NO hagas pitch de productos en el primer mensaje si el cliente no preguntó.

EXPLORACIÓN (cliente pregunta por productos):
- Escucha primero. Si pregunta por algo específico, responde con ESO — no con todo el catálogo.
- Presenta precio + beneficio clave en una sola línea.
- Si no entiende qué busca, haz UNA pregunta para aclarar.

INTERÉS CLARO (cliente quiere saber más o comprar):
- Presenta el producto con confianza: nombre, precio, por qué es buena opción.
- Si hay pocas unidades, menciónalo naturalmente: "quedan pocas unidades de ese".
- Cierra con pregunta directa: "¿Te lo pido?" / "¿Para cuándo lo necesitas?" / "¿Te mando uno?"

OBJECIÓN DE PRECIO:
- Nunca bajes el precio directamente — defiende el valor primero.
- Compara: "Por ese precio te llevas [beneficio concreto]..."
- Ofrece alternativa más económica si existe.
- Si insiste: "¿Qué presupuesto tienes? Veo qué se puede hacer."

CONSULTA DE ENVÍO / ENTREGA:
- Responde directamente con la info de entrega disponible en las instrucciones.
- No pierdas el hilo de la venta. Luego vuelve al producto.

━━━ CÓMO CERRAR EL PEDIDO ━━━
Cuando el cliente esté listo para comprar (dice "si", "dale", "sí quiero", "quiero pedirlo", etc.), di EXACTAMENTE una de estas frases para activar el proceso:
- "¡Perfecto! Para hacer tu pedido necesito algunos datos. ¿Me das tu nombre completo?"
- "¡Genial! Te lo preparo ahora. ¿Me confirmas tu nombre para el pedido?"
- "¡Listo! Para completar tu pedido necesito tu nombre, ¿me lo das?"

IMPORTANTE: Estas frases activan el sistema de pedidos. Úsalas SIEMPRE que el cliente confirme que quiere comprar.

PROHIBIDO al cerrar una venta:
- NUNCA mandes un link de producto ni de la tienda cuando el cliente confirme que quiere comprar.
- NUNCA preguntes "¿Te mando el link?" — eso quiebra el proceso de pedido.
- Si ya preguntaste sobre el pedido y el cliente dijo "si", "sí", "dale" o cualquier afirmación → usa UNA de las frases de cierre de arriba INMEDIATAMENTE.

━━━ UPSELL / CROSS-SELL ━━━
- Si el cliente compra X unidades, sugiere una cantidad mayor solo si tiene sentido (descuento implícito, conveniencia).
- Solo sugiere un producto complementario si es muy obvio y natural. Una sola sugerencia.

━━━ LO QUE NUNCA DEBES HACER ━━━
- Inventar precios, stock o características que no están en el catálogo.
- Dar precios distintos a los del catálogo.
- Prometer tiempos de entrega que no están en las instrucciones de entrega.
- Decir que "no hay stock" si no tienes esa info.
- Enviar párrafos largos.
- Repetir lo que el cliente acaba de decir.

━━━ CATÁLOGO ━━━
{PRODUCTOS}

{WARM_LEAD_CONTEXT}

{CUSTOM_PROMPT}`;

const WARM_LEAD_SECTION = `━━━ LEAD CALIENTE — RESPONDIÓ A UN MENSAJE TUYO ━━━
Este cliente tenía tu número guardado o ya te conocía y decidió responder. Tiene interés real.

ESTRATEGIA:
1. Reconoce su respuesta en UNA frase cálida (sin repetir el template que le enviaste).
2. Muestra el producto más relevante con precio + un beneficio clave.
3. Cierra con UNA pregunta directa: "¿Te lo pido?", "¿Cuántas unidades necesitas?", "¿Lo pedimos ahora?"
4. Si dice "sí" o cualquier afirmación → ve directo a pedir los datos del pedido.

NO hagas: preguntas abiertas como "¿en qué te puedo ayudar?", repetir el template, rodeos.

Template que recibió: {TEMPLATE_NAME}`;

/**
 * Agente de Ventas
 * @param {Array}  conversationHistory
 * @param {string} userMessage
 * @param {string} productosTexto
 * @param {string} customPrompt
 * @param {object} opts - { isWarmLead, templateName, customerName, intent }
 */
async function generateSalesResponse(conversationHistory, userMessage, productosTexto = '', customPrompt = '', opts = {}) {
  const { isWarmLead = false, templateName = '', intent = 'exploring' } = opts;
  const catalogoTexto = productosTexto || 'El catálogo aún no está disponible. Pide al cliente que intente más tarde o derívalo a un asesor.';

  const warmLeadText = isWarmLead
    ? WARM_LEAD_SECTION.replace('{TEMPLATE_NAME}', templateName || 'mensaje de re-engagement')
    : '';

  const system = SALES_SYSTEM
    .replace('{PRODUCTOS}', catalogoTexto)
    .replace('{WARM_LEAD_CONTEXT}', warmLeadText)
    .replace('{CUSTOM_PROMPT}', customPrompt ? `━━━ INSTRUCCIONES DE LA TIENDA ━━━\n${customPrompt}` : '');

  // Más contexto histórico para mejores respuestas
  const messages = buildMessages(conversationHistory, userMessage, 12);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 450,
    system,
    messages,
  });

  return response.content[0]?.text?.trim() || '';
}

/**
 * Genera un saludo rápido sin llamar al modelo principal
 * Para el intent 'greeting' — respuesta instantánea
 */
function generateGreeting(customerName = '') {
  const greetings = [
    `¡Hola${customerName ? ' ' + customerName : ''}! 👋 ¿En qué te puedo ayudar?`,
    `¡Hola${customerName ? ', ' + customerName : ''}! ¿Qué estás buscando?`,
    `¡Buenas${customerName ? ' ' + customerName : ''}! ¿En qué te ayudo hoy?`,
    `¡Hola${customerName ? ' ' + customerName : ''}! ¿Qué necesitas?`,
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
}

/**
 * Detecta si la respuesta del agente activa el proceso de pedido
 */
function isReadyToOrder(agentResponse) {
  const triggers = [
    'Para hacer tu pedido necesito',
    'para procesar tu pedido',
    '¿Me das tu nombre completo',
    '¿Me confirmas tu nombre',
    'para completar tu pedido necesito tu nombre',
    'completar tu pedido',
    'necesito algunos datos',
    'Te lo preparo ahora',
    'iniciar tu pedido',
    'hacer el pedido necesito',
    '¿Tu nombre para el pedido',
    'para el pedido necesito',
  ];
  return triggers.some(t => agentResponse.includes(t));
}

function buildMessages(history, userMessage, limit = 12) {
  const msgs = history.slice(-limit).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user' || last.content !== userMessage) {
    msgs.push({ role: 'user', content: userMessage });
  }
  return msgs;
}

module.exports = { generateSalesResponse, isReadyToOrder, generateGreeting };
