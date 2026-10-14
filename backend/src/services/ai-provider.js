const Anthropic = require('@anthropic-ai/sdk');

const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const PROVIDER_ALIASES = Object.freeze({
  anthropic: 'anthropic',
  claude: 'anthropic',
  deepseek: 'deepseek',
});

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProvider(value = 'anthropic') {
  const provider = PROVIDER_ALIASES[String(value || 'anthropic').trim().toLowerCase()];
  if (!provider) {
    throw new Error('AI_PROVIDER debe ser "anthropic", "claude" o "deepseek"');
  }
  return provider;
}

function responseText(response, fallback = '') {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const text = blocks
    .filter(block => block?.type === 'text' || typeof block?.text === 'string')
    .map(block => typeof block.text === 'string' ? block.text : '')
    .join('')
    .trim();
  return text || fallback;
}

function hasUsableResponse(response) {
  if (responseText(response)) return true;
  return Array.isArray(response?.content)
    && response.content.some(block => block?.type === 'tool_use');
}

function responseSummary(response) {
  return {
    contentType: Array.isArray(response?.content) ? 'array' : typeof response?.content,
    blockTypes: Array.isArray(response?.content)
      ? response.content.map(block => block?.type || typeof block)
      : [],
    stopReason: response?.stop_reason || null,
    outputTokens: response?.usage?.output_tokens ?? null,
  };
}

function createAIProvider(env = process.env, AnthropicClient = Anthropic) {
  const provider = normalizeProvider(env.AI_PROVIDER);
  const isDeepSeek = provider === 'deepseek';
  const apiKey = isDeepSeek ? env.DEEPSEEK_API_KEY : env.ANTHROPIC_API_KEY;
  const clientOptions = { apiKey };

  if (isDeepSeek) {
    clientOptions.baseURL = DEEPSEEK_ANTHROPIC_BASE_URL;
    clientOptions.timeout = positiveInteger(env.DEEPSEEK_TIMEOUT_MS, 30000);
    clientOptions.maxRetries = positiveInteger(env.DEEPSEEK_MAX_RETRIES, 1);
  }

  let sdkClient = null;
  const client = {
    messages: {
      async create(request) {
        if (!apiKey) {
          const variable = isDeepSeek ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY';
          throw new Error(`${variable} no está configurada para AI_PROVIDER=${provider}`);
        }
        if (!sdkClient) sdkClient = new AnthropicClient(clientOptions);
        const providerRequest = isDeepSeek
          ? {
              ...request,
              max_tokens: Math.max(
                positiveInteger(request?.max_tokens, 1),
                positiveInteger(env.DEEPSEEK_MIN_OUTPUT_TOKENS, 1024),
              ),
              reasoning: { effort: 'none' },
            }
          : request;
        const response = await sdkClient.messages.create(providerRequest);
        if (!isDeepSeek || hasUsableResponse(response)) return response;

        // DeepSeek can occasionally complete a request without a visible text
        // block. A successful-but-empty response must never reach WhatsApp.
        console.warn('[DeepSeekEmptyResponse] primer intento', JSON.stringify(responseSummary(response)));
        const retry = await sdkClient.messages.create({
          ...providerRequest,
          max_tokens: Math.max(providerRequest.max_tokens, 2048),
        });
        if (!hasUsableResponse(retry)) {
          console.warn('[DeepSeekEmptyResponse] segundo intento', JSON.stringify(responseSummary(retry)));
          throw new Error('DeepSeek devolvió una respuesta vacía después de reintentar');
        }
        return retry;
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
  responseText,
  DEEPSEEK_ANTHROPIC_BASE_URL,
};
