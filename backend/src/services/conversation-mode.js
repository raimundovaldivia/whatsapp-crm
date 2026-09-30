const HUMAN_IDLE_MINUTES = 120;
const COORDINATION_IDLE_MINUTES = 24 * 60;

function minutesSince(value, now = Date.now()) {
  if (!value) return Infinity;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.max(0, (now - time) / 60000) : Infinity;
}

/**
 * Decide si un mensaje entrante inicia un hilo nuevo y Diva debe retomarlo.
 * Se recibe la conversación tal como estaba ANTES de guardar el nuevo mensaje,
 * para que ese mensaje no prolongue artificialmente el modo humano.
 */
async function shouldResumeDivaOnInbound(conversation, database, now = Date.now()) {
  const mode = conversation?.agent_mode || 'ai';
  if (mode === 'ai') return false;

  const ages = [
    minutesSince(conversation.agent_mode_changed_at, now),
    minutesSince(conversation.last_message_at, now),
  ];

  if (mode === 'human') {
    const lastHumanMinutes = await database.minutesSinceLastHumanReply(conversation.id);
    if (Number.isFinite(lastHumanMinutes)) ages.push(lastHumanMinutes);
  } else if (mode === 'coordinating') {
    ages.push(minutesSince(conversation.last_escalation_at, now));
  }

  const mostRecentActivityMinutes = Math.min(...ages);
  const threshold = mode === 'human' ? HUMAN_IDLE_MINUTES : COORDINATION_IDLE_MINUTES;
  return mostRecentActivityMinutes >= threshold;
}

async function resumeDivaOnInbound(conversation, database, now = Date.now()) {
  if (!await shouldResumeDivaOnInbound(conversation, database, now)) return false;
  await database.setAgentMode(conversation.id, 'ai');
  if (typeof database.clearLastEscalation === 'function') {
    await database.clearLastEscalation(conversation.id).catch(() => {});
  }
  return true;
}

async function activateDivaForAutomatedMessage(conversationId, database) {
  await database.setAgentMode(conversationId, 'ai');
  if (typeof database.clearLastEscalation === 'function') {
    await database.clearLastEscalation(conversationId).catch(() => {});
  }
}

/**
 * Cuando una persona responde al cliente, conserva el hilo en modo humano.
 * El cliente suele contestar con una aclaración inmediatamente después y Diva
 * no debe interrumpir ni volver a escalar una conversación ya atendida.
 */
async function keepHumanAfterReply(conversationId, database) {
  await database.setAgentMode(conversationId, 'human');
  if (typeof database.clearLastEscalation === 'function') {
    await database.clearLastEscalation(conversationId).catch(() => {});
  }
}

module.exports = {
  HUMAN_IDLE_MINUTES,
  COORDINATION_IDLE_MINUTES,
  minutesSince,
  shouldResumeDivaOnInbound,
  resumeDivaOnInbound,
  activateDivaForAutomatedMessage,
  keepHumanAfterReply,
};
