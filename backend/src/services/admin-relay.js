const db = require('../db/database');
const kapso = require('./kapso-whatsapp');
const assignment = require('./admin-assignment');
const { notifyAdmin } = require('./admin-notify');
const identity = require('./staff-identity');

async function handle(org, config, parsed, io) {
  const actor = await identity.resolve(org.id, parsed.from);
  if (!identity.canAttend(actor)) throw new Error('Tu rol no permite atender conversaciones.');
  if (!parsed.text) {
    await kapso.sendTextMessage(parsed.from, 'Para responder por este canal, escribe un mensaje de texto. Para enviar archivos, usa el CRM.', config);
    return;
  }
  const text = parsed.text.trim();
  const command = text.toUpperCase();
  const take = command.match(/^TOMAR(?:\s+#?(\d+))?$/);
  const finish = /^(CERRAR|BOT|DEVOLVER AL BOT)$/.test(command);
  const reply = body => kapso.sendTextMessage(parsed.from, body, config);
  let active = await assignment.get(org.id, parsed.from);
  if (active && db.normalizePhone(active.admin_phone) !== db.normalizePhone(parsed.from)) {
    await reply('La conversación está asignada a otro encargado. Revisa la asignación desde el CRM.');
    return;
  }
  if (finish) {
    if (!active) { await reply('No tienes una conversación asignada.'); return; }
    const bot = command !== 'CERRAR';
    await assignment.finish(org.id, active.conversation_id, bot, parsed.from);
    io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: active.conversation_id, mode: bot ? 'ai' : 'human' });
    await reply(bot ? 'Conversación devuelta al bot.' : 'Atención cerrada. El bot sigue pausado; puedes reactivarlo desde el CRM.');
    return;
  }
  if (take?.[1] && active && active.conversation_id !== Number(take[1])) {
    await reply(`Ya atiendes la conversación #${active.conversation_id}. Escribe CERRAR o BOT antes de tomar otra.`);
    return;
  }
  if (!active) {
    // Greetings reopen WhatsApp without accidentally forwarding them to a customer.
    if (!take) { await reply('Para atender, escribe TOMAR seguido del número de conversación del aviso, por ejemplo TOMAR 123.'); return; }
    const claimed = await assignment.claim(org.id, parsed.from, take[1] ? Number(take[1]) : null);
    if (!claimed) { await reply('Indica la conversación del aviso: TOMAR 123. Debe estar pendiente; si hay varias, debes elegir una.'); return; }
    active = await assignment.get(org.id, parsed.from);
  }
  if (take) {
    await db.setAgentMode(active.conversation_id, 'human');
    io?.to(`org_${org.id}`).emit(`agent_mode_changed_${org.id}`, { conversationId: active.conversation_id, mode: 'human' });
    await reply(`Estás atendiendo a ${active.contact_name || active.customer_phone} (#${active.conversation_id}). Puedes consultarme sobre este cliente o pedirme que le responda. Escribe CERRAR para terminar o BOT para devolver la conversación al bot.`);
    return;
  }
  // Only the secretary's explicit send action reaches the customer.
  if (!/^ENVIAR\s+/i.test(text)) { await reply('Puedes consultarme o pedirme que prepare una respuesta para el cliente.'); return; }
  const customerText = text.replace(/^ENVIAR\s+/i, '');
  const sent = await kapso.sendTextMessage(active.customer_phone, customerText, config);
  const message = await db.saveMessage({ conversationId: active.conversation_id,
    whatsappMessageId: sent?.messages?.[0]?.id || null, direction: 'outbound',
    content: customerText, sentBy: 'human', status: 'sent' });
  await db.updateConversationLastMessage(active.conversation_id, customerText);
  const conversation = await db.getConversationById(active.conversation_id);
  io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message, conversation });
  await reply(`Enviado a ${active.contact_name || active.customer_phone}. Sigues atendiendo esta conversación hasta escribir CERRAR o BOT.`);
}
async function receive(org, config, parsed, io) {
  let active = await assignment.forCustomer(org.id, parsed.from);
  if (!active) {
    const { rows } = await db.getPool().query(`SELECT id AS conversation_id,phone_number AS customer_phone,contact_name
      FROM conversations WHERE organization_id=$1 AND agent_mode <> 'ai'
      AND regexp_replace(phone_number,'[^0-9]','','g')=$2`,[org.id,db.normalizePhone(parsed.from)]);
    active=rows[0];
  }
  if (!active || db.normalizePhone(active.customer_phone) !== db.normalizePhone(parsed.from)) return false;
  const content = parsed.text || `[${parsed.type || 'Archivo'} recibido; revisar en el CRM]`;
  const message = await db.saveMessage({ conversationId: active.conversation_id,
    whatsappMessageId: parsed.messageId, direction: 'inbound', content,
    type: parsed.type, mediaId: parsed.mediaUrl || parsed.mediaId, sentBy: 'client' });
  if (!message) return true;
  await db.updateConversationLastMessage(active.conversation_id, content, true);
  await db.updateLastInbound(active.conversation_id);
  await kapso.markAsRead(parsed.messageId, config).catch(() => {});
  const conversation = await db.getConversationById(active.conversation_id);
  io?.to(`org_${org.id}`).emit(`new_message_${org.id}`, { message, conversation });
  await require('./human-attention').incoming(org.id,conversation,content);
  return true;
}
module.exports = { handle, receive };
