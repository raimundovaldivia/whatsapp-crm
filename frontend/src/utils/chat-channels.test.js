import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelConversationSignature,
  mergeCustomerChannelConversations,
} from './chat-channels.js';

test('agrega en vivo el chat del repartidor para el mismo cliente', () => {
  const active = { id: 10, phone_number: '56962496975', whatsapp_channel_id: 2, whatsapp_provider: 'evolution' };
  const driver = { id: 11, phone_number: '+56 9 6249 6975', whatsapp_channel_id: 7, whatsapp_provider: 'evolution' };
  const rows = mergeCustomerChannelConversations(active, [active, driver]);
  assert.deepEqual(rows.map(row => row.id), [10, 11]);
  assert.match(channelConversationSignature(active, [active, driver]), /11:channel:7/);
});

test('no mezcla conversaciones de otra clienta ni duplica un canal', () => {
  const active = { id: 10, phone_number: '56962496975', whatsapp_channel_id: 2 };
  const stale = { id: 9, phone_number: '56962496975', whatsapp_channel_id: 7 };
  const current = { id: 11, phone_number: '56962496975', whatsapp_channel_id: 7 };
  const other = { id: 12, phone_number: '56911112222', whatsapp_channel_id: 8 };
  const rows = mergeCustomerChannelConversations(active, [other, stale], [current]);
  assert.deepEqual(rows.map(row => row.id), [10, 9]);
});
