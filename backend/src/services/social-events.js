function textFromMessage(message = {}) {
  if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
  const attachment = message.attachments?.[0];
  if (attachment?.payload?.url) return `[Adjunto] ${attachment.payload.url}`;
  return attachment ? `[${attachment.type || 'Adjunto'}]` : '';
}

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function messagingEvents(body, connection) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const event of entry.messaging || []) {
      const message = event.message;
      const senderId = String(event.sender?.id || '');
      const content = textFromMessage(message);
      if (!senderId || !message || message.is_echo || !content) continue;
      const channel = String(body.object || '').includes('instagram')
        || String(entry.id) === String(connection?.instagram_account_id)
        ? 'instagram' : 'facebook';
      events.push({
        kind: 'message',
        channel,
        senderId,
        recipientId: String(event.recipient?.id || ''),
        externalId: String(message.mid || `${senderId}:${event.timestamp || Date.now()}`),
        content,
        messageType: message.attachments?.[0]?.type || 'text',
        timestamp: timestampMs(event.timestamp),
        raw: event,
      });
    }
  }
  return events;
}

function commentEvents(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const facebook = change.field === 'feed' && value.item === 'comment' && value.verb === 'add';
      const instagram = change.field === 'comments' || change.field === 'live_comments';
      if (!facebook && !instagram) continue;
      const externalId = String(value.comment_id || value.id || '');
      const authorId = String(value.from?.id || value.user_id || '');
      const content = String(value.message || value.text || '').trim();
      if (!externalId || !authorId || !content) continue;
      events.push({
        kind: 'comment',
        channel: instagram ? 'instagram' : 'facebook',
        externalId,
        postId: String(value.post_id || value.media?.id || value.media_id || ''),
        parentId: String(value.parent_id || value.parent?.id || ''),
        authorId,
        authorName: String(value.from?.name || value.from?.username || value.username || '').trim() || null,
        content,
        timestamp: timestampMs(value.created_time || value.timestamp),
        raw: change,
      });
    }
  }
  return events;
}

function extractSocialEvents(body, connection) {
  return [...messagingEvents(body, connection), ...commentEvents(body)];
}

function isOwnActor(event, connection) {
  const actor = String(event?.senderId || event?.authorId || '');
  return !!actor && [connection?.page_id, connection?.instagram_account_id]
    .filter(Boolean).map(String).includes(actor);
}

function messageEndpoint(connection, channel) {
  return `${channel === 'instagram' ? connection.instagram_account_id : connection.page_id}/messages`;
}

function commentReplyEndpoint(comment) {
  return `${comment.external_comment_id}/${comment.channel === 'instagram' ? 'replies' : 'comments'}`;
}

module.exports = {
  extractSocialEvents,
  isOwnActor,
  messageEndpoint,
  commentReplyEndpoint,
  textFromMessage,
};
