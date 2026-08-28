/**
 * bot-logger.js — Logger estructurado para el pipeline del bot
 *
 * Genera un traceId por mensaje para correlacionar todos los logs.
 * Uso:
 *   const log = createBotLogger(org.name, phone);
 *   log.in('hola quiero pedir');
 *   log.step('contexto', 'productos: 12, historial: 3 compras');
 *   log.intent('wants_to_order', 92, 45);
 *   log.agent('sales', 1200);
 *   log.out('¡Claro! ¿Qué producto te interesa?', totalMs);
 *   log.error('pipeline', err);
 */

function shortId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function ms(start) {
  return `${Date.now() - start}ms`;
}

function createBotLogger(orgName, phone) {
  const id    = shortId();
  const tag   = `[BOT:${id}]`;
  const short = phone ? phone.slice(-6) : '??????';
  const t0    = Date.now();

  return {
    id,
    t0,

    // Mensaje entrante
    in(text) {
      console.log(`\n${tag} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`${tag} 📩 ENTRADA  | org: ${orgName} | +${short}`);
      console.log(`${tag}    "${text?.slice(0, 100)}${(text?.length || 0) > 100 ? '…' : ''}"`);
    },

    // Paso genérico del pipeline
    step(label, detail) {
      console.log(`${tag} ⚙️  ${label.padEnd(14)} ${detail}`);
    },

    // Contexto cargado
    context({ products, history, agentMode, state }) {
      const modeIcon = agentMode === 'ai' ? '🤖' : '👤';
      console.log(`${tag} 📦 contexto      | ${products} productos | historial: ${history} compras | modo: ${modeIcon} ${agentMode} | estado: ${state}`);
    },

    // Resultado del orquestador
    intent(intent, confidence, elapsedMs) {
      const icon = confidence >= 80 ? '🎯' : confidence >= 60 ? '🟡' : '🔵';
      console.log(`${tag} ${icon} intent         | ${intent} (${confidence}%) [${elapsedMs}ms]`);
    },

    // Escalación
    escalation(escalate, urgency, reason) {
      if (escalate) {
        console.log(`${tag} 🚨 ESCALACIÓN    | urgencia: ${urgency} — ${reason}`);
      } else {
        console.log(`${tag} ✅ sin escalación`);
      }
    },

    // Agente ejecutado
    agent(name, elapsedMs) {
      const icon = name === 'sales' ? '💼' : name === 'orders' ? '📋' : name === 'orchestrator' ? '🎛️' : '🤖';
      console.log(`${tag} ${icon} agente          | ${name} [${elapsedMs}ms]`);
    },

    // Respuesta generada (antes de enviar)
    response(text, elapsedMs) {
      const preview = text?.slice(0, 80) + ((text?.length || 0) > 80 ? '…' : '');
      console.log(`${tag} 💬 respuesta     | ${text?.length || 0} chars [${elapsedMs}ms]`);
      console.log(`${tag}    "${preview}"`);
    },

    // Mensaje enviado con éxito
    sent(elapsedMs) {
      console.log(`${tag} ✅ ENVIADO       | Kapso [${elapsedMs}ms]`);
    },

    // Ventana 24h expirada
    windowExpired(phone) {
      console.log(`${tag} ⏰ WINDOW 24H    | respuesta bloqueada para ${phone}`);
    },

    // Modo humano activo
    humanMode(mins) {
      console.log(`${tag} 👤 MODO HUMANO   | sin respuesta IA (último humano hace ${Math.round(mins)}min)`);
    },

    // Auto-reset a IA
    autoReset(mins) {
      console.log(`${tag} 🔄 AUTO-RESET IA | sin respuesta humana en ${Math.round(mins)}min`);
    },

    // Error en cualquier paso
    error(step, err) {
      console.error(`${tag} ❌ ERROR en ${step}`);
      console.error(`${tag}    ${err?.message || err}`);
      if (err?.stack) {
        const firstLine = err.stack.split('\n')[1]?.trim() || '';
        console.error(`${tag}    ${firstLine}`);
      }
    },

    // Cierre del trace con tiempo total
    done() {
      const total = Date.now() - t0;
      console.log(`${tag} ⏱  TOTAL: ${total}ms`);
      console.log(`${tag} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    },
  };
}

module.exports = { createBotLogger };
