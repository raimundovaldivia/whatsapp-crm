const FOLLOW_UP_STATES = new Set(['interested', 'collecting_order']);

// Only unresolved sales conversations can appear in Seguimiento.
export function isStalledConversation(conversation, now = Date.now()) {
  const age = now - new Date(conversation.last_message_at).getTime();
  return Boolean(conversation.last_message)
    && FOLLOW_UP_STATES.has(conversation.pipeline_state)
    && conversation.agent_mode === 'ai'
    && conversation.last_message_direction === 'outbound'
    && Number(conversation.follow_up_count || 0) < 2
    && (!conversation.follow_up_stage || conversation.follow_up_stage !== conversation.pipeline_state)
    && conversation.attention_state !== 'no_response_needed'
    && age >= 2 * 3600000 && age <= 22 * 3600000;
}
