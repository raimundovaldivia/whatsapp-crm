const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('elige una foto sólo cuando el cliente selecciona un producto inequívoco', async () => {
  const messages = [
    { direction: 'outbound', content: 'Los XL están en bandeja de 20 o 30. ¿Cuál prefieres?', type: 'text' },
    { direction: 'inbound', content: '30', type: 'text' },
    { direction: 'outbound', content: 'Blancos, mixtos o cafés', type: 'text' },
  ];
  const db = {
    getSetting: async () => 'local',
    getLastMessages: async () => messages,
    getProducts: async () => [
      { id: 1, title: 'Huevos de Campo Tamaño XL – Bandeja 30 Unidades Cafés', image_url: 'https://cdn.example/xl-cafe.jpg', stock: 10 },
      { id: 2, title: 'Huevos de Campo Tamaño XL – Bandeja 30 Unidades Blancos', image_url: 'https://cdn.example/xl-blanco.jpg', stock: 10 },
    ],
  };
  const media = load('src/services/product-media.js', { '../db/database': db });
  const suggestion = await media.suggest({
    orgId: 1, conversationId: 2, userMessage: 'Cafés',
    response: 'Perfecto. ¿Cuál es tu dirección?',
  });
  assert.equal(suggestion.mediaUrl, 'https://cdn.example/xl-cafe.jpg');
  assert.match(suggestion.caption, /XL.*30.*Cafés/i);
});

test('no repite fotos ni envía una imagen cuando la selección sigue ambigua', async () => {
  const product = { id: 1, title: 'Huevos XL Bandeja 30 Cafés', image_url: 'https://cdn.example/xl-cafe.jpg', stock: 10 };
  const base = {
    getSetting: async () => 'local', getProducts: async () => [product],
    getLastMessages: async () => [{ direction: 'outbound', content: 'Tenemos XL y Jumbo', type: 'text' }],
  };
  let media = load('src/services/product-media.js', { '../db/database': base });
  assert.equal(await media.suggest({ orgId: 1, conversationId: 1, userMessage: '¿Cuánto cuestan?', response: 'Hay varias opciones' }), null);

  media = load('src/services/product-media.js', { '../db/database': {
    ...base,
    getLastMessages: async () => [{ direction: 'outbound', content: 'XL 30 cafés', type: 'image', media_id: product.image_url }],
  } });
  assert.equal(await media.suggest({ orgId: 1, conversationId: 1, userMessage: 'Quiero XL 30 cafés', response: 'Perfecto' }), null);
});
