const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function serviceWith({
  lastInboundAt,
  providerResult = { messages: [{ id: 'wamid.1' }] },
  providerError = null,
  assignment = null,
  provider = 'kapso',
  whatsappChannelId = null,
  organizationSlug = null,
  aiReply = null,
  evolutionStatus = 'connected',
  failEvolution = false,
  recent = [],
} = {}) {
  const saved = [];
  const providerConfig = { id: whatsappChannelId, provider, phone_number_id: 'phone-1', kapso_api_key: 'secret' };
  let evolutionLookups = 0;
  const prompts = [];
  const threads = [];
  const db = {
    normalizePhone: phone => phone.replace(/\D/g, ''),
    getPool: () => ({ query: async sql => ({ rows: sql.includes('SELECT content FROM messages') ? recent : [{ id: 41, whatsapp_channel_id: whatsappChannelId, last_inbound_at: lastInboundAt }] }) }),
    getOrgById: async () => ({ slug: organizationSlug }),
    getWhatsappConfig: async () => providerConfig,
    getWhatsappChannel: async () => providerConfig,
    getEvolutionWhatsappChannel: async () => { evolutionLookups++; return { id: 99, provider: 'evolution', status: evolutionStatus }; },
    getConversationById: async id => ({ id, phone_number: '56911112222', whatsapp_channel_id: whatsappChannelId }),
    upsertConversation: async (_orgId, phone, _name, channelId) => { threads.push(channelId); return { id: 61, phone_number: phone, whatsapp_channel_id: channelId }; },
    saveMessage: async value => { saved.push(value); return { id: 88, ...value }; },
    updateConversationLastMessage: async () => {},
  };
  let sends = 0;
  const evolutionTexts = [];
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
    './evolution-whatsapp': { sendTextMessage: async (_phone, text) => { if (failEvolution) throw new Error('Evolution fuera de servicio'); evolutionTexts.push(text); return { messageId: 'evo.1' }; } },
    './whatsapp-provider': {
      configForConversation: async () => ({ provider: 'kapso', phone_number_id: 'phone-1', kapso_api_key: 'secret' }),
      messageId: result => result?.messages?.[0]?.id || null,
    },
    './ai-provider': {
      modelFor: () => 'modelo-prueba',
      client: { messages: { create: async request => {
        const prompt = request.messages[0].content;
        prompts.push(prompt);
        return aiReply ? aiReply(prompt, prompts.length) : 'Escríbenos por tu pedido.';
      } } },
      responseText: result => result,
    },
    './template-automation': { getAssignment: async () => assignment },
  });
  return {
    service,
    saved,
    get sends() { return sends; },
    evolutionTexts, prompts, threads,
    get evolutionSends() { return evolutionTexts.length; },
    get evolutionLookups() { return evolutionLookups; },
    get templateSends() { return templateSends; },
  };
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
  assert.match(fixture.saved[0].content, /Katherine.*#DR-17.*en camino/s);
});

test('al consolidar la carga avisa que el pedido quedó con el repartidor y conserva el chat', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const result = await fixture.service.sendLoadConsolidatedNotification(3, {
    phone: '+56 9 1111 2222', customerName: 'Karen Soto', orderName: '#BOT-25',
  });
  assert.equal(result.sent, true);
  assert.equal(fixture.sends, 1);
  assert.equal(fixture.saved[0].agentType, 'delivery_consolidated');
  assert.match(fixture.saved[0].content, /Karen.*consolidado.*manos del repartidor/s);
});

test('cada aviso de Diez Ríos usa la IA y el hilo comercial Evolution, incluso si el chat era de Kapso', async () => {
  const fixture = serviceWith({ organizationSlug: 'diez-rios-mrs96z69', whatsappChannelId: 8,
    aiReply: (_prompt, count) => count === 1 ? 'NOMBRE, el repartidor tiene tu pedido PEDIDO. Escríbenos por aquí.' : 'Hola, NOMBRE. Ya llevamos tu pedido PEDIDO.' });
  const stop = { phone: '56911112222', customerName: 'Marcela Soto', orderName: '#BOT-828', trackingUrl: 'https://example.test/seguimiento/privado' };
  for (const method of ['sendLoadConsolidatedNotification', 'sendEnRouteNotification']) {
    const result = await fixture.service[method](3, stop);
    assert.equal(result.provider, 'evolution');
    assert.equal(result.conversationId, 61);
    assert.equal(result.text, fixture.evolutionTexts.at(-1));
    assert.equal(result.text, fixture.saved.at(-1).content);
    assert.ok(result.text.includes('Marcela') && result.text.includes('#DR-828') && result.text.endsWith(stop.trackingUrl));
  }
  assert.equal(fixture.prompts.length, 2);
  assert.doesNotMatch(fixture.prompts.join(' '), /Marcela|828|privado|56911112222/);
  assert.notEqual(fixture.evolutionTexts[0], fixture.evolutionTexts[1]);
  assert.deepEqual(fixture.threads, [99, 99]);
  assert.equal(fixture.sends + fixture.templateSends, 0);
});

test('si la IA repite un aviso reciente del mismo cliente se pide otra redacción antes del envío', async () => {
  const fixture = serviceWith({ organizationSlug: 'diez-rios-mrs96z69',
    recent: [{ content: 'Ya tiene tu pedido #DR-4 el repartidor.' }],
    aiReply: (_prompt, count) => count === 1 ? 'Ya tiene tu pedido PEDIDO el repartidor.' : 'El repartidor recibió tu pedido PEDIDO. Escríbenos por aquí.' });
  const result = await fixture.service.sendLoadConsolidatedNotification(3, { phone: '56911112222', orderName: '#DR-828' });
  assert.equal(fixture.prompts.length, 2);
  assert.equal(fixture.evolutionSends, 1);
  assert.match(result.text, /El repartidor recibió tu pedido #DR-828/);
});

test('las incidencias, la encuesta y los cambios de pedido también se redactan por evento', async () => {
  const fixture = serviceWith({ organizationSlug: 'diez-rios-mrs96z69', aiReply: prompt => {
    const keys = prompt.match(/Marcadores disponibles: ([^\n]+)/)[1];
    return 'Hola. ' + keys.split(', ').join(' ');
  } });
  const stop = { phone: '56911112222', customerName: 'Ana', orderName: '#DR-19' };
  const postponed = await fixture.service.sendDeliveryOutcomeRecovery(3, stop, { status: 'postponed', deliveryDate: '2026-12-02' });
  assert.ok(postponed.text.includes('02-12-2026'));
  const survey = await fixture.service.sendCustomerFeedbackRequest(3, stop);
  assert.ok(survey.text.includes('1 al 5'));
  const edit = await fixture.service.sendOrderEditNotification(3, { id: 19, before: {total_price: 1000}, after: {total_price: 2000, customer_phone: stop.phone} });
  assert.match(edit.text, /Nuevo total: \$2.000/);
  assert.equal(fixture.evolutionSends, 3);
});

test('un fallo de IA o Evolution no produce envíos por otro canal ni un éxito falso', async () => {
  for (const options of [{ aiReply: () => 'Un texto con un enlace inventado https://example.test' }, { evolutionStatus: 'disconnected' }, { aiReply: () => 'Tu pedido PEDIDO va en camino.', failEvolution: true }]) {
    const fixture = serviceWith({ organizationSlug: 'diez-rios-mrs96z69', ...options });
    await assert.rejects(fixture.service.sendEnRouteNotification(3, { phone: '56911112222', orderName: '#DR-8' }));
    assert.equal(fixture.evolutionSends + fixture.sends + fixture.templateSends, 0);
    assert.equal(fixture.saved.length, 0);
  }
});

test('el aviso de salida incluye el enlace temporal de seguimiento', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const result = await fixture.service.sendLoadConsolidatedNotification(3, {
    phone: '+56 9 1111 2222', customerName: 'Karen Soto', orderName: '#BOT-25',
    trackingUrl: 'https://crm.example/seguimiento/token-seguro',
  });
  assert.match(result.text, /Sigue la ubicación.*https:\/\/crm\.example\/seguimiento\/token-seguro/s);
  assert.match(fixture.saved[0].content, /seguimiento\/token-seguro/);
});

test('pide feedback de primera compra con una pregunta breve y medible', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const result = await fixture.service.sendCustomerFeedbackRequest(3, {
    phone: '+56 9 1111 2222', customerName: 'María Soto', orderName: '#BOT-25',
  });
  assert.equal(result.sent, true);
  assert.equal(fixture.saved[0].agentType, 'customer_feedback');
  assert.match(result.text, /María.*primera experiencia.*#DR-25/s);
  assert.match(result.text, /Del 1 al 5/);
});

test('el feedback conserva Evolution cuando esa compra pertenece a una conversación Evolution', async () => {
  const fixture = serviceWith({
    lastInboundAt: null,
    provider: 'evolution',
    whatsappChannelId: 8,
  });
  const result = await fixture.service.sendCustomerFeedbackRequest(3, {
    phone: '+56 9 1111 2222', customerName: 'María Soto', orderName: '#BOT-25', conversationId: 41,
  });
  assert.equal(result.via, 'text');
  assert.equal(result.conversationId, 41);
  assert.equal(fixture.evolutionSends, 1);
  assert.equal(fixture.templateSends, 0);
});

test('una entrega no completada abre una conversación de resolución en el historial existente', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const result = await fixture.service.sendDeliveryOutcomeRecovery(3, {
    phone: '56911112222', customerName: 'Leonel Ruiz', orderName: '#51',
  }, { status: 'not_delivered', note: 'Cliente no estaba' });
  assert.equal(result.sent, true);
  assert.equal(fixture.saved[0].conversationId, 41);
  assert.equal(fixture.saved[0].agentType, 'delivery_recovery');
  assert.match(result.text, /Cliente no estaba.*reprogramar.*dirección/s);
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
    trackingUrl: 'https://crm.example/seguimiento/no-incluido-en-template-antiguo',
  });
  assert.equal(result.via, 'template');
  assert.equal(result.templateName, 'aviso_pedido_en_camino');
  assert.equal(fixture.sends, 0);
  assert.equal(fixture.templateSends, 1);
  assert.equal(fixture.evolutionLookups, 0);
  assert.match(fixture.saved[0].content, /Template: aviso_pedido_en_camino/);
  assert.doesNotMatch(fixture.saved[0].content, /no-incluido-en-template-antiguo/);
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
  assert.match(result.text, /Katherine.*#DR-17/s);
  assert.match(result.text, /1x 100 Jumbo/);
  assert.match(result.text, /Nuevo total: \$37\.000/);
  assert.doesNotMatch(result.text, /Dirección:/);
  assert.equal(fixture.saved[0].agentType, 'order_edit');
});

test('una fecha DATE de PostgreSQL se notifica en formato chileno sin undefined', async () => {
  const fixture = serviceWith({ lastInboundAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const base = {
    customer_name: 'Rosa', customer_phone: '56911112222',
    items: [{ name: '30 XL', quantity: 1, price: 12000 }], total_price: '12000',
  };
  const result = await fixture.service.sendOrderEditNotification(3, {
    source: 'bot', id: 19,
    before: { ...base, delivery_date: new Date('2026-10-13T00:00:00.000Z') },
    after: { ...base, delivery_date: new Date('2026-10-14T00:00:00.000Z') },
  });
  assert.equal(result.sent, true);
  assert.match(result.text, /Fecha de entrega: 14-10-2026/);
  assert.doesNotMatch(result.text, /undefined|Wed Oct/i);
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
    '../services/delivery-tracking': { createTrackingLink: async () => 'https://crm.example/seguimiento/test' },
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

test('el chat del repartidor cambia automáticamente de Kapso a Evolution con la ventana cerrada', async () => {
  const route = {
    id: 5,
    status: 'in_progress',
    orders: [{ source: 'bot', id: 17, phone: '56911112222', customerName: 'Katherine', orderName: '#BOT-17' }],
  };
  const pool = { query: async () => ({ rows: [route] }) };
  const kapsoConversation = { id: 41, phone_number: '56911112222', whatsapp_channel_id: null };
  const evolutionConversation = { id: 42, phone_number: '56911112222', whatsapp_channel_id: 8 };
  const saved = [];
  const database = {
    getPool: () => pool,
    getConversationById: async id => id === 41 ? kapsoConversation : evolutionConversation,
    getMessagesByCustomerPhone: async () => [
      { id: 1, conversation_id: 41, direction: 'inbound', content: 'Mensaje anterior por Kapso' },
      { id: 2, conversation_id: 42, direction: 'inbound', content: 'Respuesta por Evolution' },
    ],
    getEvolutionWhatsappChannel: async () => ({ id: 8, provider: 'evolution', status: 'connected' }),
    upsertConversation: async (_orgId, _phone, _name, channelId) => channelId === 8 ? evolutionConversation : kapsoConversation,
    getUserById: async () => ({ id: 9, name: 'Pedro Ruta' }),
    saveMessage: async value => { saved.push(value); return { id: 3, ...value }; },
    updateConversationLastMessage: async () => {},
    setAgentMode: async () => {},
  };
  const provider = {
    configForConversation: async () => ({ provider: 'kapso' }),
    sendTextMessage: async (_phone, _text, config) => {
      assert.equal(config.provider, 'evolution');
      return { messageId: 'evo.driver.1' };
    },
    messageId: result => result.messageId,
  };
  const router = load('src/routes/delivery.js', {
    '../db/database': database,
    '../services/delivery-notifications': {
      getCustomerServiceWindow: async () => ({ available: false, reason: 'WINDOW_EXPIRED', conversationId: 41 }),
    },
    '../services/whatsapp-provider': provider,
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
  });
  const base = { orgId: 3, userId: 9, role: 'repartidor', params: { id: '5' } };

  let res = response();
  await handler(router, 'get', '/routes/5/stops/chat')({ ...base, query: { stopKey: 'bot_17' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.window.available, true);
  assert.equal(res.body.data.window.channel, 'evolution');
  assert.equal(res.body.data.window.fallback, true);
  assert.equal(res.body.data.messages.length, 2);

  res = response();
  await handler(router, 'post', '/routes/5/stops/chat')({ ...base, body: { stopKey: 'bot_17', text: 'Voy llegando.' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.channel, 'evolution');
  assert.equal(res.body.data.fallback, true);
  assert.equal(saved[0].conversationId, 42);
});
