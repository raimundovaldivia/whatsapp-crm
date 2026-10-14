const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function loadProvider(env) {
  const constructorOptions = [];
  const requests = [];
  class Anthropic {
    constructor(options) {
      constructorOptions.push(options);
      this.messages = { create: async request => {
        requests.push(request);
        return { content: [{ text: 'ok' }] };
      } };
    }
  }
  const provider = load('src/services/ai-provider.js', { '@anthropic-ai/sdk': Anthropic }, { process: { env } });
  return { provider, constructorOptions, requests };
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
  const { provider, constructorOptions, requests } = loadProvider({
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
  assert.equal(constructorOptions[0].timeout, 30000);
  assert.equal(constructorOptions[0].maxRetries, 1);
  assert.equal(requests[0].reasoning.effort, 'none');
  assert.equal(requests[0].max_tokens, 1024);
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
  assert.equal(requests[0].reasoning.effort, 'none');
  assert.equal(requests[0].max_tokens, 1024);
});

test('el agente de ventas limita el nombre autorizado y el dialecto en el prompt', async () => {
  const requests = [];
  class Anthropic {
    constructor() {
      this.messages = { create: async request => {
        requests.push(request);
        return { content: [{ type: 'text', text: 'Respuesta segura' }] };
      } };
    }
  }
  const sales = load('src/services/agents/sales.js', { '@anthropic-ai/sdk': Anthropic }, {
    process: { env: { ANTHROPIC_API_KEY: 'test-key' } },
  });
  await sales.generateSalesResponse(
    [{ direction: 'outbound', content: 'Hola Hilda' }],
    '¿Tienen Jumbo?',
    'Huevos Jumbo — $12.000',
    '',
    { customerName: 'Karen' },
  );
  assert.match(requests[0].system, /NOMBRE AUTORIZADO: Karen/);
  assert.match(requests[0].system, /Nunca inventes/);
  assert.match(requests[0].system, /español chileno neutro/i);
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

test('responseText ignora bloques de razonamiento y encuentra el texto visible', () => {
  const { provider } = loadProvider({ ANTHROPIC_API_KEY: 'anthropic-test-key' });
  assert.equal(provider.responseText({ content: [
    { type: 'thinking', thinking: 'interno' },
    { type: 'text', text: 'Respuesta visible' },
  ] }), 'Respuesta visible');
});

test('DeepSeek reintenta una respuesta vacía antes de devolverla', async () => {
  let calls = 0;
  class Anthropic {
    constructor() {
      this.messages = { create: async () => {
        calls += 1;
        return calls === 1
          ? { content: [{ type: 'text', text: '' }] }
          : { content: [{ type: 'text', text: 'Respuesta recuperada' }] };
      } };
    }
  }
  const provider = load('src/services/ai-provider.js', { '@anthropic-ai/sdk': Anthropic }, {
    process: { env: { AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test-key' } },
  });

  const response = await provider.client.messages.create({ messages: [] });
  assert.equal(provider.responseText(response), 'Respuesta recuperada');
  assert.equal(calls, 2);
});

test('DeepSeek falla explícitamente si ambos intentos llegan vacíos', async () => {
  class Anthropic {
    constructor() {
      this.messages = { create: async () => ({ content: [{ type: 'text', text: '' }] }) };
    }
  }
  const provider = load('src/services/ai-provider.js', { '@anthropic-ai/sdk': Anthropic }, {
    process: { env: { AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test-key' } },
  });

  await assert.rejects(
    provider.client.messages.create({ messages: [] }),
    /respuesta vacía después de reintentar/,
  );
});
