const test = require('node:test');
const assert = require('node:assert/strict');
const probability = require('../src/services/purchase-probability');
const { load, handler, response, noop } = require('./helpers.cjs');

const now = new Date('2026-10-16T16:00:00.000Z');
const message = (direction, content, created_at = '2026-10-16T14:00:00.000Z') => ({ direction, content, created_at });

test('prioriza una cotización concreta detenida en te aviso sobre una consulta genérica', () => {
  const quoted = probability.scoreConversation({
    now,
    messages: [
      message('inbound', 'Quiero dos bandejas Jumbo café de 30. ¿Cuánto salen?'),
      message('outbound', 'Las dos bandejas quedan en $29.300 y tres en $40.000.'),
      message('inbound', 'Te aviso gracias'),
    ],
  });
  const generic = probability.scoreConversation({
    now,
    messages: [message('inbound', 'Hola, quería información')],
  });

  assert.ok(quoted.probability48h > generic.probability48h);
  assert.equal(quoted.stage, 'decision');
  assert.equal(quoted.blocker, 'decision_delay');
  assert.match(quoted.recommendedAction, /producto, cantidad y precio/i);
  assert.equal(quoted.estimatedEggs, 60);
});

test('distingue una duda logística de una objeción de precio', () => {
  const result = probability.scoreConversation({
    now,
    messages: [
      message('inbound', '¿El sábado tienen reparto?'),
      message('outbound', 'Sí, repartimos el sábado entre 15:00 y 21:00.'),
    ],
  });
  assert.equal(result.stage, 'logistics');
  assert.equal(result.blocker, 'logistics');
  assert.match(result.recommendedAction, /despacho u horario/i);
});

test('un contacto dado de baja nunca aparece con probabilidad positiva', () => {
  const result = probability.scoreConversation({
    now,
    pipelineState: 'opted_out',
    messages: [message('inbound', 'No quiero recibir más mensajes')],
  });
  assert.equal(result.probability24h, 0);
  assert.equal(result.probability48h, 0);
  assert.equal(result.recommendedAction, 'No contactar');
});

test('no vuelve a vender una conversación que ya terminó en compra', () => {
  const result = probability.scoreConversation({
    now,
    messages: [message('inbound', 'Quiero dos bandejas XL')],
    pipelineState: 'done',
    lastOrderAt: '2026-10-16T15:00:00.000Z',
  });

  assert.equal(result.probability24h, 0);
  assert.equal(result.probability48h, 0);
  assert.equal(result.stage, 'converted');
  assert.equal(result.blocker, 'already_purchased');
  assert.match(result.recommendedAction, /no insistir/i);
});

test('una intención nueva posterior al último pedido vuelve a ser evaluable', () => {
  const result = probability.scoreConversation({
    now,
    messages: [message('inbound', 'Quiero dos bandejas XL', '2026-10-16T15:30:00.000Z')],
    lastOrderAt: '2026-10-16T15:00:00.000Z',
  });

  assert.ok(result.probability48h > 0);
  assert.equal(result.blocker, 'confirmation');
  assert.match(result.recommendedAction, /confirmaci[oó]n directa/i);
});

test('una respuesta posventa no hereda la intención del pedido ya convertido', () => {
  const result = probability.scoreConversation({
    now,
    messages: [
      message('inbound', 'Quiero dos bandejas XL', '2026-10-16T13:00:00.000Z'),
      message('outbound', 'Pedido confirmado', '2026-10-16T13:10:00.000Z'),
      message('outbound', '¿Cómo te resultaron los huevos?', '2026-10-16T15:20:00.000Z'),
      message('inbound', 'Todo bien, gracias', '2026-10-16T15:30:00.000Z'),
    ],
    pipelineState: 'done',
    priorOrders: 2,
    lastOrderAt: '2026-10-16T15:00:00.000Z',
    historicalEggs: [60, 60],
  });

  assert.ok(result.probability48h < 30);
  assert.notEqual(result.stage, 'decision');
  assert.equal(result.signals.some(signal => signal.key === 'explicit_intent'), false);
});

test('calcula huevos desde líneas de pedido y respeta multiplicadores', () => {
  const eggs = probability.eggsFromOrderItems(JSON.stringify([
    { name: 'CAJA XL 180 HUEVOS CAFE', quantity: 2 },
    { name: 'Huevos Jumbo blancos · Bandeja de 20', quantity: 1 },
    { name: 'Aceitunas verdes', quantity: 4 },
  ]));
  assert.equal(eggs, 380);
});

test('usa la mediana del historial cuando la conversación no incluye cantidad', () => {
  const result = probability.scoreConversation({
    now,
    messages: [message('inbound', '¿Tienes huevos XL disponibles?')],
    historicalEggs: [30, 60, 60, 180],
  });
  assert.equal(result.estimatedEggs, 60);
  assert.equal(result.estimateSource, 'purchase_history');
});

test('no convierte cajas ambiguas en 180 huevos cuando la cotización ofrece bandejas', () => {
  const result = probability.scoreConversation({
    now,
    pipelineState: 'collecting_order',
    messages: [
      message('inbound', '¿Cuánto cuestan los huevos de campo?', '2026-10-13T11:53:00.000Z'),
      message('outbound', '¿Qué talla prefieres y cuántos huevos necesitas?', '2026-10-13T11:53:10.000Z'),
      message('inbound', 'XL 20 cajas', '2026-10-13T15:13:00.000Z'),
      message('outbound', 'XL · Bandeja de 20: blancos $8.490, mixtos $8.990 o cafés $9.990', '2026-10-13T15:13:10.000Z'),
    ],
  });

  assert.equal(result.estimatedEggs, 400);
  assert.equal(result.estimateSource, 'ambiguous_container');
  assert.equal(result.blocker, 'unit_clarification');
  assert.ok(result.signals.some(signal => signal.key === 'container_ambiguity'));
  assert.match(result.recommendedAction, /20 cajas mayoristas de 180 huevos o 20 bandejas de 20/i);
});

test('excluye empresas que ya compraron durante los últimos siete días', () => {
  const shared = {
    now,
    lastOrderAt: '2026-10-14T15:00:00.000Z',
    messages: [message('inbound', 'Quiero dos cajas XL', '2026-10-16T15:30:00.000Z')],
  };
  const business = probability.scoreConversation({ ...shared, clientType: 'empresa' });
  const person = probability.scoreConversation({ ...shared, clientType: 'personal' });

  assert.equal(business.probability24h, 0);
  assert.equal(business.probability48h, 0);
  assert.equal(business.stage, 'excluded');
  assert.equal(business.blocker, 'business_recent_order');
  assert.match(business.recommendedAction, /excluir.*esta semana/i);
  assert.ok(person.probability48h > 0);
});

test('excluye a quien informó que ya compró con otro proveedor', () => {
  const result = probability.scoreConversation({
    now,
    messages: [
      message('inbound', 'Cuánto saldría comprar 3 cajas semanales', '2026-10-09T17:45:00.000Z'),
      message('outbound', '¿Te las pedimos para esta semana?', '2026-10-09T17:48:00.000Z'),
      message('inbound', 'Hola buen día, esperé mucho la respuesta, ya compramos con otro proveedor, gracias de todas maneras', '2026-10-10T08:04:00.000Z'),
    ],
  });

  assert.equal(result.probability24h, 0);
  assert.equal(result.probability48h, 0);
  assert.equal(result.stage, 'excluded');
  assert.equal(result.blocker, 'bought_elsewhere');
  assert.match(result.recommendedAction, /no insistir.*otro proveedor/i);
});

test('una intención nueva posterior a comprar fuera vuelve a ser evaluable', () => {
  const result = probability.scoreConversation({
    now,
    messages: [
      message('inbound', 'Ya compramos con otro proveedor', '2026-10-10T08:04:00.000Z'),
      message('inbound', 'Ahora necesito dos cajas XL para mañana', '2026-10-16T15:30:00.000Z'),
    ],
  });

  assert.ok(result.probability48h > 0);
  assert.notEqual(result.blocker, 'bought_elsewhere');
});

test('el recálculo rechaza rangos inválidos antes de consultar la base', async () => {
  let queries = 0;
  const pool = { query: async () => { queries++; return { rows: [] }; } };
  const router = load('src/routes/bot-eval.js', {
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/purchase-probability': probability,
  });
  const run = handler(router, 'post', '/purchase-probability/recalculate');
  const res = response();
  await run({ orgId: 77, body: { from: '16-10-2026', to: '2026-10-16' } }, res);
  assert.equal(res.code, 400);
  assert.equal(queries, 0);
});

test('el recálculo restringe la consulta de candidatos a la organización autenticada', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const router = load('src/routes/bot-eval.js', {
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/purchase-probability': probability,
  });
  const run = handler(router, 'post', '/purchase-probability/recalculate');
  const res = response();
  await run({ orgId: 77, body: { from: '2026-10-01', to: '2026-10-16' } }, res);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 77);
  assert.match(calls[0].sql, /c\.organization_id = \$1/);
});
