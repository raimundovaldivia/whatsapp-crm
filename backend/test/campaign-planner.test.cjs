const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../src/services/campaign-planner');

const templates = [
  {
    name: 'promo_huevos', status: 'APPROVED', language: 'es',
    components: [{ type: 'BODY', text: 'Hola {{1}}, tenemos promoción de huevos esta semana.' }],
  },
  {
    name: 'recordatorio_huevos', status: 'APPROVED', language: 'es',
    components: [{ type: 'BODY', text: 'Hola {{1}}, ¿quieres que reservemos tu pedido?' }],
  },
];

test('normaliza una propuesta natural usando sólo templates aprobados', () => {
  const result = planner.normalizePlan({
    name: 'Reactivar XL', objective: 'reactivacion', cooldownHours: 72,
    audience: { type: 'natural', segment: 'repeat', purchaseDays: 45, product: 'XL' },
    steps: [
      { templateName: 'promo_huevos', waitHours: 0, triggerCondition: 'always', variableModes: ['first_name'] },
      { templateName: 'recordatorio_huevos', waitHours: 24, triggerCondition: 'read_no_reply', variableModes: ['first_name'] },
    ],
    summary: 'Promoción inicial y recordatorio al día siguiente.',
  }, templates);
  assert.equal(result.ready, true);
  assert.equal(result.audience.type, 'natural');
  assert.equal(result.audience.purchaseDays, 45);
  assert.deepEqual(result.steps.map(step => step.templateName), ['promo_huevos', 'recordatorio_huevos']);
  assert.equal(result.steps[1].triggerCondition, 'read_no_reply');
});

test('descarta templates inventados y obliga a revisar variables sin valor', () => {
  const result = planner.normalizePlan({
    name: 'Plan inseguro',
    steps: [
      { templateName: 'template_inventado' },
      { templateName: 'promo_huevos', variableModes: [] },
    ],
  }, templates);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].templateName, 'promo_huevos');
  assert.equal(result.steps[0].variableModes[0], 'first_name');
  assert.match(result.warnings.join(' '), /descartado/i);
});

test('el planificador entrega una propuesta editable y nunca ejecuta envíos', async () => {
  let receivedPrompt = '';
  const client = { messages: { create: async request => {
    receivedPrompt = request.messages[0].content;
    return { content: [{ text: JSON.stringify({
      name: 'Clientes inactivos', objective: 'reactivacion', cooldownHours: 48,
      audience: { type: 'all', segment: 'all', purchaseDays: 60, product: null, deliveryIncidentsOnly: false },
      steps: [{ templateName: 'promo_huevos', waitHours: 0, triggerCondition: 'always', variableModes: ['first_name'] }],
      summary: 'Reactivar clientes sin compras recientes.', assumptions: [], warnings: [], missingInfo: [],
    }) }], };
  } } };
  const result = await planner.planCampaign({
    instruction: 'Reactiva clientes que llevan más de 60 días sin comprar', templates, client,
  });
  assert.equal(result.ready, true);
  assert.equal(result.audience.purchaseDays, 60);
  assert.match(receivedPrompt, /No envíes nada/);
  assert.match(receivedPrompt, /promo_huevos/);
});
