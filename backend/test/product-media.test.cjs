const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

const goat = { id: 1, title: 'Queso de Cabra Fresco Pasteurizado – 900 g–1 kg', image_url: 'https://cdn.example/cabra.jpg' };
const cow = { id: 2, title: 'Queso de Vaca Artesanal – 900 g', image_url: null };
const eggs = { id: 3, title: 'Huevos XL mixtos · Bandeja de 30', image_url: '/store-assets/diez-rios/huevos-mixtos.jpg' };
const jumbo = { id: 4, title: 'Huevos Jumbo mixtos · Bandeja de 20', image_url: 'https://cdn.example/jumbo.png' };
const priceList = 'Huevos XL mixtos · Bandeja de 30. 1 por $9.900. Huevos Jumbo mixtos · Bandeja de 20. 1 por $7.900.';

function selector({ products = [goat, cow, eggs, jumbo], cached = [], messages = [], source = 'local' } = {}) {
  const db = {
    getSetting: async () => source,
    getProducts: async () => products,
    getCachedProducts: async () => cached,
    getLastMessages: async () => messages,
  };
  const media = load('src/services/product-media.js', { '../db/database': db }, {
    process: { env: { FRONTEND_URL: 'https://tienda.example,https://otro.example' } },
  });
  return userMessage => media.suggest({ orgId: 1, conversationId: 2, userMessage, response: priceList });
}

test('consultas de precio reciben solo texto, aunque nombren un producto o incluyan una solicitud de foto', async () => {
  const select = selector({ products: [goat], messages: [{ content: goat.title }] });
  for (const text of ['Quiero ver los precios', '¿Cuál es el precio de los Jumbo?', '¿A cuánto el queso de cabra?',
    'Quiero ver el valor del queso', '¿Tienes foto y precio del queso de cabra?', 'Foto del queso de cabra\n¿Cuánto sale?']) {
    assert.equal(await select(text), null, text);
  }
});

test('una compra, una foto recibida o una referencia ambigua no disparan fotos', async () => {
  const select = selector({ messages: [{ content: goat.title }] });
  for (const text of ['Quiero queso de cabra', 'XL', 'Cafés', 'opción 2', 'No me envíes foto del queso de cabra',
    'Te mandé una foto del queso de cabra', 'Mándame una foto', '¿Puedo ver esa?', 'Foto de 900 g', 'Foto del queso',
    'Muéstrame los mixtos', 'Foto de los huevos negros', 'Foto del queso de oveja', 'Foto del queso de cabra y los huevos']) {
    assert.equal(await select(text), null, text);
  }
});

test('la foto corresponde a la variante pedida aunque el historial o la respuesta hablen de otros productos', async () => {
  const select = selector({ messages: [{ content: goat.title }] });
  for (const [text, product] of [
    ['Hola, ¿me puedes mandar una foto de los huevos XL mixtos de 30, por favor?', eggs],
    ['Muéstrame la bandeja Jumbo de 20', jumbo],
    ['Quisiera ver los huevos Jumbo', jumbo],
    ['¿Tienes una imagen del queso de cabra?', goat],
  ]) {
    const photo = await select(text);
    assert.equal(photo?.caption, '📷 ' + product.title, text);
    assert.equal(photo.mediaUrl, new URL(product.image_url, 'https://tienda.example').href, text);
  }
});

test('si el producto solicitado no tiene foto, solo admite la de la misma ficha del catálogo', async () => {
  assert.equal(await selector({ cached: [goat] })('Foto del queso de vaca'), null);
  const exact = { ...cow, image_url: 'https://cdn.example/vaca.jpg' };
  assert.equal((await selector({ cached: [goat, exact] })('Foto del queso de vaca')).mediaUrl, exact.image_url);
});

test('respeta fotos ya enviadas, stock y catálogo sincronizado', async () => {
  assert.equal(await selector({ messages: [{ type: 'image', media_id: goat.image_url }] })('Foto del queso de cabra'), null);
  assert.equal(await selector({ products: [{ ...goat, stock: 0 }] })('Foto del queso de cabra'), null);
  assert.equal((await selector({ source: 'shopify', cached: [goat] })('Foto del queso de cabra')).productId, goat.id);
});
