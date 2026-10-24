const db = require('../db/database');
const guardrail = require('./response-guardrail');
const { notifyAdminHelp } = require('./notifications');

const STALE_ACK = 'Déjame revisar esto con el equipo para darte la información correcta y te escribo por aquí 🙏';
const HUMAN_ACK = 'Déjame consultarlo con el equipo y te confirmo por aquí 🙏';

/**
 * Aplica las mismas protecciones a toda respuesta del pipeline, independiente
 * del proveedor de WhatsApp o del proceso que originó el turno.
 */
async function evaluatePipelineResult({ orgId, conversationId, userMessage, result }) {
  if (!result?.response || result.skipped || result.duplicate) {
    return { escalate: false, result };
  }

  // Incluso una escalación puede contener una promesa sin orden persistida.
  {
    const fresh = await guardrail.checkResponseFreshness(orgId, conversationId, result.response, {
      userMessage,
      orderCreated: result.orderCreated,
      orderUpdated: result.orderUpdated,
      newState: result.newState,
    });
    if (!fresh.ok) {
      return {
        escalate: true,
        response: STALE_ACK,
        reason: `Dato desactualizado — ${fresh.detail || fresh.reason}`,
        botWasGoingToSay: result.response,
        code: 'stale_response',
      };
    }

    if (!result.switchToHuman && guardrail.promisesTeamFollowup(result.response)) {
      return {
        escalate: true,
        response: result.response,
        reason: result.escalationReason || 'El bot le dijo al cliente que consultaría algo con el equipo',
        botWasGoingToSay: result.response,
        code: 'team_followup_promise',
      };
    }
  }

  if (result.switchToHuman) {
    return {
      escalate: true,
      response: result.response || HUMAN_ACK,
      reason: result.escalationReason || 'Necesita validación del ejecutivo',
      botWasGoingToSay: result.response,
      code: 'switch_to_human',
    };
  }

  return { escalate: false, result };
}

async function coordinateConversation({ orgId, conversationId, conversation, userMessage, reason, botWasGoingToSay, io }) {
  await db.setAgentMode(conversationId, 'coordinating');
  if (typeof db.setLastEscalation === 'function') {
    await db.setLastEscalation(conversationId, userMessage, reason).catch(() => {});
  }
  io?.to(`org_${orgId}`).emit(`agent_mode_changed_${orgId}`, { conversationId, mode: 'coordinating' });
  await notifyAdminHelp(orgId, conversation, botWasGoingToSay, reason).catch(() => {});
}

module.exports = {
  evaluatePipelineResult,
  coordinateConversation,
  STALE_ACK,
  HUMAN_ACK,
};
