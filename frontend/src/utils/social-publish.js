export const SOCIAL_NAMES = { facebook: 'Facebook', instagram: 'Instagram' };

export function socialTargets(platform) {
  if (platform === 'both') return ['facebook', 'instagram'];
  if (Object.hasOwn(SOCIAL_NAMES, platform)) return [platform];
  throw new Error('Elige Facebook, Instagram o ambas redes.');
}

export function validateSocialDraft(draft) {
  const targets = socialTargets(draft.platform);
  if (!draft.message?.trim() && !draft.mediaUrl?.trim()) return 'Agrega un texto o una imagen.';
  if (targets.includes('instagram') && !draft.mediaUrl?.trim()) return 'Instagram necesita una imagen o un video.';
  return '';
}

// Keep each network's outcome: a timeout can occur after Meta has published.
export function createSocialPublisher(send) {
  let inFlight = null;
  return (draft, previous = {}) => {
    if (inFlight) return inFlight;
    const validation = validateSocialDraft(draft);
    if (validation) return Promise.reject(new Error(validation));
    const targets = socialTargets(draft.platform);
    const results = { ...previous };
    const pending = targets.filter(platform => !previous[platform] || previous[platform].state === 'failed');
    inFlight = Promise.all(pending.map(async platform => {
      try {
        const result = await send({ platform, message: draft.message, mediaUrl: draft.mediaUrl, mediaType: draft.mediaType });
        results[platform] = result?.success === true && result.id
          ? { state: 'published', id: String(result.id) }
          : { state: 'unknown', error: 'La red no devolvió una confirmación de publicación.' };
      } catch (error) {
        const status = error.response?.status;
        const rejected = status >= 400 && status < 500 && status !== 408;
        results[platform] = {
          state: rejected ? 'failed' : 'unknown',
          error: error.response?.data?.error || error.message || 'No se pudo confirmar la publicación.',
        };
      }
    })).then(() => results).finally(() => { inFlight = null; });
    return inFlight;
  };
}
