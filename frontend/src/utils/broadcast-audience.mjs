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
  const lastOrder = new Date(contact.last_order_at).getTime();
  return Number.isFinite(lastOrder) && lastOrder < now - threshold * 86400000;
}

export function selectedAudience(contacts, selected) {
  return contacts.filter(contact => selected.has(contact.phone));
}

export function purchaseAgeLabel(days) {
  if (days === 'range_7_29') return 'Entre 7 y 29 días sin comprar';
  if (days === 'range_30_60') return 'Entre 30 y 60 días sin comprar';
  return days === 'all' ? 'Todos los contactos filtrados' : `Último pedido hace más de ${days} días`;
}
