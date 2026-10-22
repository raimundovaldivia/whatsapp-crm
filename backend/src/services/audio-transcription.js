const PROVIDERS = Object.freeze({
  openai: 'openai',
  whisper: 'openai',
});

function normalizeProvider(value = 'openai') {
  const provider = PROVIDERS[String(value || 'openai').trim().toLowerCase()];
  if (!provider) throw new Error('AUDIO_TRANSCRIPTION_PROVIDER debe ser "openai" o "whisper"');
  return provider;
}

function isConfigured(env = process.env) {
  try {
    return normalizeProvider(env.AUDIO_TRANSCRIPTION_PROVIDER) === 'openai' && Boolean(env.OPENAI_API_KEY);
  } catch (_) {
    return false;
  }
}

function extensionFor(contentType = '') {
  if (/mpeg|mp3/.test(contentType)) return 'mp3';
  if (/wav/.test(contentType)) return 'wav';
  if (/webm/.test(contentType)) return 'webm';
  if (/ogg|opus/.test(contentType)) return 'ogg';
  if (/mp4|m4a|aac/.test(contentType)) return 'm4a';
  return 'ogg';
}

async function transcribeBuffer(data, contentType = 'audio/ogg', options = {}) {
  const env = options.env || process.env;
  const provider = normalizeProvider(env.AUDIO_TRANSCRIPTION_PROVIDER);
  if (provider !== 'openai' || !env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY no está configurada para transcribir audios');
  }

  const fetchImpl = options.fetchImpl || fetch;
  const FormDataImpl = options.FormDataImpl || FormData;
  const BlobImpl = options.BlobImpl || Blob;
  const AbortSignalImpl = options.AbortSignalImpl || AbortSignal;
  const form = new FormDataImpl();
  form.append('file', new BlobImpl([Buffer.from(data)], { type: contentType || 'audio/ogg' }), `audio.${extensionFor(contentType)}`);
  form.append('model', env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');
  form.append('language', env.AUDIO_TRANSCRIPTION_LANGUAGE || 'es');

  const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignalImpl.timeout(45000),
  });
  if (!response.ok) throw new Error(`Transcripción de audio HTTP ${response.status}`);
  const json = await response.json();
  return String(json.text || '').trim() || null;
}

module.exports = { isConfigured, transcribeBuffer, normalizeProvider, extensionFor };
