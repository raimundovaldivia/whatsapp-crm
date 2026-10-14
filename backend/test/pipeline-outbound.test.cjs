const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('convierte una promesa al equipo en una escalación real', async () => {
  const service = load('src/services/pipeline-outbound.js', {
    '../db/database': {},
    './response-guardrail': {
      checkResponseFreshness: async () => ({ ok: true }),
      promisesTeamFollowup: () => true,
    },
    './notifications': { notifyAdminHelp: async () => {} },
  });
  const decision = await service.evaluatePipelineResult({
    orgId: 1,
    conversationId: 2,
    userMessage: '¿Dónde está mi pedido?',
    result: { response: 'Lo consulto con el equipo y te confirmo.', agentType: 'sales' },
  });
  assert.equal(decision.escalate, true);
  assert.equal(decision.code, 'team_followup_promise');
});

test('coordinar persiste el estado, la causa y avisa al equipo', async () => {
  const calls = [];
  const emitted = [];
  const service = load('src/services/pipeline-outbound.js', {
    '../db/database': {
      setAgentMode: async (...args) => calls.push(['mode', ...args]),
      setLastEscalation: async (...args) => calls.push(['escalation', ...args]),
    },
    './response-guardrail': {},
    './notifications': { notifyAdminHelp: async (...args) => calls.push(['notify', ...args]) },
  });
  await service.coordinateConversation({
    orgId: 3,
    conversationId: 4,
    conversation: { id: 4, phone_number: '56911111111' },
    userMessage: 'Llámeme',
    reason: 'Cliente pide llamada',
    botWasGoingToSay: 'Te llamarán',
    io: { to: () => ({ emit: (...args) => emitted.push(args) }) },
  });
  assert.deepEqual(calls[0], ['mode', 4, 'coordinating']);
  assert.deepEqual(calls[1], ['escalation', 4, 'Llámeme', 'Cliente pide llamada']);
  assert.equal(calls[2][0], 'notify');
  assert.equal(emitted[0][0], 'agent_mode_changed_3');
});
