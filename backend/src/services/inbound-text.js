const db = require('../db/database');
const pipeline = require('./pipeline');
const { resumeDivaOnInbound } = require('./conversation-mode');
const { notifyAdminHumanPendingReply } = require('./notifications');
const provider = require('./whatsapp-provider');
const { isTerminalConversationReply } = require('./inbound-message-policy');
const deliveryInboundNotifications = require('./delivery-inbound-notifications');
const pipelineOutbound = require('./pipeline-outbound');
const { notifyAdmin } = require('./admin-notify');

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

  if (parsed.attribution) {
    await db.saveWhatsappAttribution({
      organizationId: org.id,
      conversationId: conversation.id,
      messageId: savedMsg.id,
      whatsappMessageId: parsed.messageId,
      provider: whatsappConfig?.provider || (whatsappChannelId ? 'evolution' : 'meta'),
      attribution: parsed.attribution,
    });
  }

  if (parsed.adReferral) {
    await db.saveAdAttribution({
      organizationId: org.id,
      conversationId: conversation.id,
      messageId: savedMsg.id,
      referral: parsed.adReferral,
    }).catch(error => console.warn('[Ads] No se pudo guardar la atribución:', error.message));
  }

  await db.updateConversationLastMessage(conversation.id, parsed.text, true);
  if (db.updateLastInbound) await db.updateLastInbound(conversation.id);
  if (markAsRead) await markAsRead().catch(() => {});

  let updatedConv = await db.getConversationById(conversation.id);
  io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: savedMsg, conversation: updatedConv });
  if (typeof deliveryInboundNotifications.notifyAssignedDriversForInbound === 'function') {
    deliveryInboundNotifications.notifyAssignedDriversForInbound(org.id, updatedConv, parsed.text).catch(() => {});
  }

  if (updatedConv.agent_mode !== 'ai') {
    const recentHistory = await db.getLastMessages(conversation.id, 20).catch(() => []);
    if (isTerminalConversationReply(parsed.text, recentHistory)) {
      await db.setAgentMode(conversation.id, 'ai');
      if (typeof db.clearLastEscalation === 'function') await db.clearLastEscalation(conversation.id).catch(() => {});
      io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: conversation.id, mode: 'ai' });
      return;
    }
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

  const outboundDecision = await pipelineOutbound.evaluatePipelineResult({
    orgId: org.id,
    conversationId: conversation.id,
    userMessage: textToProcess,
    result,
  });
  if (outboundDecision.escalate) {
    const responseWasReplaced = outboundDecision.response !== result.response;
    await pipelineOutbound.coordinateConversation({
      orgId: org.id,
      conversationId: conversation.id,
      conversation: beforeResponse,
      userMessage: textToProcess,
      reason: outboundDecision.reason,
      botWasGoingToSay: outboundDecision.botWasGoingToSay,
      io,
    });
    result.response = outboundDecision.response;
    result.agentType = 'orchestrator';
    result.productMedia = null;
    if (responseWasReplaced) {
      result.aiProvider = null;
      result.aiModel = null;
      result.promptVersion = 'escalation-ack-v1';
    }
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
    aiProvider: result.aiProvider,
    aiModel: result.aiModel,
    promptVersion: result.promptVersion,
  });
  await db.updateConversationLastMessage(conversation.id, result.response);

  updatedConv = await db.getConversationById(conversation.id);
  io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message: outMsg, conversation: updatedConv });

  if (result.productMedia) {
    await require('./product-media-delivery').sendSuggested({
      suggestion: result.productMedia,
      orgId: org.id,
      conversation: updatedConv || conversation,
      config: whatsappConfig,
      io,
      agentType: result.agentType,
    });
  }

  if (result.orderCreated) {
    io?.to(`org_${org.id}`).emit(`order_created_${org.id}`, {
      conversationId: conversation.id,
      order: result.orderCreated,
    });
  }
  if (result.adminNotice) {
    notifyAdmin(org.id, { body: result.adminNotice, kind: 'order', conversationId: conversation.id }).catch(() => {});
  }
  if (result.orderUpdated || result.orderCancelled) {
    const changed = result.orderUpdated || result.orderCancelled;
    io?.to(`org_${org.id}`).emit(`order_updated_${org.id}`, {
      conversationId: conversation.id,
      orderId: changed.orderId,
      event: result.orderUpdated ? 'updated' : 'cancelled',
    });
  }
  };
  if (scheduleResponse) scheduleResponse(respond);
  else await respond();
}

module.exports = { processInboundText };
