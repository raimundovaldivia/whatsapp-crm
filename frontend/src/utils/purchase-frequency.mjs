export const cadenceLabels = { unknown: 'Sin frecuencia', weekly: 'Hasta 10 días', fortnightly: '11 a 20 días', monthly: '21 a 40 días', occasional: 'Más de 40 días' };
export const statusLabels = { followup: 'Para seguimiento', overdue: 'Pasó su fecha estimada', due: 'Próximos 3 días', upcoming: 'Más adelante', insufficient: 'Historial insuficiente' };
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function latestConversationId(conversations) {
  const existing = conversations.filter(conversation => Number.isInteger(conversation.id) && conversation.id > 0 && Number(conversation.message_count) > 0);
  existing.sort((a, b) => (Date.parse(b.last_message_at) || 0) - (Date.parse(a.last_message_at) || 0));
  return existing[0]?.id ?? null;
}

export function filterFrequencyCustomers(customers, { search = '', status = 'all', cadence = 'all', sort = 'next' } = {}) {
  const query = normalize(search.trim());
  const digits = query.replace(/\D/g, '');
  return customers.filter(customer => (
    (!query || normalize(customer.name).includes(query) || customer.phone.includes(query) || (digits.length >= 3 && customer.phone.includes(digits)))
    && (status === 'all' || (status === 'followup' ? !customer.optedOut && ['overdue', 'due'].includes(customer.status) : customer.status === status))
    && (cadence === 'all' || customer.cadence === cadence)
  )).sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'es');
    if (sort === 'last') return (b.lastPurchase || '').localeCompare(a.lastPurchase || '') || a.name.localeCompare(b.name, 'es');
    return (a.daysUntilNext ?? Infinity) - (b.daysUntilNext ?? Infinity) || a.name.localeCompare(b.name, 'es');
  });
}
