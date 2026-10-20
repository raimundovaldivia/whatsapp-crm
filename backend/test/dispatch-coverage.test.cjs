const test = require('node:test');
const assert = require('node:assert/strict');
const coverage = require('../src/services/dispatch-coverage');

const warehouse = { address: 'Bodega', lat: -29.9027, lng: -71.2519 };

test('clasifica una dirección dentro y otra fuera del radio configurado', () => {
  const config = coverage.coverageConfig({ warehouse, radiusKm: 50 });
  const inside = coverage.classify({ lat: -29.9533, lng: -71.3395 }, config);
  const outside = coverage.classify({ lat: -30.603, lng: -71.200 }, config);
  assert.equal(inside.status, 'inside');
  assert.equal(outside.status, 'outside');
  assert.ok(outside.distanceKm > 50);
  assert.equal(outside.centerName, 'Bodega');
});

test('usa el más cercano entre varios puntos de cobertura', () => {
  const config = coverage.coverageConfig({
    warehouse,
    radiusKm: 20,
    points: [{ name: 'Ovalle', address: 'Ovalle', lat: -30.598, lng: -71.200 }],
  });
  const result = coverage.classify({ lat: -30.61, lng: -71.19 }, config);
  assert.equal(result.status, 'inside');
  assert.equal(result.centerName, 'Ovalle');
});

test('distingue cobertura no configurada de una dirección sin coordenadas', () => {
  assert.equal(coverage.classify({}, coverage.coverageConfig({ warehouse })).status, 'not_configured');
  assert.equal(coverage.classify({}, coverage.coverageConfig({ warehouse, radiusKm: 30 })).status, 'unlocated');
});

test('rechaza coordenadas placeholder y conserva puntos no geocodificados para edición', () => {
  assert.equal(coverage.validPoint({ lat: 0, lng: 0 }), false);
  const points = coverage.parsePoints(JSON.stringify([{ name: 'Norte', address: 'Ruta 5', lat: null, lng: null }]));
  assert.equal(points.length, 1);
  assert.equal(points[0].geocoded, false);
});
