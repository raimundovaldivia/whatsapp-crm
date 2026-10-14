const Anthropic = require('@anthropic-ai/sdk');

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const PROVIDER_ALIASES = Object.freeze({
  anthropic: 'anthropic',
  claude: 'anthropic',
  deepseek: 'deepseek',
});

function normalizeProvider(value = 'anthropic') {
  const provider = PROVIDER_ALIASES[String(value || 'anthropic').trim().toLowerCase()];
  if (!provider) {
    throw new Error('AI_PROVIDER debe ser "anthropic", "claude" o "deepseek"');
  }
  return provider;
}

function createAIProvider(env = process.env, AnthropicClient = Anthropic) {
  const provider = normalizeProvider(env.AI_PROVIDER);
  const isDeepSeek = provider === 'deepseek';
  const apiKey = isDeepSeek ? env.DEEPSEEK_API_KEY : env.ANTHROPIC_API_KEY;
  const clientOptions = { apiKey };

  if (isDeepSeek) clientOptions.baseURL = DEEPSEEK_ANTHROPIC_BASE_URL;

  let sdkClient = null;
  const client = {
    messages: {
      async create(request) {
        if (!apiKey) {
          const variable = isDeepSeek ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY';
          throw new Error(`${variable} no está configurada para AI_PROVIDER=${provider}`);
        }
        if (!sdkClient) sdkClient = new AnthropicClient(clientOptions);
        return sdkClient.messages.create(request);
      },
    },
  };
  const fastModel = isDeepSeek
    ? (env.DEEPSEEK_FAST_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash')
    : (env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001');
  const smartModel = isDeepSeek
    ? (env.DEEPSEEK_SMART_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash')
    : (env.ANTHROPIC_SMART_MODEL || 'claude-sonnet-4-6');
  const visionModel = isDeepSeek
    ? (env.DEEPSEEK_VISION_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash')
    : (env.ANTHROPIC_VISION_MODEL || env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001');

  return {
    provider,
    client,
    modelFor(tier = 'smart') {
      if (tier === 'fast') return fastModel;
      if (tier === 'vision') return visionModel;
      return smartModel;
    },
  };
}

const activeProvider = createAIProvider();

module.exports = {
  ...activeProvider,
  createAIProvider,
  normalizeProvider,
  DEEPSEEK_ANTHROPIC_BASE_URL,
};
