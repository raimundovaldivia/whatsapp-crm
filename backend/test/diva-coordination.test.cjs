const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const conversationMode = require('../src/services/conversation-mode');

test('Diva coordinates safely and never sends an ambiguous admin instruction', async () => {
  let systemPrompt = '';
  class Anthropic {
    constructor() {
      this.messages = { create: async input => {
        systemPrompt = input.system;
        throw new Error('invalid model response');
      } };
    }
  }
  const secretary = load('src/services/admin-secretary.js', {
    '../db/database': {
      getConversationById: async () => ({ contact_name: 'Ana' }),
      getLastMessages: async () => [{ direction: 'inbound', content: '¿Dónde viene mi pedido?' }],
    },
    '@anthropic-ai/sdk': Anthropic,
  });

  const result = await secretary.processAdminMessage(1, 'respóndele eso', {
    id: 5, conversation_id: 9, customer_phone: '56911111111',
  });

  assert.match(systemPrompt, /Tu nombre es Diva/);
  assert.equal(result.type, 'answer');
  assert.equal(result.customerMessage, '');
  assert.match(result.adminMessage, /interpretar la instrucción con seguridad/);
});

test('inactive coordinating and human chats return to Diva and pending coordination expires', async () => {
  const queries = [];
  const events = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('UPDATE conversations')) {
        return { rows: [
          { id: 11, organization_id: 2 },
          { id: 12, organization_id: 2 },
        ] };
      }
      return { rows: [], rowCount: 2 };
    },
  };
  const watcher = load('src/services/conversation-mode-watch.js', {
    '../db/database': { getPool: () => pool },
    './conversation-mode': conversationMode,
  });
  const io = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };

  const rows = await watcher.sweepConversationModes(io);

  assert.equal(rows.length, 2);
  assert.match(queries[0].sql, /agent_mode = 'human'/);
  assert.match(queries[0].sql, /INTERVAL '120 minutes'/);
  assert.match(queries[0].sql, /agent_mode = 'coordinating'/);
  assert.match(queries[0].sql, /INTERVAL '1440 minutes'/);
  assert.match(queries[0].sql, /m\.sent_by = 'human'/);
  assert.match(queries[1].sql, /admin_pending_replies SET status = 'expired'/);
  assert.deepEqual(events.map(event => event.payload.mode), ['ai', 'ai']);
});

test('un cliente que vuelve tras terminar el hilo reactiva a Diva en ese mismo mensaje', async () => {
  const now = new Date('2026-09-27T15:00:00Z').getTime();
  const staleHuman = {
    id: 7,
    agent_mode: 'human',
    agent_mode_changed_at: '2026-09-27T10:00:00Z',
    last_message_at: '2026-09-27T10:30:00Z',
  };
  const freshHuman = {
    ...staleHuman,
    agent_mode_changed_at: '2026-09-27T14:30:00Z',
  };
  const database = { minutesSinceLastHumanReply: async () => 300 };

  assert.equal(await conversationMode.shouldResumeDivaOnInbound(staleHuman, database, now), true);
  assert.equal(await conversationMode.shouldResumeDivaOnInbound(freshHuman, database, now), false);
});

test('coordinación pendiente conserva su ventana de 24 horas', async () => {
  const now = new Date('2026-09-27T15:00:00Z').getTime();
  const database = { minutesSinceLastHumanReply: async () => Infinity };
  const recent = {
    id: 8,
    agent_mode: 'coordinating',
    agent_mode_changed_at: '2026-09-27T14:00:00Z',
    last_message_at: '2026-09-27T14:00:00Z',
    last_escalation_at: '2026-09-27T14:00:00Z',
  };
  const stale = {
    ...recent,
    agent_mode_changed_at: '2026-09-26T10:00:00Z',
    last_message_at: '2026-09-26T10:00:00Z',
    last_escalation_at: '2026-09-26T10:00:00Z',
  };

  assert.equal(await conversationMode.shouldResumeDivaOnInbound(recent, database, now), false);
  assert.equal(await conversationMode.shouldResumeDivaOnInbound(stale, database, now), true);
});

test('un template automático reactiva a Diva para atender la respuesta', async () => {
  const changes = [];
  const database = {
    setAgentMode: async (id, mode) => changes.push({ id, mode }),
    clearLastEscalation: async id => changes.push({ cleared: id }),
  };

  await conversationMode.activateDivaForAutomatedMessage(19, database);

  assert.deepEqual(changes, [{ id: 19, mode: 'ai' }, { cleared: 19 }]);
});
