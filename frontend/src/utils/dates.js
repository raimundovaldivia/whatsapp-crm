/**
 * Utilidades de fecha simples (sin dependencias externas)
 */

export function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleString('es', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now  = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diff = Math.floor((now - then) / 1000); // segundos

  if (diff < 60)          return 'ahora';
  if (diff < 3600)        return `${Math.floor(diff / 60)} min`;
  if (diff < 86400)       return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7)   return `${Math.floor(diff / 86400)} d`;
  if (diff < 86400 * 30)  return `${Math.floor(diff / 86400 / 7)} sem`;
  return new Date(dateStr).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}
