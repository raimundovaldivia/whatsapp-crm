const test = require('node:test');
const assert = require('node:assert/strict');

const outboundPolicy = require('../src/services/outbound-text-policy');
const businessDate = require('../src/services/business-date');

test('bloquea la instrucción interna observada sin bloquear respuestas al cliente', () => {
  const leaked = '✅ Tu respuesta anterior fue correcta. El cliente acaba de decir que quiere dos cajas. Tú puedes responder con el total.';
  assert.equal(outboundPolicy.checkOutboundText(leaked).ok, false);
  assert.equal(outboundPolicy.checkOutboundText('El último mensaje fue una reacción; debería esperar.').ok, false);
  assert.equal(outboundPolicy.checkOutboundText('Perfecto, puedo dejarte dos cajas XL para mañana 😊').ok, true);
  assert.equal(outboundPolicy.checkOutboundText('El cliente de empresa puede pagar por transferencia.').ok, true);
});

test('normaliza fechas PostgreSQL sin producir fragmentos de Date en inglés', () => {
  assert.equal(businessDate.toISODate(new Date('2026-10-14T00:00:00.000Z')), '2026-10-14');
  assert.equal(businessDate.toISODate('2026-10-14'), '2026-10-14');
  assert.equal(businessDate.toISODate('Wed Oct 14'), null);
  assert.equal(businessDate.toISODate('2026-02-30'), null);
});

test('resuelve fechas explícitas en horario de negocio y detecta contradicciones', () => {
  assert.deepEqual(
    businessDate.resolveExplicitDeliveryDate('lo necesito mañana', '2026-10-11'),
    { date: '2026-10-12', explicit: true, conflict: false, source: 'relative' }
  );
  assert.equal(businessDate.resolveExplicitDeliveryDate('mañana lunes', '2026-10-11').date, '2026-10-12');
  assert.equal(businessDate.resolveExplicitDeliveryDate('el miércoles 14/10/26', '2026-10-11').date, '2026-10-14');
  const conflict = businessDate.resolveExplicitDeliveryDate('mañana martes', '2026-10-11');
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.date, null);
});
