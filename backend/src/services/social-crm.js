const db = require('../db/database');
const pipeline = require('./pipeline');

function messageKey(channel, externalMessageId) {
  const id = String(externalMessageId || '').trim();
  return id ? `social:${channel}:${id}` : null;
}

async function ensureConversation(orgId, thread) {
  if (!thread || Number(thread.organization_id) !== Number(orgId)) throw new Error('Conversación social inválida');
  const conversation = await db.upsertSocialConversation(
    orgId,
    thread.channel,
    thread.external_user_id,
    thread.contact_name
  );
  await db.getPool().query(
    `UPDATE meta_threads SET crm_conversation_id=$1,updated_at=NOW()
      WHERE id=$2 AND organization_id=$3`,
    [conversation.id, thread.id, orgId]
  );
  return conversation;
}

async function recordInbound({ orgId, thread, event }) {
  const conversation = await ensureConversation(orgId, thread);
  const saved = await db.saveMessage({
    conversationId: conversation.id,
    whatsappMessageId: messageKey(thread.channel, event.externalId),
    direction: 'inbound',
    content: event.content,
    type: event.messageType || 'text',
    status: 'delivered',
    sentBy: 'client',
  });
  if (saved) {
    await Promise.all([
      db.updateConversationLastMessage(conversation.id, event.content, false),
      db.updateLastInbound(conversation.id),
    ]);
  }
  return { conversation: await db.getConversationById(conversation.id, orgId), message: saved };
}

async function generateReply({ orgId, conversation, content, log = null }) {
  if (!conversation || Number(conversation.organization_id) !== Number(orgId)) throw new Error('Conversación CRM inválida');
  if (conversation.agent_mode !== 'ai') return { skipped: true, reason: 'HUMAN_MODE' };
  return pipeline.processMessage(orgId, conversation.id, content, log);
}

async function recordOutbound({ orgId, thread, externalMessageId, content, sentBy = 'ai', agentType = null, status = 'sent' }) {
  const conversation = await ensureConversation(orgId, thread);
  const saved = await db.saveMessage({
    conversationId: conversation.id,
    whatsappMessageId: messageKey(thread.channel, externalMessageId),
    direction: 'outbound',
    content,
    status,
    sentBy,
    agentType,
  });
  if (saved) await db.updateConversationLastMessage(conversation.id, content, false);
  return saved;
}

module.exports = { ensureConversation, recordInbound, generateReply, recordOutbound, messageKey };
