import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxConversations } from './inbox-conversations.mjs';

test('pending campaign conversations stay out of the inbox despite creation time or flags', () => {
  const pending = {
    id: 10, whatsapp_provider: 'evolution', last_message_at: '2026-10-20T14:25:44Z',
    created_at: '2026-10-20T14:25:44Z', agent_mode: 'ai', is_pinned: true,
    unread_count: 1, last_message: null, last_message_direction: null, last_message_created_at: null,
  };
  assert.deepEqual(inboxConversations([pending]), []);
  assert.deepEqual(inboxConversations([{ ...pending, last_message: ' \n ' }]), []);
  assert.equal(pending.unread_count, 1, 'visibility does not mutate the stored conversation');
});

test('real inbound and outbound messages remain visible, including media without preview text', () => {
  const messages = [
    { id: 1, last_message: 'Oferta personal enviada', last_message_direction: 'outbound' },
    { id: 2, last_message: '', last_message_direction: 'inbound', last_message_created_at: '2026-10-20T14:30:00Z' },
    { id: 3, last_message: null, last_message_created_at: '2026-10-20T14:31:00Z' },
    { id: 4, last_message: 'Mensaje guardado desde un cliente anterior' },
  ];
  assert.deepEqual(inboxConversations(messages), messages);
});

test('first saved message reveals its existing chat without changing source data or order', () => {
  const first = { id: 1, last_message: 'Consulta previa', whatsapp_channel_id: 1 };
  const pending = { id: 2, last_message: null, whatsapp_channel_id: 2 };
  const original = Object.freeze([Object.freeze(pending), Object.freeze(first)]);
  assert.deepEqual(inboxConversations(original), [first]);
  const sent = { ...pending, last_message: 'Oferta individual', last_message_direction: 'outbound' };
  assert.deepEqual(inboxConversations([sent, first]), [sent, first]);
  assert.equal(original.length, 2, 'campaign reservations are not removed from application state');
  assert.deepEqual(inboxConversations([{ ...sent, last_message: null, last_message_direction: null }, first]), [first]);
});
