/**
 * media-cache.js — Cache en memoria para media de WhatsApp/Kapso
 *
 * Problema: las Active Storage URLs de Kapso redirigen a S3 pre-signed URLs
 * que expiran ~5 minutos después de generarse. El webhook descarga la imagen
 * exitosamente, pero cuando el browser pide el proxy (segundos/minutos después),
 * la URL S3 ya expiró.
 *
 * Solución: guardar los bytes descargados en memoria, indexados por mediaRef.
 * El proxy sirve desde cache si está disponible; si no, intenta descargar de nuevo.
 *
 * TTL: 30 minutos. Máximo 50 entradas (evitar OOM en Railway free tier ~512MB).
 */

const MAX_ENTRIES = 50;
const TTL_MS      = 30 * 60 * 1000; // 30 minutos

// Map<mediaRef, { data: Buffer, contentType: string, ts: number }>
const cache = new Map();

function set(mediaRef, data, contentType) {
  if (!mediaRef || !data) return;

  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  cache.set(mediaRef, {
    data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    contentType: contentType || 'image/jpeg',
    ts: Date.now(),
  });
  console.log(`[MediaCache] Cached ${mediaRef?.slice(0, 60)} | ${data.byteLength || data.length} bytes`);
}

function get(mediaRef) {
  const entry = cache.get(mediaRef);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(mediaRef);
    return null;
  }
  return entry;
}

function size() { return cache.size; }

module.exports = { set, get, size };
