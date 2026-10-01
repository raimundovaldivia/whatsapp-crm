const db = require('../db/database');
const pipeline = require('./pipeline');
const { resumeDivaOnInbound } = require('./conversation-mode');
const { notifyAdminHumanPendingReply } = require('./notifications');
const provider = require('./whatsapp-provider');

async function processInboundText({ org, whatsappConfig, parsed, io, markAsRead, whatsappChannelId = null }) {
  if (!parsed?.from || !parsed?.text) return;

  const conversation = await db.upsertConversation(org.id, parsed.from, parsed.contactName, whatsappChannelId);
  const savedMsg = await db.saveMessage({
    conversationId: conversation.id,
    whatsappMessageId: parsed.messageId,
    direction: 'inbound',
    content: parsed.text,
    sentBy: 'client',
  });
  if (!savedMsg) return;

  await db.updateConversationLastMessage(conversation.id, parsed.text, true);
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

  const result = await pipeline.processMessage(org.id, conversation.id, parsed.text);
  if (result.skipped || !result.response) return;

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
}

module.exports = { processInboundText };
