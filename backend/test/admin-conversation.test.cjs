const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('Diva conserva el contexto entre preguntas consecutivas del administrador', async () => {
  const calls = [];
  const replies = [];
  class Anthropic {
    constructor() {
      this.messages = { create: async input => {
        calls.push(input);
        return { content: [{ text: JSON.stringify({ action: 'answer', text: calls.length === 1 ? 'Revisemos ese cliente.' : 'El siguiente paso es confirmar el pedido.' }) }] };
      } };
    }
  }
  const service = load('src/services/agent-commands.js', {
    '../db/database': { normalizePhone: value => String(value || '').replace(/\D/g, '') },
    './kapso-whatsapp': { sendTextMessage: async (_phone, text) => replies.push(text) },
    '@anthropic-ai/sdk': Anthropic,
  });
  const org = { id: 4 };
  const wc = {};
  const agent = { id: 8, role: 'owner', whatsapp_phone: '56911111111' };

  await service.handleAgentCommand(org, wc, agent, 'Necesito revisar el caso de Carolina');
  await service.handleAgentCommand(org, wc, agent, '¿Y qué hago ahora con ella?');

  assert.equal(replies.length, 2);
  assert.equal(calls[1].messages.length, 3);
  assert.equal(calls[1].messages[0].content, 'Necesito revisar el caso de Carolina');
  assert.match(calls[1].messages[1].content, /Revisemos ese cliente/);
  assert.equal(calls[1].messages[2].content, '¿Y qué hago ahora con ella?');
  assert.match(calls[1].system, /una pregunta concreta/i);
});
