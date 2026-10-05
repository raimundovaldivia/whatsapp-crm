export function matchesPurchaseAge(contact, days, now = Date.now()) {
  if (days === 'all') return true;
  const threshold = Number(days);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 3650) return false;
  if (!contact.last_order_at) return false;
  const lastOrder = new Date(contact.last_order_at).getTime();
  return Number.isFinite(lastOrder) && lastOrder < now - threshold * 86400000;
}

export function selectedAudience(contacts, selected) {
  return contacts.filter(contact => selected.has(contact.phone));
}
