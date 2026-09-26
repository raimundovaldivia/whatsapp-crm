// The webhook may already have persisted the current inbound message.
// Only deduplicate that final turn; repeated answers earlier in the chat matter.
function buildMessages(history, userMessage, limit = 12) {
  const messages = (Array.isArray(history) ? history : [])
    .filter(m => m && ['inbound', 'outbound'].includes(m.direction)
      && typeof m.content === 'string' && m.content.trim())
    .slice(-limit)
    .map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || last.content.trim() !== userMessage.trim()) {
    messages.push({ role: 'user', content: userMessage });
  }
  return messages;
}

module.exports = { buildMessages };
