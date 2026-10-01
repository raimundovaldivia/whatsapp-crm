const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function serviceWith({ lastInboundAt, providerResult = { messages: [{ id: 'wamid.1' }] }, providerError = null } = {}) {
  const saved = [];
  const db = {
    getPool: () => ({ query: async () => ({ rows: [{ id: 41, last_inbound_at: lastInboundAt }] }) }),
    getWhatsappConfig: async () => ({ provider: 'kapso', phone_number_id: 'phone-1', kapso_api_key: 'secret' }),
    saveMessage: async value => { saved.push(value); return { id: 88, ...value }; },
    updateConversationLastMessage: async () => {},
  };
  let sends = 0;
  const kapso = {
    sendTextMessage: async () => {
      sends++;
      if (providerError) throw providerError;
      return providerResult;
    },
  };
  const service = load('src/services/delivery-notifications.js', {
    '../db/database': db,
    './kapso-whatsapp': kapso,
    './whatsapp': { sendTextMessage: async () => {} },
    './twilio-whatsapp': { sendTextMessage: async () => {} },
  });
  return { service, saved, get sends() { return sends; } };
}

test('la ventana se mide desde el último mensaje entrante y vence exactamente a las 24 horas', () => {
  const { windowInfoFromLastInbound } = serviceWith().service;
  const last = '2026-09-28T12:00:00.000Z';
  assert.equal(windowInfoFromLastInbound(last, new Date('2026-09-29T11:59:59.999Z')).available, true);
  const expired = windowInfoFromLastInbound(last, new Date('2026-09-29T12:00:00.000Z'));
  assert.equal(expired.available, false);
  assert.equal(expired.reason, 'WINDOW_EXPIRED');
});

test('Diva envía y registra el aviso como agente de despacho dentro de la ventana', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const result = await fixture.service.sendEnRouteNotification(3, {
    phone: '+56 9 1111 2222', customerName: 'Katherine Bravo', orderName: '#BOT-17',
  });
  assert.equal(result.sent, true);
  assert.equal(fixture.sends, 1);
  assert.equal(fixture.saved.length, 1);
  assert.equal(fixture.saved[0].sentBy, 'ai');
  assert.equal(fixture.saved[0].agentType, 'delivery');
  assert.match(fixture.saved[0].content, /Katherine.*#BOT-17.*en camino/s);
});

test('con la ventana cerrada no intenta enviar texto libre', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
  await assert.rejects(
    () => fixture.service.sendEnRouteNotification(3, { phone: '56911112222', customerName: 'Ana' }),
    error => error.status === 409 && error.code === 'WINDOW_EXPIRED'
  );
  assert.equal(fixture.sends, 0);
  assert.equal(fixture.saved.length, 0);
});

test('si el proveedor informa que la ventana cerró, devuelve un error controlado y no finge envío', async () => {
  const providerError = Object.assign(new Error('provider rejected'), { is24hWindow: true });
  const fixture = serviceWith({
    lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    providerError,
  });
  await assert.rejects(
    () => fixture.service.sendEnRouteNotification(3, { phone: '56911112222', customerName: 'Ana' }),
    error => error.status === 409 && error.code === 'WINDOW_EXPIRED'
  );
  assert.equal(fixture.saved.length, 0);
});

test('la API móvil valida ruta, asignación y pertenencia antes de consultar o enviar', async () => {
  const route = {
    id: 5,
    status: 'in_progress',
    orders: [{ source: 'bot', id: 17, phone: '56911112222', customerName: 'Katherine', orderName: '#BOT-17' }],
  };
  const pool = {
    query: async (_sql, params) => {
      const [routeId, orgId, driverId] = params;
      if (routeId === 5 && orgId === 3 && driverId === 9) return { rows: [route] };
      return { rows: [] };
    },
  };
  let sent = 0;
  const notifications = {
    getCustomerServiceWindow: async () => ({ available: true, conversationId: 41, expiresAt: '2026-09-29T12:00:00.000Z' }),
    sendEnRouteNotification: async () => { sent++; return { sent: true, text: 'va en camino', message: null, conversationId: 41 }; },
  };
  const router = load('src/routes/delivery.js', {
    '../db/database': { getPool: () => pool },
    '../services/delivery-notifications': notifications,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });

  const base = { orgId: 3, userId: 9, role: 'repartidor', params: { id: '5' } };
  let res = response();
  await handler(router, 'get', '/routes/5/en-route-status')({ ...base, query: { stopKey: 'bot_17' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.available, true);

  res = response();
  await handler(router, 'post', '/routes/5/notify-en-route')({ ...base, body: { stopKey: 'bot_17' } }, res);
  assert.equal(res.code, 200);
  assert.equal(sent, 1);

  res = response();
  await handler(router, 'post', '/routes/5/notify-en-route')({ ...base, body: { stopKey: 'bot_99' } }, res);
  assert.equal(res.code, 404);
  assert.equal(sent, 1);

  res = response();
  await handler(router, 'post', '/routes/6/notify-en-route')({ ...base, params: { id: '6' }, body: { stopKey: 'bot_17' } }, res);
  assert.equal(res.code, 404);
  assert.equal(sent, 1);
});

test('el chat del repartidor usa solo el cliente de su parada y registra quién respondió', async () => {
  const route = {
    id: 5,
    status: 'in_progress',
    orders: [{ source: 'bot', id: 17, phone: '56911112222', customerName: 'Katherine', orderName: '#BOT-17' }],
  };
  const pool = {
    query: async (_sql, params) => {
      if (params?.[0] === 5 && params?.[1] === 3 && params?.[2] === 9) return { rows: [route] };
      return { rows: [] };
    },
  };
  const conversation = { id: 41, phone_number: '56911112222', whatsapp_channel_id: 2 };
  const saved = [];
  let sentTo = null;
  const database = {
    getPool: () => pool,
    getConversationById: async id => id === 41 ? conversation : null,
    getMessagesByConversation: async () => [{ id: 1, direction: 'inbound', content: '¿A qué hora llega?' }],
    upsertConversation: async () => conversation,
    getUserById: async () => ({ id: 9, name: 'Pedro Ruta' }),
    saveMessage: async value => { saved.push(value); return { id: 2, ...value }; },
    updateConversationLastMessage: async () => {},
    setAgentMode: async () => {},
  };
  const notifications = {
    getCustomerServiceWindow: async () => ({ available: true, conversationId: 41 }),
  };
  const provider = {
    configForConversation: async () => ({ id: 2, provider: 'kapso' }),
    sendTextMessage: async (phone) => { sentTo = phone; return { messages: [{ id: 'wamid.driver' }] }; },
    messageId: result => result.messages[0].id,
  };
  const router = load('src/routes/delivery.js', {
    '../db/database': database,
    '../services/delivery-notifications': notifications,
    '../services/whatsapp-provider': provider,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const base = { orgId: 3, userId: 9, role: 'repartidor', params: { id: '5' } };

  let res = response();
  await handler(router, 'get', '/routes/5/stops/chat')({ ...base, query: { stopKey: 'bot_17' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.messages[0].content, '¿A qué hora llega?');

  res = response();
  await handler(router, 'post', '/routes/5/stops/chat')({ ...base, body: { stopKey: 'bot_17', text: 'Llego en 15 minutos.' } }, res);
  assert.equal(res.code, 200);
  assert.equal(sentTo, '56911112222');
  assert.equal(saved[0].sentBy, 'human');
  assert.equal(saved[0].agentType, 'driver:Pedro Ruta');

  res = response();
  await handler(router, 'post', '/routes/5/stops/chat')({ ...base, body: { stopKey: 'bot_99', text: 'No debe salir' } }, res);
  assert.equal(res.code, 404);
  assert.equal(saved.length, 1);
});
