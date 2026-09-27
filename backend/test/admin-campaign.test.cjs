const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const templateRenderer = require('../src/utils/template-renderer.mjs');

test('admin campaign uses live templates and requires exact confirmation before sending', async () => {
  const adminReplies = [];
  const templateSends = [];
  const savedMessages = [];
  const pool = {
    query: async sql => {
      if (sql.includes('FROM contacts c')) {
        return { rows: [{ phone: '56911111111', name: 'Ana Pérez' }] };
      }
      if (sql.includes('UPDATE contacts')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const db = {
    normalizePhone: value => String(value || '').replace(/\D/g, ''),
    getPool: () => pool,
    upsertConversation: async () => ({ id: 7 }),
    saveMessage: async message => { savedMessages.push(message); return message; },
    updateConversationLastMessage: async () => {},
    updatePipelineState: async () => {},
  };
  const kapso = {
    getTemplates: async () => [{
      name: 'promo_huevos', language: 'es', status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Hola {{1}}, tenemos una promoción.' }],
    }],
    sendTextMessage: async (_phone, text) => {
      adminReplies.push(text);
      return { messages: [{ id: `admin-${adminReplies.length}` }] };
    },
    sendTemplate: async (phone, name, language, components) => {
      templateSends.push({ phone, name, language, components });
      return { messages: [{ id: 'wamid.campaign' }] };
    },
  };
  class Anthropic {
    constructor() { this.messages = { create: async () => { throw new Error('AI must not decide campaign sends'); } }; }
  }
  const service = load('src/services/agent-commands.js', {
    '../db/database': db,
    './kapso-whatsapp': kapso,
    './commercial': { assertModule: async () => true },
    '../utils/template-renderer.mjs': templateRenderer,
    '@anthropic-ai/sdk': Anthropic,
  });
  const org = { id: 1 };
  const wc = { provider: 'kapso' };
  const agent = { id: 2, role: 'owner', name: 'Rai', whatsapp_phone: '56999999999' };

  await service.handleAgentCommand(org, wc, agent, 'qué templates tienes disponibles');
  assert.match(adminReplies.at(-1), /Diva/);
  assert.match(adminReplies.at(-1), /promo_huevos/);

  await service.handleAgentCommand(org, wc, agent, '1');
  assert.match(adminReplies.at(-1), /\{nombre\}/);

  await service.handleAgentCommand(org, wc, agent, '{nombre}');
  assert.match(adminReplies.at(-1), /todos los clientes/i);

  await service.handleAgentCommand(org, wc, agent, 'todos los clientes');
  assert.match(adminReplies.at(-1), /Todavía no se envió nada/);
  assert.match(adminReplies.at(-1), /Ana/);

  await service.handleAgentCommand(org, wc, agent, 'sí, envíalo');
  assert.equal(templateSends.length, 0);
  assert.match(adminReplies.at(-1), /CONFIRMAR ENVÍO/);

  await service.handleAgentCommand(org, wc, agent, 'CONFIRMAR ENVÍO');
  assert.equal(templateSends.length, 1);
  assert.equal(templateSends[0].components[0].parameters[0].text, 'Ana');
  assert.equal(savedMessages[0].status, 'pending');
  assert.equal(savedMessages[0].whatsappMessageId, 'wamid.campaign');
  assert.match(adminReplies.at(-1), /pendientes de confirmación de entrega/);
});
