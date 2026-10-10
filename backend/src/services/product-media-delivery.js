const db = require('../db/database');
const provider = require('./whatsapp-provider');

async function sendSuggested({ suggestion, orgId, conversation, config, io, agentType = 'sales' }) {
  if (!suggestion?.mediaUrl || !conversation?.phone_number || !config) return null;
  try {
    const sent = await provider.sendMediaMessage(conversation.phone_number, suggestion, config);
    const message = await db.saveMessage({
      conversationId: conversation.id,
      whatsappMessageId: provider.messageId(sent),
      direction: 'outbound',
      content: suggestion.caption || '📷 Foto del producto',
      type: 'image',
      status: 'sent',
      sentBy: 'ai',
      agentType,
      mediaId: suggestion.mediaUrl,
    });
    await db.updateConversationLastMessage(conversation.id, suggestion.caption || '📷 Foto del producto');
    const updated = await db.getConversationById(conversation.id);
    io?.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message, conversation: updated });
    return message;
  } catch (error) {
    console.warn(`[ProductMedia] No se pudo enviar la foto a ${conversation.phone_number}:`, error.message);
    return null;
  }
}

module.exports = { sendSuggested };
