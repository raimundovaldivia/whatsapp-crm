const meta = require('./meta-platform');

// Only read parents of actual replies in this CRM conversation. The original
// webhook is retained, so replies received before this feature also work.
async function loadInstagramQuotes(pool, orgId, conversationId, history) {
  const prefix = 'social:instagram:';
  const ids = history.filter(m => m.direction === 'inbound' && m.whatsapp_message_id?.startsWith(prefix))
    .map(m => m.whatsapp_message_id.slice(prefix.length));
  if (!ids.length) return history;
  const { rows } = await pool.query(`
    SELECT r.external_message_id AS reply_id, r.raw_payload #>> '{message,reply_to,mid}' AS parent_id,
           t.id AS thread_id, t.external_user_id, c.instagram_account_id, c.page_access_token,
           p.content, p.direction, p.created_at, r.instagram_reply_context
      FROM meta_threads t
      JOIN meta_messages r ON r.thread_id=t.id AND r.direction='inbound'
      LEFT JOIN meta_messages p ON p.thread_id=t.id
           AND p.external_message_id=r.raw_payload #>> '{message,reply_to,mid}'
      LEFT JOIN meta_connections c ON c.organization_id=t.organization_id AND c.status='connected'
           AND c.instagram_account_id=r.raw_payload #>> '{recipient,id}'
     WHERE t.organization_id=$1 AND t.crm_conversation_id=$2 AND t.channel='instagram'
       AND r.external_message_id=ANY($3::text[]) AND r.raw_payload #>> '{message,reply_to,mid}' IS NOT NULL`,
  [orgId, conversationId, ids]);
  if (!rows.length) return history;

  const parents = new Map();
  const quotes = new Map();
  await Promise.all(rows.map(async row => {
    const key = row.thread_id + ':' + row.parent_id;
    if (!parents.has(key)) {
      const { content, direction, created_at } = row;
      parents.set(key, direction ? { content, direction, created_at } : row.instagram_reply_context || fetchParent(row));
    }
    const parent = await parents.get(key);
    if (!parent?.content) return;
    quotes.set(prefix + row.reply_id, parent);
    if (!row.direction && !row.instagram_reply_context) {
      await pool.query(`UPDATE meta_messages AS r SET instagram_reply_context=$1::jsonb
        FROM meta_threads AS t WHERE r.thread_id=t.id AND t.organization_id=$2
          AND t.id=$3 AND r.external_message_id=$4 AND r.instagram_reply_context IS NULL`,
      [JSON.stringify(parent), orgId, row.thread_id, row.reply_id]);
    }
  }));
  return history.map(m => quotes.has(m.whatsapp_message_id)
    ? { ...m, instagramQuote: quotes.get(m.whatsapp_message_id) } : m);
}

async function fetchParent(row) {
  if (!row.page_access_token || !/^[A-Za-z0-9_+=:/-]{1,1024}$/.test(row.parent_id)) return null;
  try {
    const message = await meta.graphGet(encodeURIComponent(row.parent_id), meta.decryptToken(row.page_access_token),
      { fields: 'id,from,to,message,created_time' });
    const [recipient, ...others] = message.to?.data || [];
    if (message.id !== row.parent_id || !recipient || others.length || typeof message.message !== 'string' || !message.message.trim()) return null;
    const outgoing = message.from?.id === row.instagram_account_id && recipient.id === row.external_user_id;
    const incoming = message.from?.id === row.external_user_id && recipient.id === row.instagram_account_id;
    if (!outgoing && !incoming) return null;
    const parent = { content: message.message.trim(), direction: outgoing ? 'outbound' : 'inbound', created_at: message.created_time };
    if (!Number.isFinite(Date.parse(parent.created_at))) return null;
    return parent;
  } catch {
    // A deleted or inaccessible parent must not interrupt the customer's turn.
    return null;
  }
}

module.exports = { loadInstagramQuotes };
