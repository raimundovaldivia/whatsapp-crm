const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function guard({ order = null, fail = false } = {}) {
  return load('src/services/response-guardrail.js', {
    '../db/database': { getPool: () => ({ query: async (sql, params) => {
      assert.deepEqual(Array.from(params), [7, 91]);
      assert.match(sql, /organization_id = \$1 AND conversation_id = \$2/);
      if (fail) throw new Error('Simulated read failure');
      return { rows: sql.includes('FROM orders') ? (order ? [order] : []) : [{ id: 19, desired_date: '2099-01-01' }] };
    } }) },
  });
}
const current = () => ({ id: 812, status: 'draft', created_at: new Date(), touched_at: new Date() });
const promises = ['El viernes 23 te llegan tus 30 huevos XL.', 'Ese día te avisamos cuando vaya saliendo.',
  'Te los entregamos mañana.', 'Te avisamos cuando esté en camino.', 'Tu pedido está en camino.', 'Te confirmo el pedido:'];

test('un agendamiento sin orden no respalda promesas de entrega ni confirmaciones', async () => {
  for (const text of promises) assert.equal((await guard().checkResponseFreshness(7, 91, text, { newState: 'scheduled' })).ok, false, text);
});

test('un resumen pendiente tampoco puede apoyarse en un pedido anterior activo', async () => {
  for (const newState of ['collecting_order', 'scheduled']) {
    assert.equal((await guard({ order: current() }).checkResponseFreshness(7, 91, promises[0], { newState })).ok, false);
  }
});

test('la orden guardada permite la confirmación y el aviso de despacho posterior', async () => {
  for (const text of promises) {
    assert.equal((await guard({ order: current() }).checkResponseFreshness(7, 91, text, { orderCreated: { orderId: 812 }, newState: 'confirmed' })).ok, true, text);
  }
  assert.equal((await guard({ order: current() }).checkResponseFreshness(7, 91, promises[3])).ok, true);
  assert.equal((await guard({ order: { ...current(), status: 'asignado_ruta' } }).checkResponseFreshness(7, 91, promises[3])).ok, true);
});

test('un pedido cancelado, entregado o antiguo no respalda una entrega nueva', async () => {
  for (const order of [{ ...current(), status: 'cancelado' }, { ...current(), status: 'entregado' },
    { ...current(), touched_at: new Date(Date.now() - 5 * 86400000) }]) {
    assert.equal((await guard({ order }).checkResponseFreshness(7, 91, promises[0])).ok, false);
  }
});

test('un error consultando la orden bloquea la promesa pero permite texto sin promesas', async () => {
  assert.equal((await guard({ fail: true }).checkResponseFreshness(7, 91, promises[0])).ok, false);
  for (const text of ['¿Qué producto prefieres?', 'Fecha solicitada: viernes 23.', 'Te enviamos el catálogo por aquí.',
    'No puedo confirmar cuándo te llegan.', 'El pedido todavía no está creado y la entrega está pendiente de confirmación.']) {
    assert.equal((await guard({ fail: true }).checkResponseFreshness(7, 91, text)).ok, true, text);
  }
});

test('el filtro saliente aplica la protección incluso si el modelo pide atención humana', async () => {
  const service = load('src/services/pipeline-outbound.js', { './response-guardrail': guard() });
  const result = await service.evaluatePipelineResult({ orgId: 7, conversationId: 91, userMessage: 'Gracias',
    result: { response: promises[0], switchToHuman: true, newState: 'collecting_order' } });
  assert.equal(result.escalate, true);
  assert.equal(result.code, 'stale_response');
  assert.doesNotMatch(result.response, /te llegan/i);
});
