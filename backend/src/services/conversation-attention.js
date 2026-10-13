const { isNoResponseNeeded } = require('./inbound-message-policy');

function deriveAttentionState(conversation, now = Date.now()) {
  const direction = conversation?.last_message_direction;
  if (direction === 'inbound' && isNoResponseNeeded(conversation?.last_message)) {
    return 'no_response_needed';
  }
  if (['coordinating', 'human'].includes(conversation?.agent_mode)) return 'requires_human';
  if (direction === 'inbound') {
    const sentAt = new Date(conversation?.last_message_created_at || conversation?.last_message_at || 0).getTime();
    return Number.isFinite(sentAt) && now - sentAt >= 2 * 60 * 1000 ? 'bot_unanswered' : 'waiting_bot';
  }
  if (direction === 'outbound' && conversation?.last_message_sent_by === 'ai') return 'handled_by_bot';
  return 'waiting_customer';
}

function withAttentionState(conversation, now = Date.now()) {
  return conversation ? { ...conversation, attention_state: deriveAttentionState(conversation, now) } : conversation;
}

module.exports = { deriveAttentionState, withAttentionState };
