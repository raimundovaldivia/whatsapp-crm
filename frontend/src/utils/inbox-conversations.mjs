// Campaign offers may reserve a conversation before its first message is sent.
// Keep those records in application state; only the inbox view excludes them.
export function inboxConversations(conversations = []) {
  return conversations.filter(conversation => Boolean(
    conversation.last_message_created_at
    || conversation.last_message_direction === 'inbound'
    || conversation.last_message_direction === 'outbound'
    || String(conversation.last_message || '').trim()
  ));
}
