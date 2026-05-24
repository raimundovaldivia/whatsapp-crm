const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Agente Orquestador — Clasifica la intención del cliente
 * Usa claude-haiku (rápido y barato) para esta tarea simple
 */
async function classifyIntent(userMessage, conversationHistory, pipelineState) {
  const SYSTEM = `Eres un clasificador de intenciones para un chat de ventas de WhatsApp.
Tu ÚNICA tarea es clasificar el mensaje del cliente en UNA de estas categorías:

- exploring: El cliente está viendo productos, haciendo preguntas generales, comparando opciones
- interested: El cliente muestra interés claro en comprar ("¿cuánto cuesta?", "me gusta ese", "lo quiero")
- wants_to_order: El cliente está listo para comprar ahora ("quiero pedir", "cómo compro", "quiero ese")
- objection: El cliente tiene dudas, el precio le parece caro, o tiene resistencia a comprar
- collecting_info: El cliente está en proceso de dar datos para el pedido
- support: Pregunta sobre envíos, tiempos, devoluciones, estado de pedido
- human_request: El cliente quiere hablar con una persona real

Estado actual de la conversación: ${pipelineState}

Responde SOLO con el JSON: {"intent": "categoria", "confidence": 0.0-1.0, "reason": "una linea"}
Nada más. Solo el JSON.`;

  const history = conversationHistory.slice(-5).map(m => ({
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
 * Detecta señales como: frustración,循环sin avance, queja, situación compleja
 * que la IA no puede resolver sola.
 *
 * @returns {{ escalate: boolean, reason: string, urgency: 'low'|'medium'|'high' }}
 */
async function checkEscalation(userMessage, conversationHistory, pipelineState) {
  // Señales rápidas sin llamar a la IA (ahorra costo y latencia)
  const msg = userMessage.toLowerCase();

  // Señales obvias de frustración / solicitud de humano
  const hardEscalationPatterns = [
    /habla[r]? con (una |un )?(persona|humano|asesor|agente|vendedor)/i,
    /quiero (hablar|habla) con alguien/i,
    /no (me |te )?(entiendes?|sirves?|funciona[s]?|ayuda[s]?)/i,
    /que (bronca|rabia|pena|molestia)/i,
    /esto (es|está) (muy |súper )?(malo|terrible|pésimo|horrible)/i,
    /\b(mentira|estafa|fraude|engaño)\b/i,
    /\b(enojado|molesto|furioso|harto)\b/i,
  ];
  if (hardEscalationPatterns.some(p => p.test(userMessage))) {
    return { escalate: true, reason: 'Cliente muestra frustración o solicita humano explícitamente', urgency: 'high' };
  }

  // Conversación muy larga sin resolución (≥ 12 mensajes en collecting_order)
  if (pipelineState === 'collecting_order' && conversationHistory.length >= 14) {
    return { escalate: true, reason: 'Proceso de pedido demasiado largo sin completarse', urgency: 'medium' };
  }

  // Si hay menos de 4 mensajes, no escalar aún (muy temprano)
  if (conversationHistory.length < 4) {
    return { escalate: false, reason: 'Conversación nueva', urgency: 'low' };
  }

  // ── IA para casos ambiguos ──────────────────────────────────────
  const ESCALATION_SYSTEM = `Eres un supervisor de calidad de chat para una tienda online.
Analiza los últimos mensajes de esta conversación de WhatsApp y decide si un humano debe intervenir.

ESCALA (escalate: true) cuando detectes:
- Cliente frustrado, molesto, o repitiendo la misma queja 2+ veces
- Conversación circular: la IA hace la misma pregunta sin avanzar
- Preguntas sobre problemas con pedidos anteriores, devoluciones, quejas
- Cliente confundido durante demasiados turnos (5+) sin resolución
- Situación que claramente excede la capacidad de un bot de ventas
- Cliente dejó de responder mucho tiempo y retoma con reclamo

NO ESCALES cuando:
- El cliente simplemente está explorando productos
- La conversación avanza normalmente hacia un pedido
- El cliente solo tiene una duda puntual que la IA puede resolver

Estado actual: ${pipelineState}

Responde SOLO con JSON: {"escalate": true/false, "reason": "una línea clara", "urgency": "low|medium|high"}`;

  const recent = conversationHistory.slice(-8).map(m =>
    `${m.direction === 'inbound' ? 'CLIENTE' : 'BOT'}: ${m.content}`
  ).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
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
