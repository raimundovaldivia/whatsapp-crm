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

module.exports = { classifyIntent };
