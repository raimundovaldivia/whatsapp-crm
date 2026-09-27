const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildBodyTemplateComponent,
  getMissingBodyParameters,
  getTemplateVariables,
  renderTemplate,
  renderTemplateFromComponents,
} = require('../src/utils/template-renderer.mjs');

test('detecta variables repetidas y fuera de orden en orden numérico', () => {
  assert.deepEqual(getTemplateVariables('{{4}} / {{2}} / {{4}} / {{1}}'), ['1', '2', '4']);
});

test('funciona con uno y con cuatro valores sin lógica específica por variable', () => {
  assert.equal(renderTemplate('Hola {{1}}', { 1: 'Juan' }), 'Hola Juan');
  assert.equal(
    renderTemplate('{{4}}|{{2}}|{{1}}|{{3}}', { 1: 'uno', 2: 'dos palabras', 3: 'tres', 4: 'cuatro' }),
    'cuatro|dos palabras|uno|tres'
  );
});

test('un cambio de valor produce de inmediato una vista previa nueva', () => {
  assert.equal(renderTemplate('Hola {{1}}', { 1: 'Juan' }), 'Hola Juan');
  assert.equal(renderTemplate('Hola {{1}}', { 1: 'Pedro' }), 'Hola Pedro');
});

test('reemplaza palabras, frases, emojis, precios y variables repetidas sin cambiar el texto', () => {
  const body = 'Hola {{2}}\nOferta: {{1}}\nOtra vez: {{2}}';
  const values = {
    1: '2 bandejas  por  $12.990 🥚',
    2: 'Ana María',
  };
  assert.equal(
    renderTemplate(body, values),
    'Hola Ana María\nOferta: 2 bandejas  por  $12.990 🥚\nOtra vez: Ana María'
  );
});

test('conserva saltos de línea y espacios al principio y al final de cada valor', () => {
  const value = '  primera línea\nsegunda línea  ';
  assert.equal(renderTemplate('Antes\n{{1}}\nDespués', { 1: value }), `Antes\n${value}\nDespués`);
});

test('mantiene visible una variable faltante y permite detectarla antes del envío', () => {
  const body = 'Hola {{1}}, código {{4}}';
  const components = buildBodyTemplateComponent(body, { 1: 'Rai' });
  assert.equal(renderTemplate(body, { 1: 'Rai' }), 'Hola Rai, código {{4}}');
  assert.deepEqual(getMissingBodyParameters(body, components), ['4']);
});

test('vista previa y parámetros de envío producen exactamente el mismo mensaje', () => {
  const body = '{{3}}\n{{1}} — {{4}}\n{{3}}';
  const values = {
    1: 'Pack familiar',
    3: '¡Hola! 👋',
    4: '$25.000\nEntrega mañana',
  };
  const components = buildBodyTemplateComponent(body, values);
  assert.deepEqual(components[0].parameters.map(parameter => parameter.text), [
    'Pack familiar', '¡Hola! 👋', '$25.000\nEntrega mañana',
  ]);
  assert.equal(renderTemplateFromComponents(body, components), renderTemplate(body, values));
});

test('trata el contenido como texto plano, sin interpretar HTML', () => {
  const value = '<img src=x onerror=alert(1)> & precio $5.000';
  assert.equal(renderTemplate('{{1}}', { 1: value }), value);
});

test('frontend y backend distribuyen la misma implementación del renderer', () => {
  const backendSource = fs.readFileSync(path.join(__dirname, '../src/utils/template-renderer.mjs'), 'utf8');
  const frontendSource = fs.readFileSync(path.join(__dirname, '../../frontend/src/utils/template-renderer.js'), 'utf8');
  assert.equal(frontendSource, backendSource);
});
