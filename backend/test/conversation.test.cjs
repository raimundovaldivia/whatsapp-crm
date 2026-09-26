const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const context = require('../src/services/agents/conversation-context');

function agent(file, reply = {}) {
  const calls = [];
  class FakeModel {
    constructor() {
      this.messages = { create: async input => {
        calls.push(input);
        return { content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] };
      } };
    }
  }
  return { service: load(`src/services/agents/${file}.js`, {
    '@anthropic-ai/sdk': FakeModel, './conversation-context': context,
  }), calls };
}
const inbound = content => ({ direction: 'inbound', content });
const outbound = content => ({ direction: 'outbound', content });

test('context preserves earlier short answers and excludes non-conversation/empty entries', () => {
  const history = [inbound('hola'), outbound('¿Quieres información?'), inbound('sí'),
    outbound('¿Entregamos en Santiago?'), { direction: 'internal', content: 'secret note' },
    outbound(null), inbound('  '), inbound('sí')];
  const messages = context.buildMessages(history, 'sí');
  assert.equal(messages.length, 5);
  assert.equal(messages.filter(m => m.content === 'sí').length, 2);
  assert.equal(messages.at(-2).content, '¿Entregamos en Santiago?');
});

test('context appends an unpersisted turn and supports an empty history', () => {
  assert.deepEqual(context.buildMessages(null, 'hola'), [{ role: 'user', content: 'hola' }]);
  assert.deepEqual(context.buildMessages([inbound('sí'), outbound('¿Cuántas?')], 'dos').at(-1),
    { role: 'user', content: 'dos' });
});

test('intent classification receives the latest message once and preserves zero confidence', async () => {
  const { service, calls } = agent('orchestrator', { intent: 'interested', confidence: 0 });
  const result = await service.classifyIntent('sí', [outbound('¿Quieres ver precios?'), inbound('sí')], 'exploring');
  assert.equal(result.confidence, 0);
  assert.equal(calls[0].messages.filter(m => m.content === 'sí').length, 1);
});

test('invalid intents and order modifications without an active order fall back safely', async () => {
  for (const intent of ['invented_state', 'modify_order', 'cancel_order']) {
    const { service } = agent('orchestrator', { intent, confidence: 1 });
    assert.equal((await service.classifyIntent('cambia eso', [], 'exploring')).intent, 'exploring');
  }
  const { service } = agent('orchestrator', { intent: 'modify_order', confidence: 2 });
  const result = await service.classifyIntent('agrega uno', [], 'exploring', { hasActiveOrder: true });
  assert.equal(result.intent, 'modify_order');
  assert.equal(result.confidence, 1);
});

test('explicit human requests override previous escalation messages', async () => {
  const { service, calls } = agent('orchestrator');
  const history = [outbound('Voy a conectarte'), outbound('Un asesor te ayudará')];
  for (const message of ['quiero hablar con una persona', 'asesor', 'pasame con un asesor']) {
    const result = await service.checkEscalation(message, history, 'collecting_order');
    assert.equal(result.escalate, true, message);
    assert.equal(result.urgency, 'high');
  }
  assert.equal(calls.length, 0);
});

test('complaints still escalate after repeated handoff promises; ordinary queries break the loop', async () => {
  const { service } = agent('orchestrator');
  const history = [outbound('Voy a conectarte'), outbound('Un asesor te ayudará')];
  assert.equal((await service.checkEscalation('mi pedido nunca llegó', history, 'exploring')).escalate, true);
  const ordinary = await service.checkEscalation('¿Cuánto cuesta la caja?', history, 'exploring');
  assert.equal(ordinary.escalate, false);
  assert.equal(ordinary.loopDetected, true);
});

test('escalation analysis includes the current complaint once', async () => {
  const { service, calls } = agent('orchestrator', { escalate: false });
  const history = [inbound('hola'), outbound('hola'), inbound('precio'), outbound('100'),
    inbound('envío'), outbound('Santiago'), inbound('horarios'), outbound('lunes'), inbound('¿Y el sábado?')];
  await service.checkEscalation('¿Y el sábado?', history, 'exploring');
  assert.equal(calls[0].messages[0].content.split('¿Y el sábado?').length - 1, 1);
});

test('sales keeps the prior question and does not duplicate an already saved answer', async () => {
  const { service, calls } = agent('sales', 'La caja cuesta $100.');
  assert.equal(await service.generateSalesResponse([outbound('¿Quieres ver precios?'), inbound('sí')], 'sí'),
    'La caja cuesta $100.');
  assert.equal(calls[0].messages.length, 2);
  assert.equal(calls[0].messages[0].content, '¿Quieres ver precios?');
});
