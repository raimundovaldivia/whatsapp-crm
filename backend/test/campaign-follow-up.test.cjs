const test = require('node:test');
const assert = require('node:assert/strict');

const {
  componentsForRecipient,
  summarizeFollowUpAudience,
  DEFAULT_CONDITIONS,
} = require('../src/services/campaign-follow-up');

test('reutiliza exactamente las variables originales del envío masivo', () => {
  const components = [{ type: 'body', parameters: [{ type: 'text', text: 'Laura' }, { type: 'text', text: 'Jumbo' }] }];
  assert.deepEqual(componentsForRecipient({ template_components: components }, 'Hola {{1}} {{2}}'), components);
});

test('recupera el nombre para campañas antiguas con una sola variable', () => {
  assert.deepEqual(
    componentsForRecipient({ contact_name: 'Laura Pérez', template_components: null }, 'Hola {{1}}'),
    [{ type: 'body', parameters: [{ type: 'text', text: 'Laura' }] }],
  );
});

test('no inventa variables faltantes en campañas antiguas', () => {
  assert.throws(
    () => componentsForRecipient({ contact_name: 'Laura' }, 'Hola {{1}}, tenemos {{2}}'),
    /No se conservaron/,
  );
});

test('la regla segura exige lectura, ausencia de respuesta, pedido y nuevo template', () => {
  assert.deepEqual(DEFAULT_CONDITIONS, {
    status: 'read',
    noInboundReply: true,
    noOrderAfterMessage: true,
    noLaterTemplate: true,
    respectOptOut: true,
  });
});

test('resume ventas atribuidas durante las 24 horas posteriores al envío', () => {
  const summary = summarizeFollowUpAudience([
    { eligible: false, reasons: ['respondio', 'hizo_pedido'], orderRevenue: '18000' },
    { eligible: false, reasons: ['hizo_pedido'], orderRevenue: 12000 },
    { eligible: true, reasons: [], orderRevenue: null },
  ]);
  assert.deepEqual(summary, {
    read: 3,
    eligible: 1,
    excluded: 2,
    reasons: { respondio: 1, hizo_pedido: 2 },
    attributedRevenue24h: 30000,
  });
});
