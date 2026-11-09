const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

const goat = { id: 1, title: 'Queso de Cabra Fresco Pasteurizado – 900 g–1 kg', image_url: 'https://cdn.example/cabra.jpg' };
const cow = { id: 2, title: 'Queso de Vaca Artesanal – 900 g', image_url: null };
const eggs = { id: 3, title: 'Huevos XL mixtos · Bandeja de 30', image_url: '/store-assets/diez-rios/huevos-mixtos.jpg' };
const jumbo = { id: 4, title: 'Huevos Jumbo mixtos · Bandeja de 20', image_url: 'https://cdn.example/jumbo.png' };

function photoChat({ products = [goat, cow, eggs, jumbo], cached = [], messages = [], source = 'local' } = {}) {
  const db = {
    getSetting: async () => source,
    getProducts: async () => products,
    getCachedProducts: async () => cached,
    getLastMessages: async () => messages,
  };
  const media = load('src/services/product-media.js', { '../db/database': db }, {
    process: { env: { FRONTEND_URL: 'https://tienda.example,https://otro.example' } },
  });
  return userMessage => media.photoTurn({ orgId: 1, history: messages, userMessage });
}

function selector(options) {
  const turn = photoChat(options);
  return async text => (await turn(text))?.productMedia || null;
}

function recordReply(messages, reply) {
  messages.push({ direction: 'outbound', content: reply.response, sent_by: 'ai', prompt_version: reply.promptVersion });
}

test('pide elegir, acepta nombre, número u ordinal y envía la foto elegida sin iniciar un pedido', async () => {
  for (const answer of ['la segunda', '2', 'opción 2', 'el de vaca', 'quiero el de vaca por favor', 'foto de la segunda']) {
    const messages = [];
    const turn = photoChat({ messages, cached: [{ ...cow, image_url: 'https://cdn.example/vaca.jpg' }] });
    const menu = await turn('¿Me envías una foto del queso?');
    assert.ok(!menu.productMedia);
    assert.match(menu.response, /1\. Queso de Cabra/);
    assert.match(menu.response, /2\. Queso de Vaca/);
    recordReply(messages, menu);
    const selected = await turn(answer);
    assert.equal(selected?.productMedia?.productId, cow.id, answer);
    recordReply(messages, selected);
    assert.equal(await turn('2'), null);
  }
});

test('el pipeline atiende la elección de foto antes de clasificar la respuesta como una compra', async () => {
  const history = [];
  const db = {
    getSetting: async (_, key) => key === 'catalog_source' ? 'local' : null,
    getLastMessages: async () => history,
    getConversationById: async () => ({ id: 2, pipeline_state: 'exploring' }),
    getProducts: async () => [goat, cow],
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './product-media': load('src/services/product-media.js', { '../db/database': db }),
    './commercial': { consumeBotTurn: async () => {} },
  });
  const question = await pipeline.processMessage(1, 2, 'Foto del queso');
  recordReply(history, question);
  const reply = await pipeline.processMessage(1, 2, 'la primera');
  assert.equal(reply.productMedia.productId, goat.id);
  assert.equal(reply.newState, 'exploring');
  assert.equal(reply.orderCreated, undefined);
});

test('la lista conserva el orden ofrecido y se puede acotar en más de un turno', async () => {
  const messages = [];
  const products = [goat, eggs, jumbo];
  const turn = photoChat({ messages, products });
  const all = await turn('¿Me mandas una foto?');
  recordReply(messages, all);
  products.reverse();
  const trays = await turn('los huevos');
  assert.match(trays.response, /1\. Huevos/);
  assert.doesNotMatch(trays.response, /Queso/);
  recordReply(messages, trays);
  const chosen = trays.response.split('\n')[1].includes('Jumbo') ? jumbo : eggs;
  products.reverse();
  assert.equal((await turn('la primera')).productMedia.productId, chosen.id);
});

test('respeta cambios de tema, de catálogo y de interlocutor mientras espera', async () => {
  const messages = [];
  const products = [goat, cow, eggs, jumbo];
  const turn = photoChat({ messages, products });
  const menu = await turn('foto del queso');
  recordReply(messages, menu);
  assert.equal((await turn('opción 8')).response, menu.response);
  assert.equal(await turn('¿Cuánto sale el de cabra?'), null);
  assert.equal(await turn('¿Cuándo reparten?'), null);
  assert.match((await turn('la segunda')).response, /no tengo una foto/);
  products.shift();
  assert.match((await turn('la primera')).response, /ya no está/);
  messages.push({ direction: 'outbound', sent_by: 'human', content: menu.response });
  assert.equal(await turn('2'), null);
});
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
    ['Me gustaría ver una foto del queso de cabra de 900g', goat],
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
