const Anthropic = require('@anthropic-ai/sdk');
const { normalizeDraft } = require('../order-pricing');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Campos requeridos para crear la orden (además de al menos un ítem)
const REQUIRED_FIELDS = ['customer_name', 'address', 'city'];

const ORDERS_SYSTEM = `Eres el asistente de pedidos de una tienda. El cliente ya decidió comprar. Tu trabajo: completar la orden de forma natural y rápida, sin hacerla tediosa.

━━━ DATOS QUE NECESITAS (en este orden) ━━━
1. Nombre completo
2. Productos + cantidades (puede ser MÁS DE UN producto; si no dice cantidad, asume 1 y confírmalo)
3. Dirección de envío (calle, número, sector/barrio si aplica)
4. Ciudad
5. Confirmación final

━━━ REGLAS CRÍTICAS ━━━
- Pide UN dato a la vez. Nunca preguntes 2 cosas en el mismo mensaje.
- Si un dato ya está en DATOS RECOPILADOS → NO lo pidas de nuevo jamás.
- NUNCA inventes ni supongas datos que no están en DATOS RECOPILADOS.
- Si el cliente dice una cantidad ("uno", "dos", "un par", "3"), intégrala directamente.
- Cantidad no especificada = 1 (asúmelo y menciona "1 unidad" en el resumen para que confirme).
- El cliente puede pedir VARIOS productos ("dos bandejas XL y una de color"). Regístralos todos; no le hagas elegir uno.
- Si el cliente agrega o quita productos a mitad del proceso → acepta el cambio y sigue.
- PRODUCTO YA ELEGIDO: si en el historial el cliente ya mencionó un producto y el agente le había presentado opciones con precios, DEDUCE el producto completo desde el historial y NO vuelvas a preguntar "¿qué producto quieres?".

━━━ PRECIOS ━━━
Los precios y el total los calcula el sistema y aparecen en PEDIDO VALORIZADO. Usa EXACTAMENTE esos montos en el resumen. NUNCA calcules ni inventes precios tú.
Si un ítem aparece marcado como "NO está en el catálogo tal cual", pregunta al cliente cuál de los productos del catálogo es, antes de mostrar el resumen.

━━━ CLIENTE CON DATOS PREVIOS ━━━

CASO A — Tienes nombre + dirección + ciudad en DATOS RECOPILADOS:
  Saluda por nombre: "¡Hola [nombre]! 😊"
  Confirma dirección directamente: "¿Enviamos de nuevo a [dirección], [ciudad]?"
  NO preguntes la dirección — ya la tienes. Solo confirma con el cliente.
  Si confirma → pide solo los productos si faltan, o cierra con resumen.

CASO B — Tienes nombre pero NO dirección/ciudad:
  Saluda por nombre: "¡Hola [nombre]!"
  Pide lo que falta (NO menciones dirección anterior si no la tienes).

CASO C — Sin datos:
  Pide nombre primero. Luego productos. Luego dirección. Luego ciudad.

━━━ MODIFICACIÓN DE UN PEDIDO EXISTENTE ━━━
Si en DATOS RECOPILADOS aparece "editing_order_id", el cliente está CAMBIANDO un pedido ya registrado. Pregunta qué quiere cambiar (productos, cantidad o dirección), aplica el cambio y muestra el resumen actualizado para que confirme. No vuelvas a pedir nombre ni dirección si ya están.

━━━ RESUMEN Y CONFIRMACIÓN ━━━
Cuando tengas TODOS los datos y todos los ítems estén en el catálogo, muestra un resumen claro y pregunta "¿Todo correcto?" ANTES de pedir el método de pago:

"¡Listo! Te confirmo el pedido:
📦 [cantidad]x [Producto] — $[subtotal línea]
📦 [cantidad]x [Producto] — $[subtotal línea]
💰 Total: $[total]
👤 [Nombre]
📍 [Dirección], [Ciudad]

¿Todo correcto?"

Si hay descuento acordado, agrega la línea "🏷️ Descuento X%" antes del total, con el monto que dice PEDIDO VALORIZADO.
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

PEDIDO VALORIZADO (calculado por el sistema):
{PRICING}

PRODUCTOS DISPONIBLES:
{PRODUCTOS}`;

/**
 * Agente de Órdenes — Recopila datos y confirma el pedido
 * @param {string} pricingText — salida de order-pricing.pricingContext()
 */
async function generateOrderResponse(conversationHistory, userMessage, orderDraft, productosTexto, pricingText = '') {
  const productContext = productosTexto || 'Sin catálogo disponible.';
  const draftContext = Object.keys(orderDraft).length > 0
    ? JSON.stringify(filterDraftForDisplay(orderDraft), null, 2)
    : 'Ninguno aún';

  const system = ORDERS_SYSTEM
    .replace('{ORDER_DRAFT}', draftContext)
    .replace('{PRICING}', pricingText || 'Aún no hay productos en el pedido.')
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
- items: lista COMPLETA y ACTUAL de productos que el cliente quiere, cada uno {"product_name": "...", "quantity": N}.
    · product_name: nombre del producto + variante tal como aparece en el catálogo o lo más parecido (ej: "Huevos XL Bandeja 30")
    · quantity: entero. "uno" → 1, "un par" → 2, "media docena" → 6. Si no especifica → 1.
    · Si el cliente pidió varios productos, incluye TODOS. Si cambió de opinión ("mejor solo una", "quita la de color"), refleja el estado FINAL, no el histórico.
- address: dirección de envío incluyendo calle, número y sector si los menciona
- city: ciudad de envío
- region: región o provincia si la menciona
- customer_phone: teléfono si el cliente lo menciona explícitamente
- notes: instrucciones especiales de entrega si las hay (ej: "dejar en conserjería", "tocar timbre 2")
- discount_pct: porcentaje de descuento SOLO si el Agente lo ofreció explícitamente Y el cliente lo aceptó (ej: 5, 7 o 10). Si no hubo descuento, omite el campo.

REGLAS CRÍTICAS:
- Para product_name: si el cliente eligió de una lista presentada por el Agente (ej: "el de 12 mil", "ese", "la XL", "la bandeja grande"), deduce el producto completo mirando qué opción corresponde al precio o descripción elegida en el historial del Agente.
- Si el cliente corrige un dato (ej: "no, mi nombre es..."), usa el valor corregido.
- Si el cliente comparte una ubicación ("[Ubicación compartida: ...]"), usa ese texto como address y deduce city de él.
- NO inventes precios. No incluyas campo "price".

Ejemplo: Agente dijo "Bandeja 30 huevos XL — $12.000 / Bandeja 30 huevos L — $10.500" y cliente respondió "dos XL y una L" → items = [{"product_name":"Bandeja 30 huevos XL","quantity":2},{"product_name":"Bandeja 30 huevos L","quantity":1}].

Solo el JSON, nada más.`;

  // Usar más historial para capturar el producto aunque se haya mencionado antes
  const recent = conversationHistory.slice(-20).map(m =>
    `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.content}`
  ).join('\n');

  const base = normalizeDraft(currentDraft);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: recent }],
    });

    const text = response.content[0]?.text || '{}';
    const extracted = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');

    // Compatibilidad: si el modelo devolvió el formato viejo, convertirlo
    if (!Array.isArray(extracted.items) && extracted.product_name) {
      extracted.items = [{ product_name: extracted.product_name, quantity: parseInt(extracted.quantity, 10) || 1 }];
    }
    delete extracted.product_name; delete extracted.quantity; delete extracted.price;

    // Merge: los nuevos datos sobreescriben, pero nunca eliminar datos ya confirmados.
    // items se reemplaza completo (la extracción es del historial entero, refleja el estado final).
    const merged = { ...base };
    for (const [key, value] of Object.entries(extracted)) {
      if (value === null || value === undefined || value === '') continue;
      if (key === 'items') {
        const clean = value
          .filter(it => it && (it.product_name || it.name))
          .map(it => ({ product_name: it.product_name || it.name, quantity: Math.max(1, parseInt(it.quantity, 10) || 1) }));
        if (clean.length) merged.items = clean;
        continue;
      }
      if (key === 'discount_pct') { merged.discount_pct = Number(value) || 0; continue; }
      merged[key] = value;
    }

    // Campos internos que la extracción no debe pisar
    if (base.shopify_customer_id) merged.shopify_customer_id = base.shopify_customer_id;
    if (base.editing_order_id)    merged.editing_order_id    = base.editing_order_id;

    return merged;
  } catch {
    return base;
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
  if (hasRequiredData(orderDraft)) {
    const confirmWords = ['sí', 'si', 'yes', 'confirmo', 'correcto', 'adelante', 'procede', 'dale', 'listo', 'ok', 'okey', 'oka', 'vamo', 'vamos', '👍'];
    const lowerMsg = userMessage.toLowerCase().trim();
    const isShortConfirmation = lowerMsg.length <= 20;
    if (isShortConfirmation && confirmWords.some(w => lowerMsg === w || lowerMsg.startsWith(w) || lowerMsg === w + '!' || lowerMsg === w + '.')) {
      return true;
    }

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
 * El cliente se arrepiente a mitad del proceso de pedido.
 * Solo mensajes cortos y claros — "no quiero la XL, quiero la L" NO es cancelar.
 */
function isCancelDuringCollection(userMessage) {
  const m = (userMessage || '').toLowerCase().trim();
  if (m.length > 40) return false;
  return /^(no|mejor no|no gracias|cancela(r|lo)?|cancelemos|olv[ií]dalo|d[ée]jalo|dejalo|ya no( lo)?( quiero)?|no quiero nada|nada por ahora)[\s!.]*$/i.test(m)
      || /\bcancel(a|ar|o|emos)\b.*\bpedido\b/i.test(m);
}

/**
 * Verifica si tenemos suficientes datos para crear la orden
 */
function hasRequiredData(draft) {
  return REQUIRED_FIELDS.every(f => draft[f]) && Array.isArray(draft.items) && draft.items.length > 0;
}

/** Campos que faltan, en palabras para el cliente. */
function missingFields(draft) {
  const labels = { customer_name: 'nombre completo', address: 'dirección', city: 'ciudad' };
  const missing = REQUIRED_FIELDS.filter(f => !draft[f]).map(f => labels[f]);
  if (!Array.isArray(draft.items) || draft.items.length === 0) missing.unshift('producto');
  return missing;
}

/**
 * Filtra el draft para mostrarle al agente solo campos relevantes
 * (evita mostrar IDs internos que confunden al modelo)
 */
function filterDraftForDisplay(draft) {
  const { found_in_contacts, found_in_shopify, shopify_customer_id, pricing, subtotal, total, discount_amount, ...display } = draft;
  if (Array.isArray(display.items)) {
    display.items = display.items.map(it => ({ product_name: it.name || it.product_name, quantity: it.quantity }));
  }
  return display;
}

module.exports = { generateOrderResponse, extractOrderData, isOrderConfirmed, isCancelDuringCollection, hasRequiredData, missingFields };
