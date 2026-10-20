export function crmOrderLabel(id) {
  const value = String(id ?? '').trim();
  return value ? `#DR-${value}` : '#DR';
}

export function orderLabel({ source, id, label } = {}) {
  if (source === 'bot') return crmOrderLabel(id);
  return String(label || '').replace(/^#BOT-(\d+)$/i, '#DR-$1');
}
