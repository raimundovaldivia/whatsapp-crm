const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const conversationMode = require('../src/services/conversation-mode');

test('saludos simples y combinados nunca activan una escalación por el historial anterior', async () => {
  class Anthropic {
    constructor() {
      this.messages = { create: async () => { throw new Error('no debe consultar IA para un saludo'); } };
    }
  }
  const orchestrator = load('src/services/agents/orchestrator.js', {
    '@anthropic-ai/sdk': Anthropic,
  });
  const oldBillingContext = [
    { direction: 'inbound', content: 'Hay una factura duplicada' },
    { direction: 'outbound', content: 'Lo revisa el equipo' },
    { direction: 'inbound', content: 'Gracias' },
    { direction: 'outbound', content: 'Que tengas buen día' },
    { direction: 'inbound', content: 'Envié los respaldos' },
    { direction: 'outbound', content: 'Los revisaremos' },
    { direction: 'inbound', content: 'Ok' },
    { direction: 'outbound', content: 'Quedó pendiente' },
  ];

  for (const greeting of ['Buen dia', 'Buen día', 'Buenos días', 'Hola\nBuen dia', 'Hola, buenos días 👋']) {
    const result = await orchestrator.checkEscalation(greeting, oldBillingContext, 'idle', 1);
    assert.equal(result.escalate, false, greeting);
    assert.equal(result.reason, 'Mensaje simple', greeting);
  }
});

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
    id: 5,
    conversation_id: 9,
    customer_phone: '56911111111',
    context: 'Recomendación: disculparse y no volver a insistir.',
  });

  assert.match(systemPrompt, /Tu nombre es Diva/);
  assert.match(systemPrompt, /disculparse y no volver a insistir/);
  assert.equal(result.type, 'answer');
  assert.equal(result.customerMessage, '');
  assert.match(result.adminMessage, /interpretar la instrucción con seguridad/);
});

test('Diva refresca la conversación del cliente durante una coordinación activa', async () => {
  const prompts = [];
  let reads = 0;
  class Anthropic {
    constructor() {
      this.messages = { create: async input => {
        prompts.push(input.system);
        return { content: [{ text: JSON.stringify({ type: 'answer', adminMessage: 'Entendido.', customerMessage: '' }) }] };
      } };
    }
  }
  const secretary = load('src/services/admin-secretary.js', {
    '../db/database': {
      getConversationById: async () => ({ contact_name: 'Carolina' }),
      getLastMessages: async () => {
        reads++;
        return reads < 3
          ? [{ direction: 'inbound', content: '¿A qué hora llega?' }]
          : [{ direction: 'inbound', content: 'Ya no necesito cambiar la hora, gracias.' }];
      },
    },
    '@anthropic-ai/sdk': Anthropic,
  });
  const pending = { id: 12, conversation_id: 44, customer_phone: '56922222222' };

  await secretary.processAdminMessage(77, '¿Qué necesita?', pending);
  await secretary.processAdminMessage(77, '¿Y ahora?', pending);

  assert.match(prompts[1], /Ya no necesito cambiar la hora/);
  assert.doesNotMatch(prompts[1], /Cliente: ¿A qué hora llega\?/);
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

test('una respuesta humana conserva el hilo en modo humano para el siguiente mensaje', async () => {
  const changes = [];
  const database = {
    setAgentMode: async (id, mode) => changes.push({ id, mode }),
    clearLastEscalation: async id => changes.push({ cleared: id }),
  };

  await conversationMode.keepHumanAfterReply(23, database);

  assert.deepEqual(changes, [{ id: 23, mode: 'human' }, { cleared: 23 }]);
});

test('Diva avisa una respuesta pendiente en modo humano sin duplicar mensajes seguidos', async () => {
  const pending = [];
  const alerts = [];
  let canNotify = true;
  const notifications = load('src/services/notifications.js', {
    '../db/database': {
      claimHumanPendingNotification: async () => {
        const result = canNotify;
        canNotify = false;
        return result;
      },
      createAdminPendingReply: async (...args) => pending.push(args),
    },
    './kapso-whatsapp': {},
    './admin-notify': {
      notifyAdmin: async (orgId, options) => {
        alerts.push({ orgId, ...options });
        return { sent: true, queued: false };
      },
    },
  });
  const conversation = {
    id: 31,
    agent_mode: 'human',
    contact_name: 'José Pozo',
    phone_number: '56995979357',
  };

  await notifications.notifyAdminHumanPendingReply(4, conversation, 'Hola, quiero 2 bandejas jumbo');
  await notifications.notifyAdminHumanPendingReply(4, conversation, '¿Me confirma?');

  assert.equal(alerts.length, 1);
  assert.equal(pending.length, 1);
  assert.match(alerts[0].body, /José Pozo/);
  assert.match(alerts[0].body, /2 bandejas jumbo/);
  assert.match(alerts[0].body, /modo humano/i);
});

test('la consulta al administrador incluye la conversación y explica qué decisión necesita', async () => {
  const alerts = [];
  const pending = [];
  const notifications = load('src/services/notifications.js', {
    '../db/database': {
      getSetting: async () => '56990000000',
      getWhatsappConfig: async () => ({ provider: 'kapso' }),
      getLastMessages: async () => [
        { direction: 'outbound', sent_by: 'ai', content: '¿Ya llegaste a La Serena?' },
        { direction: 'inbound', sent_by: 'client', content: '😵‍💫😵‍💫😵‍💫' },
      ],
      getLatestPendingAdminReply: async () => null,
      createAdminPendingReply: async (...args) => pending.push(args),
    },
    './kapso-whatsapp': {},
    './admin-notify': {
      notifyAdmin: async (orgId, options) => {
        alerts.push({ orgId, ...options });
        return { sent: true };
      },
    },
  });

  await notifications.notifyAdminHelp(
    1,
    { id: 9, contact_name: 'Karina', phone_number: '56977101282' },
    'Esto lo tiene que ver alguien del equipo.',
    'La clienta mostró frustración porque no se respetó lo acordado.'
  );

  assert.equal(alerts.length, 1);
  assert.equal(pending.length, 1);
  assert.match(alerts[0].body, /Diva: ¿Ya llegaste a La Serena\?/);
  assert.match(alerts[0].body, /Cliente: 😵‍💫😵‍💫😵‍💫/);
  assert.match(alerts[0].body, /Qué necesito de ti/);
  assert.doesNotMatch(alerts[0].body, /preguntarme.*contexto/i);
  assert.match(alerts[0].body, /#msg 56977101282/);
});

test('el administrador no recibe duplicado el aviso de pago si también es agente', async () => {
  const recipients = [];
  const notifications = load('src/services/notifications.js', {
    '../db/database': {
      getWhatsappConfig: async () => ({ provider: 'kapso' }),
      getSetting: async () => '+56 9 1111 1111',
      getAgentsWithNotification: async () => [
        { whatsapp_phone: '56911111111' },
        { whatsapp_phone: '56922222222' },
      ],
    },
    './kapso-whatsapp': {
      sendTextMessage: async phone => recipients.push(phone),
    },
    './admin-notify': { notifyAdmin: async () => ({ sent: true }) },
  });

  await notifications.notifyAgentsPayment(1, 'Gloria', '56983721996', '$40.000 CLP');

  assert.deepEqual(recipients, ['56922222222']);
});

test('Diva analiza el historial y entrega una conclusión en vez de copiar toda la conversación', async () => {
  class Anthropic {
    constructor() {
      this.messages = { create: async () => ({
        content: [{ text: JSON.stringify({
          situation: 'Karina había pedido esperar hasta la próxima semana, pero Diva volvió a contactarla antes de tiempo. El equipo ya se disculpó y ella respondió con emojis de risa.',
          customerNeed: 'No está haciendo una nueva consulta; su último mensaje parece distender la situación.',
          recommendation: 'Cerrar con amabilidad y no volver a contactarla hasta que ella escriba.',
          evidence: ['Cliente: Hola, no llego hasta la próxima semana.', 'Cliente: 🤭🤭🤭'],
        }) }],
      }) };
    }
  }
  const alerts = [];
  const notifications = load('src/services/notifications.js', {
    '../db/database': {
      claimHumanPendingNotification: async () => true,
      getLastMessages: async () => [
        { direction: 'inbound', content: 'Hola, no llego hasta la próxima semana.' },
        { direction: 'outbound', sent_by: 'ai', content: '¿Ya llegaste a La Serena?' },
        { direction: 'outbound', sent_by: 'human', content: 'Mil disculpas por la desconfiguración.' },
        { direction: 'inbound', content: '🤭🤭🤭' },
      ],
      createAdminPendingReply: async () => {},
    },
    '@anthropic-ai/sdk': Anthropic,
    './kapso-whatsapp': {},
    './admin-notify': {
      notifyAdmin: async (_orgId, options) => {
        alerts.push(options.body);
        return { sent: true };
      },
    },
  }, {
    process: { env: { ANTHROPIC_API_KEY: 'test-key' } },
  });

  await notifications.notifyAdminHumanPendingReply(1, {
    id: 55,
    agent_mode: 'human',
    contact_name: 'Karina',
    phone_number: '56977101282',
  }, '¿Me confirman qué harán entonces?');

  assert.match(alerts[0], /Karina había pedido esperar hasta la próxima semana/);
  assert.match(alerts[0], /Cerrar con amabilidad y no volver a contactarla/);
  assert.doesNotMatch(alerts[0], /Contexto reciente/);
});

test('Diva no molesta al administrador por agradecimientos o cierres en modo humano', async () => {
  let claims = 0;
  let alerts = 0;
  const notifications = load('src/services/notifications.js', {
    '../db/database': {
      claimHumanPendingNotification: async () => { claims++; return true; },
    },
    './kapso-whatsapp': {},
    './admin-notify': { notifyAdmin: async () => { alerts++; } },
  });
  const conversation = { id: 88, agent_mode: 'human', contact_name: 'María', phone_number: '56911111111' };

  const thanks = await notifications.notifyAdminHumanPendingReply(1, conversation, 'Mil gracias 🙏');
  const emoji = await notifications.notifyAdminHumanPendingReply(1, conversation, '😊😊');

  assert.equal(thanks.reason, 'sin_accion');
  assert.equal(emoji.reason, 'sin_accion');
  assert.equal(claims, 0);
  assert.equal(alerts, 0);
});

test('el aviso general no duplica el caso que ya está en coordinación humana', async () => {
  let lookups = 0;
  let sends = 0;
  const notifications = load('src/services/notifications.js', {
    '../db/database': {
      getWhatsappConfig: async () => ({ provider: 'kapso' }),
      getAgentsWithNotification: async () => { lookups++; return [{ whatsapp_phone: '56911111111' }]; },
    },
    './kapso-whatsapp': { sendTextMessage: async () => { sends++; } },
    './admin-notify': { notifyAdmin: async () => ({ sent: true }) },
  });

  await notifications.notifyAgentsNewMessage(1, { id: 4, agent_mode: 'human' }, 'Necesito ayuda');
  assert.equal(lookups, 0);
  assert.equal(sends, 0);
});
