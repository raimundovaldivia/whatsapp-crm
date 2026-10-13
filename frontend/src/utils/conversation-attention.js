function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isNoResponseNeeded(value) {
  const raw = String(value || '');
  const text = normalize(raw).replace(/[¿?]/g, '').trim();
  const emoji = raw.replace(/[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\s]/gu, '');
  if (/^(?:👌|👍|🙏|✅|🙌|😊|🙂|❤️|❤)+$/u.test(emoji)) return true;
  return [
    /^(?:gracias|gracias!+|muchas gracias|mil gracias|grs|gracias gracias|grssias)[.!]*$/,
    /^(?:ok|okay|oki|listo|perfecto|super|excelente)[, .!]*(?:muchas )?gracias[.!]*$/,
    /^(?:no|nop|nope)[, .!]*(?:muchas )?gracias[.!]*$/,
    /^por ahora no(?: necesito| gracias|, gracias| necesito, gracias)?[.!]*$/,
    /^no (?:voy a querer|agendare nada|necesito por ahora)[.!]*$/,
    /^(?:yo|te|les?) aviso[.!]*$/,
    /^(?:de nada|buena|vale)[.!]*$/,
  ].some(pattern => pattern.test(text));
}

export function deriveAttentionState(conversation, now = Date.now()) {
  if (conversation?.last_message_direction === 'inbound' && isNoResponseNeeded(conversation?.last_message)) return 'no_response_needed';
  if (['coordinating', 'human'].includes(conversation?.agent_mode)) return 'requires_human';
  if (conversation?.last_message_direction === 'inbound') {
    const at = new Date(conversation.last_message_created_at || conversation.last_message_at || 0).getTime();
    return Number.isFinite(at) && now - at >= 120000 ? 'bot_unanswered' : 'waiting_bot';
  }
  if (conversation?.last_message_direction === 'outbound' && conversation?.last_message_sent_by === 'ai') return 'handled_by_bot';
  return 'waiting_customer';
}
