const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

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
  });
  const io = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };

  const rows = await watcher.sweepConversationModes(io);

  assert.equal(rows.length, 2);
  assert.match(queries[0].sql, /agent_mode IN \('coordinating','human'\)/);
  assert.match(queries[0].sql, /INTERVAL '24 hours'/);
  assert.match(queries[1].sql, /admin_pending_replies SET status = 'expired'/);
  assert.deepEqual(events.map(event => event.payload.mode), ['ai', 'ai']);
});
