const kapsoService = require('./kapso-whatsapp');
const mediaCache = require('./media-cache');

/**
 * Obtiene los bytes de un comprobante. Kapso puede entregar una URL directa
 * firmada o un media ID; ambos formatos existen en registros reales.
 */
async function getPaymentProofMedia(orgId, mediaRef, whatsappConfig) {
  const ref = String(mediaRef || '').trim();
  if (!ref) throw new Error('El comprobante no tiene imagen asociada');
  const cacheKey = `${orgId}:${ref}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached;

  const mediaUrl = ref.startsWith('https://')
    ? ref
    : (await kapsoService.getMediaUrl(ref, whatsappConfig)).url;
  if (!mediaUrl) throw new Error('Kapso no entregó una URL para la imagen');
  const media = await kapsoService.downloadMedia(mediaUrl, whatsappConfig);
  mediaCache.set(cacheKey, media.data, media.contentType);
  return media;
}

module.exports = { getPaymentProofMedia };
