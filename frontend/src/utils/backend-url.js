export function resolveBackendUrl(value, origin = globalThis.location?.origin) {
  if (value === 'same-origin') {
    if (!origin || !/^https?:\/\//.test(origin)) throw new Error('Origen del sandbox inválido');
    return origin;
  }
  return value || 'http://localhost:3001';
}
export const BACKEND_URL = resolveBackendUrl(import.meta.env?.VITE_BACKEND_URL);
