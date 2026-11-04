const timeZone = 'America/Santiago';
export function toChileInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function fromChileInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Selecciona fecha y hora de Chile');
  const candidates = ['-03:00', '-04:00'].map(offset => new Date(`${value}:00${offset}`))
    .filter(d => Number.isFinite(d.getTime()) && toChileInput(d) === value);
  if (candidates.length !== 1) throw new Error('Esa hora no existe o se repite por el cambio de hora de Chile. Elige otra hora.');
  return candidates[0].toISOString();
}
export const formatChile = iso => new Date(iso).toLocaleString('es-CL', { timeZone, dateStyle: 'short', timeStyle: 'short' });
