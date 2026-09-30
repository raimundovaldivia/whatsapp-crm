const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

const {
  normalizeInboundText,
  isLikelyAutomaticReply,
  isGiftedStockReply,
  isBareLinkMessage,
} = require('../src/services/inbound-message-policy');

test('detecta la autorespuesta comercial observada después de una campaña', () => {
  assert.equal(isLikelyAutomaticReply('Gracias por comunicarte con Lilabat. ¿Cómo podemos ayudarte?'), true);
});

test('tolera mayúsculas, tildes y espacios en autorespuestas conocidas', () => {
  assert.equal(isLikelyAutomaticReply('  GRACIAS POR COMUNICARTE CON TIENDA SUR.  ¿EN QUÉ PODEMOS AYUDARTE?  '), true);
  assert.equal(normalizeInboundText('¿En qué?'), '¿en que?');
});

test('no silencia respuestas humanas aunque sean breves', () => {
  for (const message of ['Hola gracias aún me quedan, le aviso', 'Gracias, sí quiero la misma caja', 'Hola, ¿cómo están?', 'Por ahora no necesito, gracias']) {
    assert.equal(isLikelyAutomaticReply(message), false, message);
  }
});

test('reconoce que el cliente recibió stock regalado', () => {
  assert.equal(isGiftedStockReply('No aún  Me regalaron huevitos...😃'), true);
  assert.equal(isGiftedStockReply('Sí, quiero una bandeja de huevos'), false);
});

test('reconoce un enlace compartido sin solicitud y tolera emojis', () => {
  assert.equal(isBareLinkMessage('https://www.instagram.com/reel/Dd4gR1qR0xo/?stkn=abc'), true);
  assert.equal(isBareLinkMessage('❤️ https://www.instagram.com/reel/Dd4gR1qR0xo/ 😊'), true);
  assert.equal(isBareLinkMessage('www.instagram.com/reel/Dd4gR1qR0xo/'), true);
});

test('no confunde un enlace acompañado de una consulta', () => {
  assert.equal(isBareLinkMessage('Mira este enlace https://example.com y dime el precio'), false);
  assert.equal(isBareLinkMessage('¿Tienen huevos jumbo?'), false);
});

test('el pipeline no responde a la autorespuesta y conserva template_sent', async () => {
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': {
      getConversationById: async () => ({ id: 91, pipeline_state: 'template_sent' }),
      getPool: () => ({ query: async () => ({ rows: [] }) }),
    },
    './commercial': { consumeBotTurn: async () => {} },
    './inbound-message-policy': { isLikelyAutomaticReply, isGiftedStockReply },
  });
  const result = await pipeline.processMessage(3, 91, 'Gracias por comunicarte con Lilabat. ¿Cómo podemos ayudarte?');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { response: null, skipped: true, reason: 'AUTOMATIC_REPLY' });
});

test('el pipeline pide contexto por un enlace solo sin escalar ni cambiar la baja', async () => {
  let classifierCalled = false;
  let stateChanged = false;
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': {
      getConversationById: async () => ({ id: 92, phone_number: '56911111111', pipeline_state: 'opted_out' }),
      updatePipelineState: async () => { stateChanged = true; },
    },
    './commercial': { consumeBotTurn: async () => {} },
    './inbound-message-policy': { isLikelyAutomaticReply, isGiftedStockReply, isBareLinkMessage },
    './agents/orchestrator': {
      classifyIntent: async () => { classifierCalled = true; },
      checkEscalation: async () => { classifierCalled = true; },
    },
  });

  const result = await pipeline.processMessage(3, 92, 'https://www.instagram.com/reel/Dd4gR1qR0xo/?stkn=abc');

  assert.equal(result.switchToHuman, false);
  assert.equal(result.newState, 'opted_out');
  assert.match(result.response, /Recibí el enlace/);
  assert.equal(classifierCalled, false);
  assert.equal(stateChanged, false);
});
