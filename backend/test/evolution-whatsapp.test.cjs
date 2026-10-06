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
  const records = new Map(), events = [];
  let inboundCalls = 0;
  const router = load('src/routes/evolution-webhook.js', {
    '../db/database': {
      getOrgById: async () => ({ id: 1 }),
      getWhatsappChannel: async () => ({ id: 9, provider: 'evolution' }),
      upsertConversation: async (org, phone, name, channel) => { assert.equal(phone, '56911112222'); assert.equal(name, null); assert.equal(channel, 9); return {id:77}; },
      saveMessage: async message => { if (records.has(message.whatsappMessageId)) return null; records.set(message.whatsappMessageId,message); return {id:1,...message}; },
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
  assert.equal(records.size,1); assert.equal(events.length,1); assert.equal(inboundCalls,0);
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
