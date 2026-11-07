export const cadenceLabels = { unknown: 'Sin frecuencia', weekly: 'Hasta 10 días', fortnightly: '11 a 20 días', monthly: '21 a 40 días', occasional: 'Más de 40 días' };
export const statusLabels = { followup: 'Para seguimiento', pending_dispatch: 'Pedido pendiente de entrega', overdue: 'Pasó su fecha estimada', due: 'Próximos 3 días', upcoming: 'Más adelante', insufficient: 'Historial insuficiente' };
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const FREQUENCY_FOLLOWUP_INSTRUCTION = 'Escribe un WhatsApp breve, cercano y conversacional, con saludos y cierres variados, sin encabezados, listas ni tono de plantilla. Mantén los productos, presentaciones y cantidades exactas de la última compra registrada. Usa la frecuencia solo para adaptar la pregunta. Si el historial es insuficiente o variable, no atribuyas hábitos. No cambies bandejas por cajas, no conviertas unidades ni agregues productos de compras anteriores. No supongas gustos, consumo, entrega, confianza previa ni necesidad de reposición. Sin ofertas ni compromisos de disponibilidad. Si el detalle está incompleto, excluye el borrador para revisión.';

export function purchaseProductLabel(item) {
  const quantity = Number.isFinite(item?.cantidad) && item.cantidad > 0
    ? item.cantidad.toLocaleString('es-CL', { useGrouping: false, maximumFractionDigits: 20 }) : 'Cantidad sin registro';
  return `${quantity} × ${item?.producto || 'Producto sin registro'}`;
}

export function frequencyDraftRequest(phones) {
  return { phones: [...phones], instruction: FREQUENCY_FOLLOWUP_INSTRUCTION, audienceType: 'all', contextSource: 'purchase_frequency' };
}

export function selectableFrequencyCustomers(customers) {
  const blocked = new Set(customers.filter(customer => customer.optedOut || customer.status === 'pending_dispatch').map(customer => customer.phone));
  const seen = new Set();
  return customers.filter(customer => {
    if (!/^\d{8,15}$/.test(customer.phone) || blocked.has(customer.phone) || seen.has(customer.phone)) return false;
    seen.add(customer.phone);
    return true;
  });
}

export function toggleFrequencySelection(selected, customers) {
  const eligible = selectableFrequencyCustomers(customers);
  const remove = eligible.every(customer => selected.has(customer.phone));
  const next = new Set(selected);
  for (const customer of eligible) {
    if (remove) next.delete(customer.phone);
    else next.add(customer.phone);
  }
  return next;
}

// Resolve only explicitly chosen phones against freshly loaded tenant data.
// An empty/missing selection must never become the entire customer list.
export function frequencyBroadcastContacts(customers, phones = []) {
  const chosen = new Set(phones);
  return selectableFrequencyCustomers(customers).filter(customer => chosen.has(customer.phone)).map(customer => ({
    phone: customer.phone, name: customer.name, contact_type: 'customer',
    total_orders: customer.purchaseCount, opt_out: false, source: 'frecuencia',
    // Noon UTC preserves a date-only Chilean business date in existing formatters.
    last_order_at: customer.lastPurchase ? `${customer.lastPurchase}T12:00:00Z` : null,
  }));
}

export function initialEvolutionMethod(methods) {
  const available = methods.filter(method => method.provider === 'evolution' && method.available && method.channelId);
  return available.length === 1 ? `evolution:${available[0].channelId}` : 'evolution:pending';
}

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
