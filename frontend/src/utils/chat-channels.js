export function comparablePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (/^9\d{8}$/.test(digits)) digits = `56${digits}`;
  return digits;
}

export function channelKey(item) {
  return item?.whatsapp_channel_id
    ? `channel:${item.whatsapp_channel_id}`
    : `official:${item?.whatsapp_provider || 'meta'}`;
}

export function mergeCustomerChannelConversations(activeConversation, localConversations = [], fetchedConversations = []) {
  const customerPhone = comparablePhone(activeConversation?.phone_number);
  const candidates = [activeConversation, ...localConversations, ...fetchedConversations]
    .filter(Boolean)
    .filter(item => comparablePhone(item.phone_number) === customerPhone);
  const unique = new Map();
  for (const item of candidates) {
    const key = channelKey(item);
    const previous = unique.get(key);
    if (!previous || Number(item.id) === Number(activeConversation?.id)) unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) => {
    if (Number(a.id) === Number(activeConversation?.id)) return -1;
    if (Number(b.id) === Number(activeConversation?.id)) return 1;
    return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
  });
}

export function channelConversationSignature(activeConversation, conversations = []) {
  const phone = comparablePhone(activeConversation?.phone_number);
  return conversations
    .filter(item => comparablePhone(item?.phone_number) === phone)
    .map(item => `${item.id}:${channelKey(item)}`)
    .sort()
    .join('|');
}
