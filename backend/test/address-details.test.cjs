const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addressDetails, shippingObject, shopifyAddress, legacyDriverResponse, readLegacyDriverAddress } = require('../src/utils/address-details');

test('Shopify conserva el departamento original hasta que el operador lo edita o borra', () => {
  const row = { raw_json: { shippingAddress: { address1: 'Calle Uno 23', address2: 'Torre A', city: 'Coquimbo' } } };
  assert.equal(shopifyAddress(row).address2, 'Torre A');
  assert.equal(shopifyAddress({ ...row, shipping_address2: '' }).address2, '');
  assert.deepEqual(addressDetails({ addressDescription: '  Portón azul  ' }), { addressDescription: 'Portón azul' });
  assert.deepEqual(shippingObject('Calle antigua 2'), { address: 'Calle antigua 2' });
});

test('la app instalada muestra ambos campos, conserva la navegación y puede devolver la dirección sin duplicarlos', () => {
  const stop = { address: 'Calle Uno 23', city: 'Coquimbo', address2: 'Torre A, depto. 2', addressDescription: 'Portón azul\nPreguntar en conserjería', fullAddress: 'Calle Uno 23, Coquimbo', lat: -29.9, lng: -71.2 };
  const response = legacyDriverResponse({ route: { orders: [stop], optimized_route: [stop] } });
  for (const view of [response.route.orders[0], response.route.optimized_route[0]]) {
    assert.match(view.address, /Casa \/ Depto\.: Torre A/);
    assert.match(view.address, /Referencia: Portón azul/);
    assert.equal(view.fullAddress, stop.fullAddress);
    assert.equal(view.lat, stop.lat);
    assert.deepEqual(readLegacyDriverAddress(view), stop);
  }
  assert.equal(stop.address, 'Calle Uno 23');
  assert.deepEqual(readLegacyDriverAddress({ address: 'Calle Dos' }), { address: 'Calle Dos' });
});
