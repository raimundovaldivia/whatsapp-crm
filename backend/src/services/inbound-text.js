const db = require('../db/database');
const pipeline = require('./pipeline');
const { resumeDivaOnInbound } = require('./conversation-mode');
const { notifyAdminHumanPendingReply } = require('./notifications');
const provider = require('./whatsapp-provider');

async function processInboundText({ org, whatsappConfig, parsed, io, markAsRead, whatsappChannelId = null, prepareMedia = null, scheduleResponse = null }) {
  if (!parsed?.from || !parsed?.text) return;

  const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName, whatsappChannelId);
  const savedMsg = await db.saveMessage({
    conversationId: conversation.id,
    whatsappMessageId: parsed.messageId,
    direction: 'inbound',
    content: parsed.text,
    sentBy: 'client',
    type: parsed.type || 'text',
    mediaId: parsed.mediaId || null,
  });
  if (!savedMsg) return;

  await db.updateConversationLastMessage(conversation.id, parsed.text, true);
  if (db.updateLastInbound) await db.updateLastInbound(conversation.id);
  if (markAsRead) await markAsRead().catch(() => {});

  let updatedConv = await db.getConversationById(conversation.id);
  io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: savedMsg, conversation: updatedConv });

  if (updatedConv.agent_mode !== 'ai') {
    const resumed = await resumeDivaOnInbound(conversation, db);
    if (!resumed) {
      if (updatedConv.agent_mode === 'human') {
        await notifyAdminHumanPendingReply(org.id, updatedConv, parsed.text);
      }
      return;
    }
    io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'ai' });
  }

  let prepared = null;
  if (prepareMedia) {
    if (!await require('./commercial').permitted(org.id, 'sales_ai')) return;
    prepared = await prepareMedia();
    if (prepared.text) {
      parsed.text = prepared.text;
      await db.getPool().query(`UPDATE messages SET content=$1 WHERE id=$2 AND conversation_id IN
        (SELECT id FROM conversations WHERE organization_id=$3)`, [parsed.text, savedMsg.id, org.id]);
      await db.updateConversationLastMessage(conversation.id, parsed.text);
      io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: { ...savedMsg, content: parsed.text }, conversation: await db.getConversationById(conversation.id) });
    }
  }
  const respond = async () => {
    const beforeResponse = await db.getConversationById(conversation.id);
    if (!beforeResponse || beforeResponse.agent_mode !== 'ai') return;
    let textToProcess = parsed.text;
    if (scheduleResponse) {
      const messages = await db.getLastMessages(conversation.id, 20);
      let trailing = [];
      for (const message of messages) {
        if (message.direction === 'inbound') trailing.push(message); else trailing = [];
      }
      const recent = trailing.filter(message => !message.created_at || new Date(message.created_at).getTime() >= Date.now() - 120000);
      textToProcess = recent.map(message => message.content).filter(Boolean).join('\n') || parsed.text;
    }
  const result = prepared?.fallback
    ? { response: prepared.fallback, agentType: 'system' }
    : await pipeline.processMessage(org.id, conversation.id, textToProcess);
  if (result.skipped || result.duplicate || !result.response) return;

  const checked = await require('./response-guardrail').checkResponseFreshness(org.id, conversation.id, result.response, { userMessage: parsed.text });
  if (!checked.ok) {
    result.response = 'Para asegurarme de entenderte bien, ¿qué necesitas confirmar?';
  }

  const beforeSend = await db.getConversationById(conversation.id);
  if (!beforeSend || beforeSend.agent_mode === 'human') return;
  const sentResult = await provider.sendTextMessage(parsed.from, result.response, whatsappConfig);
  const outMsg = await db.saveMessage({
    conversationId: conversation.id,
    whatsappMessageId: provider.messageId(sentResult),
    direction: 'outbound',
    content: result.response,
    sentBy: 'ai',
    agentType: result.agentType,
  });
  await db.updateConversationLastMessage(conversation.id, result.response);

  if (result.switchToHuman) {
    io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'coordinating' });
  }
  updatedConv = await db.getConversationById(conversation.id);
  io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: outMsg, conversation: updatedConv });

  if (result.orderCreated) {
    io?.to(`org_${org.id}`).emit(`order_created_${org.id}`, {
      conversationId: conversation.id,
      order: result.orderCreated,
    });
  }
  };
  if (scheduleResponse) scheduleResponse(respond);
  else await respond();
}

module.exports = { processInboundText };
