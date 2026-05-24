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
async function checkEscalation(userMessage, conversationHistory, pipelineState, orgId = null) {
  // ── 1. Mensajes simples: NUNCA escalar ──────────────────────────
  const simpleGreetings = /^(hola|hi|hello|hey|buenas?|buen[oa]s? (días?|tardes?|noches?)|como estas?|qué tal|cómo estás?|saludos?|holis?|que tal|ke tal)\s*[!?\.]*$/i;
  if (simpleGreetings.test(userMessage.trim())) {
    return { escalate: false, reason: 'Saludo simple', urgency: 'low' };
  }

  // ── 2. Señales explícitas de solicitud de humano (alta prioridad) ──
  const hardEscalationPatterns = [
    /habla[r]? con (una |un )?(persona|humano|asesor|agente|vendedor)/i,
    /quiero (hablar|habla) con alguien/i,
    /pásame? (con|a) (un |una )?(persona|humano|asesor|agente)/i,
    /\b(asesor|ejecutivo|persona real|humano)\b.*por favor/i,
  ];
  if (hardEscalationPatterns.some(p => p.test(userMessage))) {
    return { escalate: true, reason: 'Cliente solicita hablar con una persona explícitamente', urgency: 'high' };
  }

  // ── 3. Señales de frustración fuerte ─────────────────────────────
  const frustrationPatterns = [
    /no (me |te )?(entiendes?|sirves?|funciona[s]?|ayuda[s]?)/i,
    /\b(mentira|estafa|fraude|engaño|pésimo|horrible|terrible)\b/i,
    /\b(enojado|molesto|furioso|harto|indignado)\b/i,
    /esto (es|está) (un )?desastre/i,
  ];
  if (frustrationPatterns.some(p => p.test(userMessage))) {
    return { escalate: true, reason: 'Cliente muestra frustración fuerte', urgency: 'high' };
  }

  // ── 4. Solo usar IA si hay suficiente historial CON respuestas del bot ──
  const botResponses = conversationHistory.filter(m => m.direction === 'outbound').length;
  const clientMessages = conversationHistory.filter(m => m.direction === 'inbound').length;

  if (botResponses < 2) {
    return { escalate: false, reason: 'Bot aún no ha tenido interacción suficiente', urgency: 'low' };
  }

  if (pipelineState === 'collecting_order' && clientMessages >= 12 && botResponses >= 6) {
    return { escalate: true, reason: 'Proceso de pedido muy largo sin completarse', urgency: 'medium' };
  }

  if (conversationHistory.length < 8 || botResponses < 3) {
    return { escalate: false, reason: 'Conversación en curso normal', urgency: 'low' };
  }

  // ── 5. IA con ejemplos negativos de feedback ──────────────────
  // Cargar ejemplos donde el agente se equivocó (feedback 'unnecessary')
  let negativeExamplesText = '';
  if (orgId) {
    try {
      const db = require('../../db/database');  // lazy require para evitar circular
      const negExamples = await db.getEscalationNegativeExamples(orgId, 6);
      if (negExamples.length > 0) {
        negativeExamplesText = `\n\nAPRENDIZAJE DE ERRORES PASADOS — NO escalar cuando el mensaje sea similar a:\n` +
          negExamples.map((e, i) => `${i + 1}. "${e.message_content}" → razón incorrecta fue: "${e.escalation_reason}"`).join('\n');
      }
    } catch (err) {
      // silencioso — no romper si la tabla no existe aún
    }
  }

  const ESCALATION_SYSTEM = `Eres un supervisor de calidad de chat para una tienda online.
Analiza los últimos mensajes y decide si un humano debe intervenir.

ESCALA (escalate: true) SOLO cuando detectes claramente:
- Cliente repite la MISMA queja o problema 3+ veces sin resolución
- Cliente explícitamente frustrado con el servicio del bot
- Situación de posventa: devoluciones, pedidos perdidos, reclamos

NO ESCALES por:
- Conversación normal de ventas aunque sea larga
- Cliente haciendo preguntas normales sobre productos
- Proceso de pedido en curso aunque tenga varios pasos
- Mensajes cortos o respuestas simples${negativeExamplesText}

Estado actual: ${pipelineState}

Responde SOLO con JSON: {"escalate": true/false, "reason": "una línea", "urgency": "low|medium|high"}`;

  const recent = conversationHistory.slice(-10)
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
