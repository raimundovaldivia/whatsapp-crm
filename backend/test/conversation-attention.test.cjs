const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveAttentionState } = require('../src/services/conversation-attention');

const now = new Date('2026-10-13T15:00:00.000Z').getTime();
const oldInbound = text => ({
  agent_mode: 'ai',
  last_message: text,
  last_message_direction: 'inbound',
  last_message_created_at: '2026-10-13T14:50:00.000Z',
});

test('no pone agradecimientos, rechazos ni emojis en la cola de atención', () => {
  for (const text of ['Muchas gracias', 'No gracias', 'Yo aviso', '👌🏼']) {
    assert.equal(deriveAttentionState(oldInbound(text), now), 'no_response_needed', text);
  }
});

test('mantiene preguntas, aceptaciones y datos de entrega como pendientes', () => {
  for (const text of ['¿Cuánto salen dos?', 'Sí porfa', 'Av. Central 455', 'Buen día']) {
    assert.equal(deriveAttentionState(oldInbound(text), now), 'bot_unanswered', text);
  }
  assert.equal(deriveAttentionState({ ...oldInbound('Sí porfa'), agent_mode: 'human' }, now), 'requires_human');
});

test('conserva los estados normales de mensajes recientes y salientes', () => {
  assert.equal(deriveAttentionState({ ...oldInbound('Necesito ayuda'), last_message_created_at: '2026-10-13T14:59:30.000Z' }, now), 'waiting_bot');
  assert.equal(deriveAttentionState({ last_message_direction: 'outbound', last_message_sent_by: 'ai' }, now), 'handled_by_bot');
});
