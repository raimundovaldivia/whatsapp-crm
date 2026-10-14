const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db/database');
const commercial = require('../src/services/commercial');
const sales = require('../src/services/agents/sales');
const socialBot = require('../src/services/social-bot');

test('Diva responde mensajes sociales con catálogo y reglas específicas del canal', async () => {
  const originals = {
    consumeBotTurn: commercial.consumeBotTurn,
    getSetting: db.getSetting,
    getCachedProducts: db.getCachedProducts,
    getProducts: db.getProducts,
    generateSalesResponse: sales.generateSalesResponse,
  };
  let receivedPrompt = '';
  try {
    commercial.consumeBotTurn = async orgId => assert.equal(orgId, 7);
    db.getSetting = async (_orgId, key) => ({
      catalog_source: 'local',
      store_public_url: 'https://tienda.example',
      store_context: 'Huevos Diez Ríos',
      ai_system_prompt_extra: 'No inventar precios.',
      delivery_info: JSON.stringify({ zone: 'Paine', schedule: 'lunes a sábado' }),
    })[key] || '';
    db.getCachedProducts = async () => [];
    db.getProducts = async () => [{ id: 1, title: 'Huevos L', price: 6000, stock: 12, is_business: false }];
    sales.generateSalesResponse = async (_history, message, catalog, prompt) => {
      assert.equal(message, '¿Cuánto cuestan?');
      assert.match(catalog, /Huevos L/);
      receivedPrompt = prompt;
      return 'La bandeja cuesta $6.000.';
    };
    const direct = await socialBot.generateSocialReply({ orgId: 7, channel: 'instagram', content: '¿Cuánto cuestan?' });
    assert.equal(direct.response, 'La bandeja cuesta $6.000.');
    assert.match(receivedPrompt, /mensaje privado de Instagram/);
    assert.match(receivedPrompt, /https:\/\/tienda\.example/);

    await socialBot.generateSocialReply({ orgId: 7, channel: 'facebook_comment', content: '¿Cuánto cuestan?' });
    assert.match(receivedPrompt, /comentario público de Facebook/);
    assert.match(receivedPrompt, /Nunca publiques datos personales/);
  } finally {
    Object.assign(commercial, { consumeBotTurn: originals.consumeBotTurn });
    Object.assign(db, { getSetting: originals.getSetting, getCachedProducts: originals.getCachedProducts, getProducts: originals.getProducts });
    Object.assign(sales, { generateSalesResponse: originals.generateSalesResponse });
  }
});

test('Diva no responde si Ventas con IA no está disponible', async () => {
  const original = commercial.consumeBotTurn;
  try {
    commercial.consumeBotTurn = async () => { throw Object.assign(new Error('sin módulo'), { status: 403, code: 'MODULE_NOT_ACTIVE' }); };
    const result = await socialBot.generateSocialReply({ orgId: 8, channel: 'instagram', content: 'hola' });
    assert.deepEqual(result, { skipped: true, reason: 'MODULE_NOT_ACTIVE' });
  } finally {
    commercial.consumeBotTurn = original;
  }
});
