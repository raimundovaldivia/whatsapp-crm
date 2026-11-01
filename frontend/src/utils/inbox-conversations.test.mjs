import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxConversations, buildInboxLayout, inboxVisibleRange, inboxMessageResults } from './inbox-conversations.mjs';

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

test('1,855 chats remain reachable while only a small window is mounted', () => {
  const items = Array.from({ length: 1855 }, (_, id) => ({ key: `chat:${id}` }));
  const { offsets, totalHeight } = buildInboxLayout(items);
  const visited = new Set();
  for (let top = 0; top <= totalHeight; top += 480) {
    const { start, end } = inboxVisibleRange(offsets, top, 600);
    assert.ok(end - start < 20, 'DOM size stays bounded while scrolling');
    for (let index = start; index < end; index++) visited.add(index);
  }
  assert.equal(visited.size, items.length, 'scrolling reaches every conversation');
  const bottom = inboxVisibleRange(offsets, totalHeight, 600);
  assert.equal(bottom.end, items.length);
  assert.equal(inboxVisibleRange(offsets, -100, 600).start, 0);
});

test('measured variable heights survive reorder and handle shorter filtered lists', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const heights = new Map([['a', 80], ['b', 200], ['c', 60]]);
  assert.deepEqual(buildInboxLayout(items, heights).offsets, [0, 80, 280, 340]);
  assert.deepEqual(inboxVisibleRange([0, 80, 280, 340], 80, 200, 0), { start: 1, end: 3 });
  assert.deepEqual(buildInboxLayout([items[2], items[0]], heights).offsets, [0, 60, 140]);
  assert.deepEqual(inboxVisibleRange([0, 80], 100000, 600), { start: 0, end: 1 });
  assert.deepEqual(inboxVisibleRange([0], 0, 600), { start: 0, end: 0 });
});

test('message search retains off-screen matches and respects provider and duplicate chats', () => {
  const conversations = Array.from({ length: 1855 }, (_, id) => ({ id, whatsapp_provider: 'kapso' }));
  conversations.push({ id: 2000, whatsapp_provider: 'evolution' });
  const filtered = conversations.slice(0, 100);
  const results = [{ id: 90 }, { id: 1800 }, { id: 1800 }, { id: 2000 }, { id: 2001, whatsapp_provider: 'meta' }];
  assert.deepEqual(inboxMessageResults(conversations, filtered, results, 'meta').map(r => r.id), [1800, 2001]);
  assert.deepEqual(inboxMessageResults(conversations, filtered, results, 'evolution').map(r => r.id), [2000]);
  assert.deepEqual(inboxMessageResults(conversations, filtered, results).map(r => r.id), [1800, 2000, 2001]);
  assert.equal(results.length, 5, 'the API response is not modified');
});

