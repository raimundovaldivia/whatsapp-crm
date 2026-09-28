const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chileTimeParts,
  isCustomerMessagingHour,
  shouldSkipAutomatedFollowUp,
} = require('../src/services/outbound-policy');

test('usa la zona America/Santiago y bloquea las 05:15', () => {
  const earlyMorning = new Date('2026-09-28T08:15:00.000Z');
  assert.equal(chileTimeParts(earlyMorning).hour, '05');
  assert.equal(isCustomerMessagingHour(earlyMorning), false);
});

test('permite desde las 09:00 hasta las 20:59 y bloquea desde las 21:00', () => {
  assert.equal(isCustomerMessagingHour(new Date('2026-09-28T12:00:00.000Z')), true);
  assert.equal(isCustomerMessagingHour(new Date('2026-09-28T23:59:00.000Z')), true);
  assert.equal(isCustomerMessagingHour(new Date('2026-09-29T00:00:00.000Z')), false);
});

test('no insiste cuando el cliente ya postergó la compra', () => {
  assert.equal(shouldSkipAutomatedFollowUp([
    { direction: 'inbound', content: 'Si tengo un familiar proveedor por ahora gracias !!' },
    { direction: 'outbound', content: 'Entendido María, aquí estamos.' },
    { direction: 'inbound', content: 'Eso les encargo cuando pueda!!' },
  ]), true);
});

test('no reabre un hilo que Diva ya cerró', () => {
  assert.equal(shouldSkipAutomatedFollowUp([
    { direction: 'inbound', content: 'Gracias' },
    { direction: 'outbound', content: '¡Hasta pronto! 😊' },
  ]), true);
});

test('permite seguimiento cuando hay interés pendiente real', () => {
  assert.equal(shouldSkipAutomatedFollowUp([
    { direction: 'inbound', content: 'Cuánto cuesta la bandeja?' },
    { direction: 'outbound', content: 'La bandeja cuesta $6.000. ¿Cuántas necesitas?' },
  ]), false);
});

test('un pedido nuevo posterior vuelve a habilitar la conversación', () => {
  assert.equal(shouldSkipAutomatedFollowUp([
    { direction: 'inbound', content: 'Por ahora gracias' },
    { direction: 'outbound', content: 'Aquí estaremos cuando lo necesites.' },
    { direction: 'inbound', content: 'Ahora sí, quiero dos bandejas' },
    { direction: 'outbound', content: 'Perfecto, ¿confirmas la dirección?' },
  ]), false);
});
