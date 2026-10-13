const test = require('node:test');
const assert = require('node:assert/strict');
const coverage = require('../src/services/delivery-coverage');

const zone = 'La Serena y Coquimbo';

test('recognizes configured communes and their common sectors', () => {
  assert.equal(coverage.resolveCoveredPlace('Estoy en La Serena, sector norte', zone), 'la serena');
  assert.equal(coverage.resolveCoveredPlace('¿Llegan a Sindempart?', zone), 'coquimbo');
  assert.equal(coverage.resolveCoveredPlace('Vivo en Las Compañías', zone), 'la serena');
  assert.equal(coverage.resolveCoveredPlace('Despacho a Tierras Blancas', zone), 'coquimbo');
});

test('a false rejection inside coverage becomes an affirmative answer', () => {
  const result = coverage.guardResponse({
    message: '¿Despachan a La Florida?',
    response: 'No despachamos en ese sector.',
    zone,
  });

  assert.match(result, /s[ií], despachamos en La Serena/i);
  assert.doesNotMatch(result, /no despachamos/i);
});

test('an unknown sector asks for the commune instead of rejecting the order', () => {
  const result = coverage.guardResponse({
    message: '¿Llegan al sector Los Aromos?',
    response: 'Ese sector está fuera de nuestra cobertura.',
    zone,
  });

  assert.match(result, /La Serena y Coquimbo/);
  assert.match(result, /corresponde a alguna de esas comunas/i);
  assert.doesNotMatch(result, /fuera de nuestra cobertura/i);
});

test('non-coverage replies and organizations without zones stay unchanged', () => {
  const normal = 'Sí, despachamos mañana entre las 15:00 y las 21:00.';
  assert.equal(coverage.guardResponse({ message: '¿Despachan?', response: normal, zone }), normal);
  assert.equal(coverage.guardResponse({ message: '¿Llegan?', response: 'No llegamos a ese sector.', zone: '' }), 'No llegamos a ese sector.');
});

test('the prompt forbids inferring non-coverage from an unknown neighborhood', () => {
  const prompt = coverage.promptSection(zone);
  assert.match(prompt, /comunas completas/i);
  assert.match(prompt, /NUNCA concluyas ni digas que no despachamos/i);
  assert.match(prompt, /Sindempart/i);
  assert.match(prompt, /Las Compañías/i);
});
