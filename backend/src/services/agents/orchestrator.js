const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Agente Orquestador — Clasifica la intención del cliente
 * Usa claude-haiku (rápido y barato) para esta tarea simple
 */
async function classifyIntent(userMessage, conversationHistory, pipelineState) {
  const SYSTEM = `Eres un clasificador de intenciones para un chat de ventas de WhatsApp.
Tu ÚNICA tarea es clasificar el mensaje del cliente en UNA de estas categorías:

- greeting: Primer mensaje o saludo simple sin contexto de compra ("hola", "buenas", "hay alguien?")
- exploring: El cliente está viendo productos, haciendo preguntas generales, comparando opciones
- interested: El cliente muestra interés claro ("¿cuánto cuesta?", "me gusta ese", "lo quiero", "cuánto vale")
- wants_to_order: El cliente está listo para comprar ahora ("quiero pedir", "cómo compro", "me lo mandas", "lo quiero pedir")
- objection: El cliente tiene dudas, el precio le parece caro, o tiene resistencia a comprar
- delivery_inquiry: Pregunta sobre envíos, tiempos de entrega, zonas de despacho, horarios
- support: Pregunta sobre estado de pedido, devoluciones, cambios, reclamos de pedido anterior
- post_sale: El cliente ya compró y tiene preguntas de seguimiento ("cuándo llega", "puedo cancelar", "no me llegó")
- human_request: El cliente quiere hablar con una persona real explícitamente

REGLAS:
- Si el mensaje es MUY corto (1-3 palabras) y es el inicio, probablemente es "greeting"
- Si ya hay historial de conversación largo, no es "greeting"
- "delivery_inquiry" es distinto de "support": delivery_inquiry es ANTES de comprar, support es DESPUÉS
- Estado actual de la conversación: ${pipelineState}

Responde SOLO con el JSON: {"intent": "categoria", "confidence": 0.0-1.0, "reason": "una linea"}
Nada más. Solo el JSON.`;

  // Más contexto histórico para clasificar mejor
  const history = conversationHistory.slice(-8).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: SYSTEM,
      messages: [...history, { role: 'user', content: userMessage }],
    });

    const text = response.content[0]?.text || '{}';
    const json = JSON.parse(text.match(/\{.*\}/s)?.[0] || '{}');
    return {
      intent: json.intent || 'exploring',
      confidence: json.confidence || 0.5,
      reason: json.reason || '',
    };
  } catch (err) {
    console.error('[Orchestrator] Error clasificando intención:', err.message);
    return { intent: 'exploring', confidence: 0.5, reason: 'fallback' };
  }
}

/**
 * Agente de Escalación — Decide si la conversación necesita atención humana.
 *
 * @returns {{ escalate: boolean, reason: string, urgency: 'low'|'medium'|'high', loopDetected?: boolean }}
 */
async function checkEscalation(userMessage, conversationHistory, pipelineState, orgId = null) {
  // ── 0. Romper bucle de escalación ────────────────────────────────
  const ESCALATION_PHRASES = [
    'voy a conectarte', 'te voy a conectar', 'ya te atienden',
    'pasarte con', 'asesor para que te ayude', 'conectarte ahora mismo',
    'un asesor te', 'uno de nuestros asesores',
  ];
  const recentBotMsgs = (conversationHistory || []).filter(m => m.direction === 'outbound').slice(-4);
  const escalationLoopCount = recentBotMsgs.filter(m =>
    ESCALATION_PHRASES.some(phrase => m.content?.toLowerCase().includes(phrase))
  ).length;
  if (escalationLoopCount >= 2) {
    return { escalate: false, loopDetected: true, reason: 'Rompiendo bucle — bot ya escaló múltiples veces', urgency: 'low' };
  }

  // ── 1. Mensajes simples: NUNCA escalar ──────────────────────────
  const simpleMsg = /^(hola|hi|hello|hey|buenas?|buen[oa]s? (días?|tardes?|noches?)|como estas?|qué tal|cómo estás?|saludos?|holis?|que tal|ke tal|bien|gracias?|ok|okay|si|no|claro|dale|perfecto|listo|entendido|ya|oka|okey|👍|😊|🙏)\s*[!?\.]*$/i;
  if (simpleMsg.test(userMessage.trim())) {
    return { escalate: false, reason: 'Mensaje simple', urgency: 'low' };
  }

  // ── 2. Solicitud explícita de humano (alta prioridad) ──────────
  const hardEscalationPatterns = [
    /habla[r]? con (una |un )?(persona|humano|asesor|agente|vendedor)/i,
    /quiero (hablar|habla) con alguien/i,
    /pásame? (con|a) (un |una )?(persona|humano|asesor|agente)/i,
    /\b(asesor|ejecutivo|persona real|humano)\b.*por favor/i,
    /necesito (hablar|ayuda) (de|con) (una persona|alguien)/i,
    /comunicarme? con (alguien|una persona)/i,
  ];
  if (hardEscalationPatterns.some(p => p.test(userMessage))) {
    return { escalate: true, reason: 'Cliente solicita hablar con una persona explícitamente', urgency: 'high' };
  }

  // ── 3. Frustración fuerte ─────────────────────────────────────
  const frustrationPatterns = [
    /no (me |te )?(entiendes?|sirves?|funciona[s]?|ayuda[s]?|entiendes?)/i,
    /\b(mentira|estafa|fraude|engaño|pésimo|horrible|terrible|nefasto)\b/i,
    /\b(enojado|molesto|furioso|harto|indignado|decepcionado)\b/i,
    /esto (es|está) (un )?desastre/i,
    /nunca (me|te|les) (llega?|contesta[n]?|responde[n]?)/i,
    /llevo (esperando|días?|semanas?) (y|sin)/i,
    /qu[eé] mal (servicio|atención)/i,
    /no (sirve|funciona) (nada|esto|el bot)/i,
    /(reclamaci[oó]n|devoluci[oó]n|reembolso) (urgente|inmediata?)/i,
  ];
  if (frustrationPatterns.some(p => p.test(userMessage))) {
    return { escalate: true, reason: 'Cliente muestra frustración fuerte', urgency: 'high' };
  }

  // ── 4. Post-venta complejo ─────────────────────────────────────
  const postSaleComplexPatterns = [
    /mi pedido (no|nunca) (llegó|llego|ha llegado)/i,
    /pedido (perdido|equivocado|incorrecto|dañado|roto)/i,
    /(quiero|necesito) (cancelar|devolver|cambiar) (mi )?pedido/i,
    /me (trajeron|llegó|mandaron) (lo equivocado|algo diferente|mal)/i,
  ];
  if (postSaleComplexPatterns.some(p => p.test(userMessage))) {
    return { escalate: true, reason: 'Situación de posventa compleja detectada', urgency: 'medium' };
  }

  // ── 5. Solo usar IA si hay suficiente historial ─────────────────
  const botResponses  = conversationHistory.filter(m => m.direction === 'outbound').length;
  const clientMessages = conversationHistory.filter(m => m.direction === 'inbound').length;

  if (botResponses < 2) {
    return { escalate: false, reason: 'Bot aún no ha tenido interacción suficiente', urgency: 'low' };
  }

  // Proceso de pedido muy largo sin completarse
  if (pipelineState === 'collecting_order' && clientMessages >= 14 && botResponses >= 7) {
    return { escalate: true, reason: 'Proceso de pedido muy largo sin completarse', urgency: 'medium' };
  }

  if (conversationHistory.length < 8 || botResponses < 3) {
    return { escalate: false, reason: 'Conversación en curso normal', urgency: 'low' };
  }

  // ── 6. IA con aprendizaje de escalaciones incorrectas ────────────
  let negativeExamplesText = '';
  if (orgId) {
    try {
      const db = require('../../db/database');
      const negExamples = await db.getEscalationNegativeExamples(orgId, 6);
      if (negExamples.length > 0) {
        negativeExamplesText = `\n\nAPRENDIZAJE — NO escalar cuando el mensaje sea similar a:\n` +
          negExamples.map((e, i) => `${i + 1}. "${e.message_content}" → la razón incorrecta fue: "${e.escalation_reason}"`).join('\n');
      }
    } catch (_) {}
  }

  const ESCALATION_SYSTEM = `Eres un supervisor de calidad de chat para una tienda online.
Analiza los últimos mensajes y decide si un humano debe intervenir.

ESCALA (escalate: true) SOLO cuando detectes claramente:
- Cliente repite la MISMA queja o problema 3+ veces sin resolución
- Cliente explícitamente frustrado con el servicio del bot
- Situación de posventa: devoluciones, pedidos perdidos, reclamos activos

NO ESCALES por:
- Conversación normal de ventas aunque sea larga
- Cliente haciendo preguntas normales sobre productos o envíos
- Proceso de pedido en curso aunque tenga varios pasos
- Mensajes cortos o respuestas simples del cliente
- Primera vez que el cliente pregunta algo${negativeExamplesText}

Estado actual: ${pipelineState}

Responde SOLO con JSON: {"escalate": true/false, "reason": "una línea", "urgency": "low|medium|high"}`;

  const recent = conversationHistory.slice(-12)
    .filter(m => m.content?.length > 2)
    .map(m => `${m.direction === 'inbound' ? 'CLIENTE' : 'BOT'}: ${m.content}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: ESCALATION_SYSTEM,
      messages: [{ role: 'user', content: `${recent}\nCLIENTE: ${userMessage}` }],
    });

    const text = response.content[0]?.text || '{}';
    const json = JSON.parse(text.match(/\{.*\}/s)?.[0] || '{}');
    return {
      escalate: json.escalate === true,
      reason:   json.reason   || '',
      urgency:  json.urgency  || 'low',
    };
  } catch (err) {
    console.warn('[Orchestrator] Error en checkEscalation:', err.message);
    return { escalate: false, reason: 'error', urgency: 'low' };
  }
}

module.exports = { classifyIntent, checkEscalation };
