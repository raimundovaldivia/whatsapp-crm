const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Campos requeridos para crear la orden
const REQUIRED_FIELDS = ['customer_name', 'product_name', 'address', 'city'];
// quantity tiene default 1, no es bloqueante

const ORDERS_SYSTEM = `Eres el asistente de pedidos de una tienda. El cliente ya decidió comprar. Tu trabajo: completar la orden de forma natural y rápida, sin hacerla tedioso.

━━━ DATOS QUE NECESITAS (en este orden) ━━━
1. Nombre completo
2. Producto + cantidad (si no dice cantidad, asume 1 y confírmalo)
3. Dirección de envío (calle, número, sector/barrio si aplica)
4. Ciudad
5. Confirmación final

━━━ REGLAS CRÍTICAS ━━━
- Pide UN dato a la vez. Nunca preguntes 2 cosas en el mismo mensaje.
- Si un dato ya está en DATOS RECOPILADOS → NO lo pidas de nuevo jamás.
- NUNCA inventes ni supongas datos que no están en DATOS RECOPILADOS.
- Si el cliente dice una cantidad ("uno", "dos", "un par", "3"), intégrala directamente.
- Cantidad no especificada = 1 (asúmelo y menciona "1 unidad" en el resumen para que confirme).
- IMPORTANTE — PRODUCTO YA ELEGIDO: Si en el historial de la conversación el cliente ya mencionó un producto (ej: "1 xl", "la de 12 mil", "huevos XL"), y el agente ya le había presentado opciones con precios, DEDUCE el producto completo desde el historial y NO vuelvas a preguntar "¿qué producto quieres?". Usar la conversación completa como contexto.

━━━ CLIENTE CON DATOS PREVIOS ━━━

CASO A — Tienes nombre + dirección + ciudad en DATOS RECOPILADOS:
  Saluda por nombre: "¡Hola [nombre]! 😊"
  Confirma dirección directamente: "¿Enviamos de nuevo a [dirección], [ciudad]?"
  NO preguntes la dirección — ya la tienes. Solo confirma con el cliente.
  Si confirma → pide solo el producto si falta, o cierra con resumen.

CASO B — Tienes nombre pero NO dirección/ciudad:
  Saluda por nombre: "¡Hola [nombre]!"
  Pide lo que falta (NO menciones dirección anterior si no la tienes).

CASO C — Sin datos:
  Pide nombre primero. Luego producto. Luego dirección. Luego ciudad.

━━━ RESUMEN Y CONFIRMACIÓN ━━━
Cuando tengas TODOS los datos, muestra un resumen claro y pregunta "¿Todo correcto?" ANTES de pedir el método de pago:

"¡Listo! Te confirmo el pedido:
📦 [Producto] x[cantidad]
👤 [Nombre]
📍 [Dirección], [Ciudad]

¿Todo correcto?"

IMPORTANTE: NO preguntes el método de pago hasta que el cliente confirme el resumen.

- Cuando el cliente confirme el resumen (responda "sí", "correcto", "dale", "ok", etc.) responde ÚNICAMENTE: ORDEN_CONFIRMADA
- Si el cliente confirma que ya realizó el pago ("listo el pago", "ya pagué", "hice la transferencia", "transferido", "listo", "pagado", etc.) → también responde ÚNICAMENTE: ORDEN_CONFIRMADA
- Nada más que ORDEN_CONFIRMADA — esta palabra activa el sistema.

━━━ CASOS ESPECIALES ━━━
- Si el cliente menciona un producto ambiguo (ej: "los huevos") y hay varias opciones → muestra las opciones brevemente y pregunta cuál.
- Si el cliente cambia de producto a mitad del proceso → actualiza y sigue normalmente.
- Si el cliente quiere cancelar → di "Entendido, no hay problema 😊 ¿Puedo ayudarte con algo más?" y no insistas.

━━━ TONO ━━━
- Cálido pero eficiente. No robótico.
- Emojis solo donde suman (📦, 👤, 📍, 😊) — no en cada línea.
- Texto plano, sin asteriscos ni markdown.

DATOS RECOPILADOS HASTA AHORA:
{ORDER_DRAFT}

PRODUCTOS DISPONIBLES:
{PRODUCTOS}`;

/**
 * Agente de Órdenes — Recopila datos y confirma el pedido
 */
async function generateOrderResponse(conversationHistory, userMessage, orderDraft, productosTexto) {
  const productContext = productosTexto || 'Sin catálogo disponible.';
  const draftContext = Object.keys(orderDraft).length > 0
    ? JSON.stringify(filterDraftForDisplay(orderDraft), null, 2)
    : 'Ninguno aún';

  const system = ORDERS_SYSTEM
    .replace('{ORDER_DRAFT}', draftContext)
    .replace('{PRODUCTOS}', productContext);

  // Más historial para el agente de pedidos — necesita recordar el contexto completo
  const messages = conversationHistory.slice(-20).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || last.content !== userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system,
    messages,
  });

  return response.content[0]?.text?.trim() || '';
}

/**
 * Extrae datos del pedido del historial de conversación
 * Usa haiku (barato/rápido) para parsear info estructurada
 */
async function extractOrderData(conversationHistory, currentDraft) {
  const EXTRACT_SYSTEM = `Extrae los datos del pedido de esta conversación de WhatsApp.
Devuelve SOLO un JSON con los campos que encuentres. Si no encuentras un campo, omítelo.

Campos posibles:
- customer_name: nombre completo del cliente (ej: "Juan Pérez")
- product_name: nombre del producto + variante (ej: "Huevos XL Bandeja 30")
- quantity: número entero de unidades. Si dice "uno" → 1, "un par" → 2, "media docena" → 6. Si no especifica → omite el campo.
- address: dirección de envío incluyendo calle, número y sector si los menciona
- city: ciudad de envío
- region: región o provincia si la menciona
- customer_phone: teléfono si el cliente lo menciona explícitamente
- notes: instrucciones especiales de entrega si las hay (ej: "dejar en conserjería", "tocar timbre 2")
- price: precio unitario si fue mencionado en la conversación

REGLAS CRÍTICAS:
- Para product_name: si el cliente eligió de una lista presentada por el Agente (ej: cliente dijo "el de 12 mil", "ese", "la XL", "la bandeja grande"), deduce el producto completo mirando qué opción corresponde al precio o descripción elegida por el cliente en el historial del Agente.
- Si el agente listó opciones y el cliente confirmó una (por precio, tamaño o "ese/esa"), extrae el nombre completo de esa opción.
- Si el cliente corrije un dato (ej: "no, mi nombre es..."), usa el valor corregido.
- Si el cliente no especificó cantidad pero sí dijo "uno" o pidió "1 XL" → quantity = 1.

Ejemplo: Si Agente dijo "Bandeja 30 huevos XL — $12.000" y cliente respondió "De 12 mil" o "la XL" → product_name = "Bandeja 30 huevos XL", price = 12000.

Solo el JSON, nada más.`;

  // Usar más historial para capturar el producto aunque se haya mencionado antes
  const recent = conversationHistory.slice(-20).map(m =>
    `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.content}`
  ).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: recent }],
    });

    const text = response.content[0]?.text || '{}';
    const extracted = JSON.parse(text.match(/\{.*\}/s)?.[0] || '{}');

    // Merge: los nuevos datos sobreescriben, pero nunca eliminar datos ya confirmados
    const merged = { ...currentDraft };
    for (const [key, value] of Object.entries(extracted)) {
      if (value !== null && value !== undefined && value !== '') {
        merged[key] = value;
      }
    }

    // Limpiar campos internos del merge que no deben sobreescribirse por extracción
    if (currentDraft.shopify_customer_id && !extracted.shopify_customer_id) {
      merged.shopify_customer_id = currentDraft.shopify_customer_id;
    }

    return merged;
  } catch {
    return currentDraft;
  }
}

/**
 * Verifica si el cliente confirmó la orden.
 * IMPORTANTE: Solo confiamos en ORDEN_CONFIRMADA del agente.
 * La comprobación del mensaje del cliente es un fallback defensivo
 * que solo aplica si ya tenemos TODOS los datos (resumen ya fue mostrado).
 */
function isOrderConfirmed(agentResponse, userMessage, orderDraft = {}) {
  // El agente emite la señal interna → confianza total
  if (agentResponse.includes('ORDEN_CONFIRMADA')) return true;

  // Fallback: el cliente confirma Y ya tenemos todos los datos (el resumen ya fue mostrado)
  // Esto evita falsos positivos cuando el cliente dice "si" en medio de la conversación
  if (hasRequiredData(orderDraft)) {
    const confirmWords = ['sí', 'si', 'yes', 'confirmo', 'correcto', 'adelante', 'procede', 'dale', 'listo', 'ok', 'okey', 'oka', 'vamo', 'vamos', '👍'];
    const lowerMsg = userMessage.toLowerCase().trim();
    // Solo si el mensaje ES la confirmación (muy corto o solo esa palabra)
    const isShortConfirmation = lowerMsg.length <= 20;
    if (isShortConfirmation && confirmWords.some(w => lowerMsg === w || lowerMsg.startsWith(w) || lowerMsg === w + '!' || lowerMsg === w + '.')) {
      return true;
    }

    // Frases de pago confirmado — siempre son confirmación de orden independiente del largo
    const paymentPhrases = ['listo el pago', 'ya pagué', 'ya pague', 'hice la transferencia',
      'hice el pago', 'ya transferí', 'ya transferi', 'transferido', 'pago realizado',
      'ya deposité', 'ya deposite', 'acabo de pagar', 'listo pagué', 'listo pague'];
    if (paymentPhrases.some(p => lowerMsg.includes(p))) {
      return true;
    }
  }

  return false;
}

/**
 * Verifica si tenemos suficientes datos para crear la orden
 * quantity no es obligatorio — default 1
 */
function hasRequiredData(draft) {
  return REQUIRED_FIELDS.every(f => draft[f]);
}

/**
 * Filtra el draft para mostrarle al agente solo campos relevantes
 * (evita mostrar IDs internos de Shopify que confunden al modelo)
 */
function filterDraftForDisplay(draft) {
  const { found_in_contacts, found_in_shopify, shopify_customer_id, ...display } = draft;
  return display;
}

module.exports = { generateOrderResponse, extractOrderData, isOrderConfirmed, hasRequiredData };
