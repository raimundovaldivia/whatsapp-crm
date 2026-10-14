const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function loadProvider(env) {
  const constructorOptions = [];
  class Anthropic {
    constructor(options) {
      constructorOptions.push(options);
      this.messages = { create: async () => ({ content: [{ text: 'ok' }] }) };
    }
  }
  const provider = load('src/services/ai-provider.js', { '@anthropic-ai/sdk': Anthropic }, { process: { env } });
  return { provider, constructorOptions };
}

test('Claude sigue siendo el proveedor de IA predeterminado', async () => {
  const { provider, constructorOptions } = loadProvider({ ANTHROPIC_API_KEY: 'anthropic-test-key' });
  await provider.client.messages.create({ messages: [] });

  assert.equal(provider.provider, 'anthropic');
  assert.equal(constructorOptions.length, 1);
  assert.equal(constructorOptions[0].apiKey, 'anthropic-test-key');
  assert.equal(constructorOptions[0].baseURL, undefined);
  assert.equal(provider.modelFor('fast'), 'claude-haiku-4-5-20251001');
  assert.equal(provider.modelFor('smart'), 'claude-sonnet-4-6');
  assert.equal(provider.modelFor('vision'), 'claude-haiku-4-5-20251001');
});

test('DeepSeek usa su clave, endpoint Anthropic oficial y modelos configurables', async () => {
  const { provider, constructorOptions } = loadProvider({
    AI_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'deepseek-test-key',
    DEEPSEEK_FAST_MODEL: 'deepseek-fast-test',
    DEEPSEEK_SMART_MODEL: 'deepseek-smart-test',
    DEEPSEEK_VISION_MODEL: 'deepseek-vision-test',
  });
  await provider.client.messages.create({ messages: [] });

  assert.equal(provider.provider, 'deepseek');
  assert.equal(constructorOptions.length, 1);
  assert.equal(constructorOptions[0].apiKey, 'deepseek-test-key');
  assert.equal(constructorOptions[0].baseURL, 'https://api.deepseek.com/anthropic');
  assert.equal(provider.modelFor('fast'), 'deepseek-fast-test');
  assert.equal(provider.modelFor('smart'), 'deepseek-smart-test');
  assert.equal(provider.modelFor('vision'), 'deepseek-vision-test');
});

test('un proveedor desconocido falla cerrado y no cae silenciosamente en Claude', () => {
  assert.throws(
    () => loadProvider({ AI_PROVIDER: 'otro', ANTHROPIC_API_KEY: 'secret' }),
    /AI_PROVIDER debe ser/,
  );
});

test('DeepSeek sin clave falla antes de construir el SDK y no reutiliza la clave de Claude', async () => {
  const { provider, constructorOptions } = loadProvider({
    AI_PROVIDER: 'deepseek',
    ANTHROPIC_API_KEY: 'anthropic-secret-that-must-not-leave',
  });

  await assert.rejects(
    provider.client.messages.create({ messages: [] }),
    /DEEPSEEK_API_KEY no está configurada/,
  );
  assert.equal(constructorOptions.length, 0);
});

test('el agente de ventas envía la respuesta por DeepSeek cuando está seleccionado', async () => {
  const constructorOptions = [];
  const requests = [];
  class Anthropic {
    constructor(options) {
      constructorOptions.push(options);
      this.messages = {
        create: async request => {
          requests.push(request);
          return { content: [{ text: 'Respuesta desde el proveedor configurado' }] };
        },
      };
    }
  }

  const sales = load('src/services/agents/sales.js', { '@anthropic-ai/sdk': Anthropic }, {
    process: { env: { AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test-key' } },
  });
  const response = await sales.generateSalesResponse([], '¿Cuánto cuestan los huevos?', 'Huevos XL — $12.000');

  assert.equal(response, 'Respuesta desde el proveedor configurado');
  assert.equal(constructorOptions[0].baseURL, 'https://api.deepseek.com/anthropic');
  assert.equal(requests[0].model, 'deepseek-flash');
});

test('el análisis visual usa DeepSeek y conserva el bloque de imagen Anthropic-compatible', async () => {
  const constructorOptions = [];
  const requests = [];
  class Anthropic {
    constructor(options) {
      constructorOptions.push(options);
      this.messages = {
        create: async request => {
          requests.push(request);
          return { content: [{ text: '{"is_payment_proof":false,"confidence":"high"}' }] };
        },
      };
    }
  }

  const proof = load('src/services/analyzePaymentProof.js', { '@anthropic-ai/sdk': Anthropic }, {
    process: { env: { AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test-key' } },
  });
  const result = await proof.analyzePaymentProof(Buffer.from('fake-image'), 'image/png');

  assert.equal(result.is_payment_proof, false);
  assert.equal(constructorOptions[0].baseURL, 'https://api.deepseek.com/anthropic');
  assert.equal(requests[0].model, 'deepseek-flash');
  assert.equal(requests[0].messages[0].content[0].type, 'image');
  assert.equal(requests[0].messages[0].content[0].source.media_type, 'image/png');
});
