function chileBusinessDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function shiftBusinessDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function matchesPurchaseAge(contact, days, now = Date.now()) {
  if (days === 'all') return true;
  const range = { 'range_7_29': [7, 30], 'range_30_60': [30, 61] }[days];
  if (range) {
    if (!contact.last_order_at) return false;
    const age = (now - new Date(contact.last_order_at).getTime()) / 86400000;
    return Number.isFinite(age) && age >= range[0] && age < range[1];
  }
  const threshold = Number(days);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 3650) return false;
  if (!contact.last_order_at) return false;
  const lastOrderDate = chileBusinessDate(contact.last_order_at);
  const today = chileBusinessDate(now);
  const cutoff = today ? shiftBusinessDate(today, -threshold) : null;
  // “Más de N días” excluye el mismo día comercial de corte.
  return Boolean(lastOrderDate && cutoff && lastOrderDate < cutoff);
}
export function selectedAudience(contacts, selected) {
  return contacts.filter(contact => selected.has(contact.phone));
}

// Deja solo las N personas con compra más reciente (las sin compras van al final).
export function limitToMostRecent(contacts, limit) {
  const max = Number(limit);
  if (!Number.isInteger(max) || max < 1) return contacts;
  const time = c => (c.last_order_at ? new Date(c.last_order_at).getTime() : 0) || 0;
  return [...contacts].sort((a, b) => time(b) - time(a)).slice(0, max);
}

export function purchaseAgeLabel(days) {
  if (days === 'range_7_29') return 'Entre 7 y 29 días sin comprar';
  if (days === 'range_30_60') return 'Entre 30 y 60 días sin comprar';
  return days === 'all' ? 'Todos los contactos filtrados' : `Último pedido hace más de ${days} días`;
}
