function crmOrderLabel(id) {
  const value = String(id ?? '').trim();
  return value ? `#DR-${value}` : '#DR';
}

function normalizeOrderLabel(label, source, id) {
  if (source === 'bot') return crmOrderLabel(id);
  const value = String(label || '').trim();
  return value.replace(/^#BOT-(\d+)$/i, '#DR-$1');
}

module.exports = { crmOrderLabel, normalizeOrderLabel };
