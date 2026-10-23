import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStalledConversation } from './contact-followup.mjs';

test('Seguimiento supports unfinished sales without crashing the inbox or including closed conversations', () => {
  const now = Date.parse('2026-10-23T15:00:00Z');
  const conversation = { last_message: '¿Confirmamos?', last_message_at: '2026-10-23T12:00:00Z', pipeline_state: 'collecting_order', agent_mode: 'ai', last_message_direction: 'outbound' };
  assert.equal(isStalledConversation(conversation, now), true);
  for (const patch of [{pipeline_state:'opted_out'}, {pipeline_state:'awaiting_payment'}, {pipeline_state:'done'}, {agent_mode:'human'}, {last_message_direction:'inbound'}, {follow_up_count:2}, {follow_up_stage:'collecting_order'}, {attention_state:'no_response_needed'}, {last_message_at:'2026-10-23T14:59:00Z'}, {last_message_at:'2026-10-21T12:00:00Z'}]) {
    assert.equal(isStalledConversation({...conversation,...patch}, now), false);
  }
});
