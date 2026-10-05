const test = require('node:test');
const assert = require('node:assert/strict');

test('free text needs no template or parameters and preserves multiline content', async () => {
  const { renderDirectMessage } = await import('../../frontend/src/utils/direct-message.mjs');
  const source = 'Hola 👋\n\nEsta semana hay huevos.\n¿Te anotamos?';
  assert.deepEqual(renderDirectMessage(source, {}), { text: source, missing: [] });
});

test('optional parameters render independently for each recipient, including repeated values and zero', async () => {
  const { renderDirectMessage } = await import('../../frontend/src/utils/direct-message.mjs');
  const source = 'Hola {{nombre}}, ¿quieres {{producto_favorito}}?\n{{nombre}} · {{cantidad_pedidos}}';
  assert.equal(renderDirectMessage(source, { nombre: 'Gloria', producto_favorito: 'huevos', cantidad_pedidos: 0 }).text, 'Hola Gloria, ¿quieres huevos?\nGloria · 0');
  assert.equal(renderDirectMessage(source, { nombre: 'Ana', producto_favorito: 'queso', cantidad_pedidos: 2 }).text, 'Hola Ana, ¿quieres queso?\nAna · 2');
  assert.deepEqual(renderDirectMessage('Hola {{ ciudad }} {{desconocido}}', { ciudad: '' }).missing, ['ciudad', 'desconocido']);
  assert.equal(renderDirectMessage('{{nombre}}', { nombre: '$& {{ciudad}}' }).text, '$& {{ciudad}}');
});

test('parameter insertion uses cursor or selection without replacing the rest of the draft', async () => {
  const { insertDirectParameter } = await import('../../frontend/src/utils/direct-message.mjs');
  assert.deepEqual(insertDirectParameter('Hola , ¿cómo estás?', 'nombre', 5, 5), { text: 'Hola {{nombre}}, ¿cómo estás?', cursor: 15 });
  assert.deepEqual(insertDirectParameter('Hola Ana!', 'nombre', 5, 8), { text: 'Hola {{nombre}}!', cursor: 15 });
});
