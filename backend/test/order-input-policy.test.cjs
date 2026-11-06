const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/services/order-input-policy');

const reviewedNotes = notes => ({ notes, _reviewed_order: JSON.stringify({ notes }) });
test('reconoce sí es correcto como confirmación completa, sin preguntas ni condiciones', () => {
  for (const message of ['Si es correcto', 'Sí, es correcto.', 'Sí es correcto\nGracias']) {
    assert.equal(policy.isBareAffirmative(message), true, message);
  }
  for (const message of ['¿Sí es correcto?', 'Sí es correcto si llega mañana',
    'Sí es correcto pero cambia la dirección', 'Sí es correcto, agrega otra bandeja',
    'No es correcto', 'Sí es correcto el teléfono']) {
    assert.equal(policy.isBareAffirmative(message), false, message);
  }
});

test('confirmación con indicaciones repetidas exige cláusulas completas ya revisadas', () => {
  const draft = reviewedNotes('PRUEBA INTERNA, NO PREPARAR, NO COBRAR NI DESPACHAR. Pago en efectivo al recibir. No tocar el timbre.');
  for (const message of [
    'Sí, todo correcto. Confirmo este pedido de prueba. No preparar, cobrar ni despachar.',
    'Confirmo el pedido. No preparar, no cobrar ni despachar.',
    'Sí, no preparar, cobrar ni despachar.',
    'Sí, todo correcto. Pago en efectivo al recibir.',
    'Confirmo el pedido. No tocar el timbre.',
  ]) assert.equal(policy.isReviewedAffirmative(message, draft), true, message);
  for (const message of [
    'No preparar, cobrar ni despachar.', 'Sí. Cobrar y despachar.',
    'Sí. No preparar, cobrar ni despachar mañana.', 'Sí. Pago en efectivo.',
    'Sí. Pago en efectivo al recibir. Agrega otra caja.',
    'Sí. No preparar, cobrar ni despachar. No confirmo.',
    'Sí, pero cambia la dirección.', 'Confirmo si llega mañana.',
    'Sí. ¿Pago en efectivo al recibir?', 'Sí. Tocar el timbre.',
  ]) assert.equal(policy.isReviewedAffirmative(message, draft), false, message);
  for (const value of [{}, { notes: draft.notes }, { ...draft, _reviewed_order: 'invalid' },
    { ...draft, notes: 'Pago con tarjeta' }]) {
    assert.equal(policy.isReviewedAffirmative('Sí. No preparar, cobrar ni despachar.', value), false);
  }
  assert.equal(policy.isReviewedAffirmative('Sí. Si llega mañana.', reviewedNotes('Si llega mañana.')), false);
  assert.equal(policy.isReviewedAffirmative('Sí. No confirmo.', reviewedNotes('No confirmo.')), false);
});

test('el nombre declarado en la compra actual tiene prioridad sobre el historial', () => {
  for (const [message, expected] of [
    ['Quiero 1 bandeja. Es una prueba interna a nombre de PRUEBA INICIO INSTAGRAM, sin cobro ni despacho.', 'PRUEBA INICIO INSTAGRAM'],
    ['Quiero comprar a nombre de María José O’Connor; pago en efectivo.', 'María José O’Connor'],
    ['Me llamo Ana-María de la Cruz. Mi dirección es Calle 123.', 'Ana-María de la Cruz'],
    ['A nombre de María J. Pérez. Pago en efectivo.', 'María J. Pérez'],
    ['Mi nombre es José Pérez y mi teléfono es 56911111111', 'José Pérez'],
    ['Nombre: Cliente Nuevo\nDirección: Calle 123', 'Cliente Nuevo'],
    ['Nombre:Cliente Nuevo\nDirección: Calle 123', 'Cliente Nuevo'],
    ['Mi nombre es Juan Pérez y quiero 1 bandeja', 'Juan Pérez'],
    ['A nombre de Ana por favor', 'Ana'],
    ['A nombre de Ana, mejor a nombre de María.', 'María'],
  ]) {
    assert.equal(policy.resolveCustomerName(message, 'Cliente anterior', 'Cliente anterior'), expected, message);
    assert.equal(policy.resolveCustomerName(message, undefined, undefined), expected, message);
  }
});

test('no interpreta preguntas, negaciones ni referencias al pedido anterior como un nombre nuevo', () => {
  for (const message of ['¿A nombre de quién está?', 'No me llamo Pedro',
    'El pedido anterior estaba a nombre de Pedro', 'Antes me llamo Pedro',
    'Si va a nombre de Pedro, avísame', 'A nombre de pendiente',
    'A nombre de <script>alert(1)</script>', 'Mi nombre es ' + 'x'.repeat(121)]) {
    assert.equal(policy.explicitCustomerName(message), null, message);
  }
});

test('conserva el nombre actual al aportar dirección o pagar y permite otra corrección explícita', () => {
  assert.equal(policy.resolveCustomerName('Dirección Calle 123, pago en efectivo', 'Cliente Nuevo', 'Cliente anterior'), 'Cliente Nuevo');
  assert.equal(policy.resolveCustomerName('Sí, todo correcto', 'Cliente Nuevo', 'Cliente anterior'), 'Cliente Nuevo');
  assert.equal(policy.resolveCustomerName('El nombre correcto para este pedido es María Pérez', 'Cliente Nuevo', 'María Pérez'), 'María Pérez');
  assert.equal(policy.resolveCustomerName('Es para Mariana', 'Cliente Nuevo', 'Ana'), 'Cliente Nuevo');
  assert.equal(policy.resolveCustomerName('Quiero una bandeja', undefined, 'Cliente conocido'), 'Cliente conocido');
});

test('detecta cantidades alfanuméricas ambiguas sin bloquear cantidades válidas', () => {
  assert.equal(policy.ambiguousQuantityToken('necesito 3o L café'), '3o');
  assert.equal(policy.ambiguousQuantityToken('quiero 30 huevos L café'), null);
  assert.equal(policy.ambiguousQuantityToken('quiero 3 cajas'), null);
});

test('un sí aislado no puede introducir un producto distinto en un pedido existente', () => {
  const previous = { items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }] };
  const renamed = { product_name: 'Bandeja 30 huevos XL café', quantity: 1 };
  const cheese = { product_name: 'Queso de cabra 900 g', quantity: 1 };

  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí', previous, { items: [renamed] }), []);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí', previous, { items: [renamed, cheese] }), [cheese]);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí, gracias', previous, { items: [renamed, cheese] }), [cheese]);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí, por favor', previous, { items: [renamed, cheese] }), [cheese]);
  assert.deepEqual(policy.unexpectedItemsFromBareAffirmative('Sí, agrega un queso', previous, { items: [renamed, cheese] }), []);
});

test('reconoce intención mayorista y evita falsos positivos pequeños', () => {
  for (const text of ['venta por mayor', 'precio para empresa', 'quiero un paled', 'necesito 4 cajas']) {
    assert.equal(policy.isWholesaleInquiry(text), true, text);
  }
  for (const text of ['quiero una caja', 'precio de una bandeja', 'necesito 2 cajas']) {
    assert.equal(policy.isWholesaleInquiry(text), false, text);
  }
});
