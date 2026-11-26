const db = require('../db/database');
const ai = require('./ai-provider');
const evolution = require('./evolution-whatsapp');
const { STORE_SLUG } = require('./xl-welcome-pricing');
const { normalizeOrderLabel } = require('../utils/order-reference');

const instructions = {
  web_order: 'Confirma que recibimos la compra. Se paga contra entrega. La fecha de despacho se confirmará después. El detalle de compra se muestra debajo.',
  order_summary: 'El pedido se registró. Indica que abajo está el detalle y que coordinaremos entrega y pago por este chat.',
  payment_received: 'Confirma que se recibió el pago por TOTAL y agradece la compra.',
  payment_link: 'Envía el enlace de pago solicitado para el pedido. El enlace auténtico va en la línea siguiente.',
  charge: 'El pago por TOTAL sigue pendiente de confirmación en nuestros registros. Pide el comprobante si transfirió o que indique si usó otro medio. No asegures que el cliente debe dinero.',
  voucher: 'Pide ayuda para verificar el pago por TOTAL. Si pagó por transferencia solicita el comprobante por este chat; si pagó de otra manera pídele que lo indique.',
  scheduled_order: 'Llegó la fecha de compra coordinada. Si hay PRODUCTO pregunta si lo confirmamos; si no hay producto, pregunta qué le gustaría pedir. No digas que hay un despacho confirmado.',
  delivery_consolidated: 'El repartidor ya tiene el pedido. Invita a responder por este chat para coordinar la entrega.',
  delivery: 'El repartidor va en camino para entregar el pedido. Pide estar pendiente para recibirlo.',
  entregado: 'La entrega del pedido quedó registrada. Agradece la compra. No afirmes quién lo recibió ni que fue pagado.',
  partial: 'Se entregó solo parte del pedido. El resto quedó programado para FECHA. Invita a consultar por este chat.',
  postponed: 'La entrega quedó reprogramada para FECHA. Pregunta si esa fecha le acomoda.',
  cancelled: 'El pedido fue cancelado. Ofrece revisar el caso por este chat.',
  not_delivered: 'No se pudo entregar el pedido. Pregunta cómo coordinar un nuevo intento, sin atribuir la causa al cliente.',
  order_edit: 'Se actualizaron los datos del pedido. Invita a revisar el detalle que aparece debajo y a responder si hay algo que corregir.',
  customer_feedback: 'Pide evaluar la primera compra en la escala ESCALA e invita a comentar qué podríamos mejorar.',
};

async function enabled(orgId) {
  const org = await db.getOrgById(orgId);
  if (!org) throw new Error('No se pudo identificar la organización del aviso.');
  return org.slug === STORE_SLUG;
}

async function channel(orgId) {
  const config = await db.getEvolutionWhatsappChannel(orgId);
  return config?.provider === 'evolution' && config.status === 'connected' && !config.assigned_user_id ? config : null;
}

function wording(text) {
  return text.split('\n')[0].toLocaleLowerCase('es').replace(/#(?:[a-z]+-)?[\w-]+/gu, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
}

async function draft(kind, fields, recent) {
  const instruction = instructions[kind];
  if (!instruction) throw new Error('Tipo de aviso desconocido.');
  const keys = Object.keys(fields);
  const system = 'Redacta un único aviso transaccional de Diez Ríos en español de Chile para WhatsApp. ' +
    'Escribe una o dos frases naturales en primera persona plural, con redacción propia para esta ocasión. ' +
    'Usa solamente el hecho y la acción indicados. No inventes plazos, pagos, motivos, productos, enlaces, cifras ni promociones. ' +
    'Usa exactamente una vez cada marcador indicado, respetando las mayúsculas. NOMBRE es el nombre de pila; PEDIDO identifica la compra o las compras. FECHA identifica el día; TOTAL es el importe; ESCALA se reemplaza por «1 al 5» y PRODUCTO por el producto solicitado. ' +
    'Si no hay un marcador, omite ese dato. Devuelve solo el mensaje, sin comillas, notas ni etiquetas.';
  const prompt = [instruction, 'Marcadores disponibles: ' + (keys.join(', ') || 'ninguno')].join('\n');
  // El modelo recibe el evento y los nombres de los marcadores, nunca datos personales ni enlaces privados.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ai.client.messages.create({
      model: ai.modelFor('fast'), max_tokens: 260, system,
      messages: [{ role: 'user', content: attempt ? prompt + '\nRedacta de otra manera y comprueba los marcadores. No añadas cifras ni enlaces.' : prompt }],
    });
    const body = ai.responseText(response).replace(/\s+/g, ' ').trim();
    if (!body || body.length > 750 || /(?:https?:|www\.|[#\d$<>\[\]{}]|\b(?:undefined|null)\b)/i.test(body)) continue;
    const tokens = body.match(/\b(?:NOMBRE|PEDIDO|FECHA|ESCALA|PRODUCTO|TOTAL)\b/g) || [];
    if (tokens.length !== keys.length || !keys.every(k => tokens.includes(k))) continue;
    const message = body.replace(/\b(?:NOMBRE|PEDIDO|FECHA|ESCALA|PRODUCTO|TOTAL)\b/g, key => fields[key]);
    if (!recent.has(wording(message))) return message;
  }
  throw Object.assign(new Error('La IA no produjo un aviso válido.'), { code: 'AI_NOTICE_INVALID', status: 503 });
}

async function send(orgId, stop, { kind, fields = {}, details, trackingUrl, agentType = kind, respectSendingHours = false, io = null }) {
  const config = await channel(orgId);
  if (!config) throw Object.assign(new Error('El canal Evolution de la tienda no está conectado.'), { code: 'EVOLUTION_UNAVAILABLE', status: 409 });
  const rawPhone = String(stop.phone || '').trim();
  const phone = db.normalizePhone(rawPhone);
  if (!/^\+?[\d ()-]+(?:@s\.whatsapp\.net)?$/i.test(rawPhone) || !/^[1-9]\d{7,14}$/.test(phone)) throw Object.assign(new Error('El pedido no tiene teléfono.'), { code: 'NO_PHONE', status: 400 });
  const firstName = String(stop.customerName || stop.customer_name || '').trim().split(/\s+/)[0];
  const label = normalizeOrderLabel(stop.orderName) || (stop.id != null && normalizeOrderLabel(stop.orderName, stop.source, stop.id)) || '';
  const values = { ...fields };
  if (firstName && !/^(?:cliente|[+\d()-]+)$/i.test(firstName)) values.NOMBRE = firstName;
  if (label) values.PEDIDO = label;
  const conversation = await db.upsertConversation(orgId, phone, stop.customerName || stop.customer_name, config.id);
  const { rows } = await db.getPool().query(
    `SELECT content FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND agent_type = $2
      ORDER BY id DESC LIMIT 3`, [conversation.id, agentType]
  );
  const recent = new Set(rows.filter(row => row.content).map(row => wording(row.content)));
  const body = await draft(kind, values, recent);
  const text = [body, details, trackingUrl].filter(Boolean).join('\n');
  if (respectSendingHours) {
    const queued = await require('./outbound-message-queue').deferOutsideHours({
      orgId, conversationId: conversation.id, text, agentType, sentBy: 'ai', sendingProvider: 'evolution', io,
    });
    if (queued) return { queued: true, sent: false, conversationId: conversation.id, text, provider: 'evolution' };
  }
  const sent = await evolution.sendTextMessage(phone, text, config);
  if (!sent?.messageId) throw Object.assign(new Error('Evolution no confirmó el envío.'), { code: 'EVOLUTION_UNCONFIRMED' });
  let message = null;
  try {
    message = await db.saveMessage({ conversationId: conversation.id, whatsappMessageId: sent.messageId,
      direction: 'outbound', content: text, status: 'pending', sentBy: 'ai', agentType });
    await db.updateConversationLastMessage(conversation.id, text);
    if (io && message) io.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message, conversation });
  } catch (error) {
    console.error('[Order notice] Evolution aceptó el aviso, pero falló su registro:', error.message);
  }
  return { sent: true, text, message, conversationId: conversation.id, via: 'text', provider: 'evolution', messageId: sent.messageId, templateName: null };
}

module.exports = { enabled, channel, send };
