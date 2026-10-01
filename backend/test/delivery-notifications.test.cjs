const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function serviceWith({ lastInboundAt, providerResult = { messages: [{ id: 'wamid.1' }] }, providerError = null, assignment = null } = {}) {
  const saved = [];
  const db = {
    getPool: () => ({ query: async () => ({ rows: [{ id: 41, last_inbound_at: lastInboundAt }] }) }),
    getWhatsappConfig: async () => ({ provider: 'kapso', phone_number_id: 'phone-1', kapso_api_key: 'secret' }),
    getConversationById: async id => ({ id, phone_number: '56911112222', whatsapp_channel_id: null }),
    upsertConversation: async (_orgId, phone) => ({ id: 41, phone_number: phone, whatsapp_channel_id: null }),
    saveMessage: async value => { saved.push(value); return { id: 88, ...value }; },
    updateConversationLastMessage: async () => {},
  };
  let sends = 0;
  let templateSends = 0;
  const kapso = {
    sendTextMessage: async () => {
      sends++;
      if (providerError) throw providerError;
      return providerResult;
    },
    sendTemplate: async () => { templateSends++; return providerResult; },
  };
  const service = load('src/services/delivery-notifications.js', {
    '../db/database': db,
    './kapso-whatsapp': kapso,
    './whatsapp': { sendTextMessage: async () => {} },
    './twilio-whatsapp': { sendTextMessage: async () => {} },
    './evolution-whatsapp': { sendTextMessage: async () => {} },
    './whatsapp-provider': {
      configForConversation: async () => ({ provider: 'kapso', phone_number_id: 'phone-1', kapso_api_key: 'secret' }),
      messageId: result => result?.messages?.[0]?.id || null,
    },
    './template-automation': { getAssignment: async () => assignment },
  });
  return { service, saved, get sends() { return sends; }, get templateSends() { return templateSends; } };
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

test('con la ventana cerrada usa el template automático asignado sin intentar texto libre', async () => {
  const fixture = serviceWith({
    lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    assignment: { name: 'aviso_pedido_en_camino', language: 'es_CL', category: 'UTILITY' },
  });
  const result = await fixture.service.sendEnRouteNotification(3, {
    phone: '56911112222', customerName: 'Ana Díaz', orderName: '#43', fullAddress: 'Puerta del Mar 340',
  });
  assert.equal(result.via, 'template');
  assert.equal(result.templateName, 'aviso_pedido_en_camino');
  assert.equal(fixture.sends, 0);
  assert.equal(fixture.templateSends, 1);
  assert.match(fixture.saved[0].content, /Template: aviso_pedido_en_camino/);
});

test('si el proveedor informa que la ventana cerró, cambia al template asignado', async () => {
  const providerError = Object.assign(new Error('provider rejected'), { is24hWindow: true });
  const fixture = serviceWith({
    lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    providerError,
    assignment: { name: 'aviso_pedido_en_camino', language: 'es', category: 'UTILITY' },
  });
  const result = await fixture.service.sendEnRouteNotification(3, { phone: '56911112222', customerName: 'Ana' });
  assert.equal(result.via, 'template');
  assert.equal(fixture.templateSends, 1);
  assert.equal(fixture.saved.length, 1);
});

test('al editar un pedido avisa únicamente los datos que realmente cambiaron', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const result = await fixture.service.sendOrderEditNotification(3, {
    source: 'bot',
    id: 17,
    before: {
      customer_name: 'Katherine Bravo', customer_phone: '56911112222',
      items: JSON.stringify([{ name: '40 Jumbo', quantity: 1, price: 18000 }]),
      total_price: '18000', shipping_address: JSON.stringify({ address: 'Calle 1', city: 'Coquimbo' }),
    },
    after: {
      customer_name: 'Katherine Bravo', customer_phone: '56911112222',
      items: JSON.stringify([{ name: '100 Jumbo', quantity: 1, price: 37000 }]),
      total_price: '37000', shipping_address: JSON.stringify({ address: 'Calle 1', city: 'Coquimbo' }),
    },
  });
  assert.equal(result.sent, true);
  assert.equal(fixture.sends, 1);
  assert.match(result.text, /Katherine.*#BOT-17/s);
  assert.match(result.text, /1x 100 Jumbo/);
  assert.match(result.text, /Nuevo total: \$37\.000/);
  assert.doesNotMatch(result.text, /Dirección:/);
  assert.equal(fixture.saved[0].agentType, 'order_edit');
});

test('una edición sin cambios no envía y una ventana cerrada queda informada', async () => {
  const closed = serviceWith({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
  const order = {
    customer_name: 'Ana', customer_phone: '56911112222',
    items: [{ name: '30 XL', quantity: 1, price: 12000 }], total_price: '12000',
  };
  const unchanged = await closed.service.sendOrderEditNotification(3, { source: 'bot', id: 4, before: order, after: { ...order } });
  assert.equal(unchanged.reason, 'NO_CHANGES');
  const changed = await closed.service.sendOrderEditNotification(3, {
    source: 'bot', id: 4, before: order, after: { ...order, total_price: '13000' },
  });
  assert.equal(changed.sent, false);
  assert.equal(changed.reason, 'WINDOW_EXPIRED');
  assert.equal(closed.sends, 0);
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
    '../services/template-automation': { getAssignment: async () => null },
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
  const mediaSends = [];
  const outboundMedia = {
    send: async value => {
      mediaSends.push(value);
      return { message: { id: 3, direction: 'outbound', type: 'image', agent_type: value.agentType } };
    },
  };
  const router = load('src/routes/delivery.js', {
    '../db/database': database,
    '../services/delivery-notifications': notifications,
    '../services/whatsapp-provider': provider,
    '../services/outbound-media': outboundMedia,
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

  res = response();
  await handler(router, 'post', '/routes/5/stops/chat/media')({ ...base, body: { stopKey: 'bot_17', data: 'Zm90bw==', mimeType: 'image/jpeg', fileName: 'foto.jpg' } }, res);
  assert.equal(res.code, 200);
  assert.equal(mediaSends.length, 1);
  assert.equal(mediaSends[0].conversation.phone_number, '56911112222');
  assert.equal(mediaSends[0].agentType, 'driver:Pedro Ruta');

  res = response();
  await handler(router, 'post', '/routes/5/stops/chat/media')({ ...base, body: { stopKey: 'bot_99', data: 'Zm90bw==', mimeType: 'image/jpeg', fileName: 'foto.jpg' } }, res);
  assert.equal(res.code, 404);
  assert.equal(mediaSends.length, 1);
});
