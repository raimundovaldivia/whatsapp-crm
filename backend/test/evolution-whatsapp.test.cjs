const test = require('node:test');
const assert = require('node:assert/strict');
const evolution = require('../src/services/evolution-whatsapp');
const { load, handler, response } = require('./helpers.cjs');

test('parsea un mensaje entrante de Evolution y conserva el JID para marcar leído', () => {
  const parsed = evolution.parseWebhookMessage({
    event: 'messages.upsert',
    data: {
      key: { id: 'ABC123', remoteJid: '56911112222@s.whatsapp.net', fromMe: false },
      pushName: 'María',
      messageTimestamp: 123456,
      message: { extendedTextMessage: { text: 'Quiero comprar dos unidades' } },
    },
  });
  assert.deepEqual(parsed, {
    messageId: 'ABC123',
    from: '56911112222',
    remoteJid: '56911112222@s.whatsapp.net',
    contactName: 'María',
    timestamp: 123456,
    type: 'text',
    text: 'Quiero comprar dos unidades',
  });
});

test('ignora mensajes propios y grupos', () => {
  assert.equal(evolution.parseWebhookMessage({
    event: 'MESSAGES_UPSERT',
    data: { key: { id: '1', remoteJid: '56911112222@s.whatsapp.net', fromMe: true }, message: { conversation: 'hola' } },
  }), null);
  assert.equal(evolution.parseWebhookMessage({
    event: 'MESSAGES_UPSERT',
    data: { key: { id: '2', remoteJid: '123@g.us', fromMe: false }, message: { conversation: 'hola' } },
  }), null);
});

test('resuelve JID alternativo y no crea clientes con LID ni con el número propio', () => {
  const inbound = evolution.parseWebhookMessage({
    event: 'messages.upsert',
    data: {
      key: { id: 'LID1', remoteJid: '227732168388781@lid', remoteJidAlt: '56999998888@s.whatsapp.net', fromMe: false },
      pushName: '56942876413@s.whatsapp.net',
      message: { conversation: 'Hola' },
    },
  }, { ownPhone: '56942876413' });
  assert.equal(inbound.from, '56999998888');
  assert.equal(inbound.contactName, null);

  assert.equal(evolution.parseWebhookMessage({
    event: 'messages.upsert',
    data: {
      key: { id: 'OWN1', remoteJid: '243833933660247@lid', remoteJidAlt: '56942876413@s.whatsapp.net', fromMe: true },
      message: { conversation: 'Mensaje técnico' },
    },
  }, { includeOwn: true, ownPhone: '56942876413' }), null);
});

test('el webhook descarta el eco técnico de la propia línea antes de crear una conversación', async () => {
  let upserts = 0;
  const channel = { id: 9, provider: 'evolution', phone_number: '56942876413' };
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': {
      getWhatsappChannel: async () => channel,
      getOrgById: async () => ({ id: 1, name: 'Prueba' }),
      getMessageByWhatsappId: async () => null,
      upsertConversation: async () => { upserts++; return { id: 1 }; },
    },
    '../services/evolution-whatsapp': evolution,
    '../services/inbound-text': { processInboundText: async () => {} },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
  });
  await handler(router, 'post', '/1/9/token')({
    params: { orgId: '1', channelId: '9', token: 'token' },
    body: { event: 'messages.upsert', data: {
      key: { id: 'GHOST1', remoteJid: '243833933660247@lid', remoteJidAlt: '56942876413@s.whatsapp.net', fromMe: true },
      message: { conversation: 'eco' },
    } },
  }, response());
  assert.equal(upserts, 0);
});

test('normaliza estados de entrega de Evolution', () => {
  assert.deepEqual(evolution.parseStatusUpdate({
    event: 'MESSAGES_UPDATE',
    data: { key: { id: 'MSG1' }, status: 'DELIVERY_ACK' },
  }), { messageId: 'MSG1', status: 'delivered', error: null });
});

test('normaliza la conexión de Evolution y recupera el número vinculado', () => {
  assert.deepEqual(evolution.parseConnectionUpdate({
    event: 'CONNECTION_UPDATE',
    data: { state: 'open', wuid: '56954565558:12@s.whatsapp.net' },
  }), { status: 'connected', phoneNumber: '56954565558' });
  assert.deepEqual(evolution.parseConnectionUpdate({
    event: 'connection.update',
    data: { instance: { state: 'close' } },
  }), { status: 'disconnected', phoneNumber: null });
  assert.equal(evolution.parseConnectionUpdate({ event: 'MESSAGES_UPSERT', data: {} }), null);
});

test('el webhook de conexión actualiza el canal sin iniciar el pipeline de mensajes', async () => {
  const updates = [];
  let inboundCalls = 0;
  const channel = { id: 9, provider: 'evolution', webhook_token: 'token' };
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': {
      getWhatsappChannel: async () => channel,
      getOrgById: async () => ({ id: 1, name: 'Prueba' }),
      updateWhatsappChannelStatus: async (...args) => { updates.push(args); return { ...channel, status: args[2], phone_number: args[3] }; },
    },
    '../services/evolution-whatsapp': evolution,
    '../services/inbound-text': { processInboundText: async () => { inboundCalls++; } },
    '../services/webhook-inbox': { durableWebhook: (_provider, fn) => fn },
  });
  const res = response();
  await handler(router, 'post', '/1/9/token')({
    params: { orgId: '1', channelId: '9', token: 'token' },
    body: { event: 'CONNECTION_UPDATE', data: { state: 'open', wuid: '56954565558@s.whatsapp.net' } },
  }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(updates, [[1, 9, 'connected', '56954565558']]);
  assert.equal(inboundCalls, 0);
});


test('phone messages sync to the right conversation without calling AI or duplicating echoes', async () => {
  const records = new Map(), events = [], modes = [];
  let inboundCalls = 0;
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': {
      getOrgById: async () => ({ id: 1 }),
      getWhatsappChannel: async () => ({ id: 9, provider: 'evolution' }),
      getMessageByWhatsappId: async (_org, id) => records.get(id) || null,
      upsertConversation: async (org, phone, name, channel) => { assert.equal(phone, '56911112222'); assert.equal(name, null); assert.equal(channel, 9); return {id:77}; },
      saveMessage: async message => { if (records.has(message.whatsappMessageId)) return null; records.set(message.whatsappMessageId,message); return {id:1,...message}; },
      setAgentMode: async (id, mode) => modes.push([id, mode]),
      updateConversationLastMessage: async () => {}, getConversationById: async () => ({id:77}),
    },
    '../services/evolution-whatsapp': evolution,
    '../services/inbound-text': {processInboundText: async () => { inboundCalls++; }},
    '../services/webhook-inbox': {durableWebhook:(_provider,fn)=>fn},
  });
  router.setSocketIO({to:()=>({emit:(...args)=>events.push(args)})});
  const req = {params:{orgId:'1',channelId:'9'},body:{event:'messages.upsert',data:{key:{id:'PHONE1',fromMe:true,remoteJid:'56911112222@s.whatsapp.net'},pushName:'Nombre del vendedor',message:{conversation:'Hola Patricia, te ayudo por aquí'}}}};
  await handler(router,'post','/1/9/token')(req,response());
  await handler(router,'post','/1/9/token')(req,response());
  assert.equal(records.size,1); assert.equal(events.length,2); assert.equal(inboundCalls,0);
  assert.deepEqual(modes, [[77, 'human']]);
  assert.equal(events[0][0], 'agent_mode_changed_1');
  assert.equal(records.get('PHONE1').sentBy,'human');
  assert.equal(records.get('PHONE1').direction,'outbound');
});

test('an early provider echo cannot relabel an AI message as human', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const engine = new PGlite();
  try {
    await engine.exec(`CREATE TABLE messages(id SERIAL PRIMARY KEY, conversation_id INT, whatsapp_message_id TEXT UNIQUE,
      direction TEXT, content TEXT, type TEXT, status TEXT, sent_by TEXT, agent_type TEXT, media_id TEXT)`);
    class Pool { query(sql,params) { return engine.query(sql,params); } }
    const db = load('src/db/database.js',{pg:{Pool}});
    const input={conversationId:1,whatsappMessageId:'ECHO1',direction:'outbound',content:'Hola'};
    await db.saveMessage({...input,sentBy:'human'});
    await db.saveMessage({...input,sentBy:'ai',agentType:'orders'});
    assert.equal(await db.saveMessage({...input,sentBy:'human'}),null);
    const rows=(await engine.query('SELECT * FROM messages')).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].sent_by,'ai');
  } finally { await engine.close(); }
});


test('response window allows composing without delaying own echoes', () => {
  const inbox = load('src/services/webhook-inbox.js');
  const body = {data:{key:{remoteJid:'56911111111@s.whatsapp.net'},message:{conversation:'Quiero un queso'}}};
  assert.equal(inbox.streamInfo('evolution',body,'messages.upsert').delay,8);
  body.data.message.conversation = 'Hola';
  assert.equal(inbox.streamInfo('evolution',body,'messages.upsert').delay,12);
  body.data.key.fromMe = true;
  assert.equal(inbox.streamInfo('evolution',body,'messages.upsert').delay,0);
  assert.equal(inbox.streamInfo('kapso',{message:{text:{body:'Uno porfa'}}},'whatsapp.message.received').delay,8);
});


test('API echo arriving before send acknowledgement is not a phone intervention', async () => {
  let resolveSend;
  const service = load('src/services/evolution-whatsapp.js', {
    axios: { create: () => ({ post: () => new Promise(resolve => { resolveSend = resolve; }) }) },
  });
  const config = {id: 9, organization_id: 1, evolution_api_url:'https://example.test', evolution_api_key:'test', evolution_instance:'ventas'};
  const sending = service.sendTextMessage('56911112222', 'Hola', config);
  await Promise.resolve();
  const earlyEcho = service.isApiMessage('API1', config);
  resolveSend({data:{key:{id:'API1'}}});
  await sending;
  assert.equal(await earlyEcho, true);
  assert.equal(await service.isApiMessage('PHONE1', config), false);
  assert.equal(await service.isApiMessage('API1', {...config, id:10}), false);
});
