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

export function buildInboxLayout(items, heights = new Map(), estimatedHeight = 112) {
  const offsets = [0];
  for (const item of items) {
    const measured = heights.get(item.key);
    const height = Number.isFinite(measured) && measured > 0 ? measured : estimatedHeight;
    offsets.push(offsets[offsets.length - 1] + height);
  }
  return { offsets, totalHeight: offsets[offsets.length - 1] };
}

export function inboxVisibleRange(offsets, scrollTop, viewportHeight, overscan = 5) {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  function indexAt(position) {
    let low = 0, high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle + 1] <= position) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, count - 1);
  }
  const top = Math.max(0, scrollTop);
  return {
    start: Math.max(0, indexAt(top) - overscan),
    end: Math.min(count, indexAt(top + Math.max(1, viewportHeight)) + overscan + 1),
  };
}

// Deduplicate against the entire filtered set, including off-screen chats.
export function inboxMessageResults(conversations, filtered, results, provider = 'all') {
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const seen = new Set(filtered.map(conversation => conversation.id));
  return results.filter(result => {
    if (seen.has(result.id)) return false;
    const conversation = byId.get(result.id) || result;
    const channel = conversation.whatsapp_provider;
    if (provider === 'evolution' && channel !== 'evolution') return false;
    if (provider === 'meta' && channel !== 'meta' && channel !== 'kapso') return false;
    seen.add(result.id);
    return true;
  });
}


