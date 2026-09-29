const test = require('node:test');
const assert = require('node:assert/strict');

const { componentsForRecipient, DEFAULT_CONDITIONS } = require('../src/services/campaign-follow-up');

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
