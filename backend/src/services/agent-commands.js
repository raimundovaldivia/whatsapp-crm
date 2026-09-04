/**
 * agent-commands.js — Manejo de comandos WA desde agentes registrados
 *
 * Cuando un agente con whatsapp_phone registrado envía un mensaje al número
 * del negocio, este servicio lo interpreta como un comando CRM.
 *
 * Comandos disponibles:
 *   AYUDA                          — lista de comandos
 *   CHATS                          — conversaciones activas (con mensajes sin leer primero)
 *   VER <phone>                    — últimos mensajes de un cliente
 *   MSG <phone> <texto>            — enviar mensaje a un cliente
 *   PEDIDOS                        — pedidos pendientes
 *   PAGAR <id>                     — marcar pedido como pagado
 *   PAUSAR <phone>                 — pausar bot para esa conversación (agente toma el control)
 *   ACTIVAR <phone>                — reactivar bot para esa conversación
 *   MI ESTADO                      — estado de mis notificaciones
 */

const db           = require('../db/database');
const kapsoService = require('./kapso-whatsapp');

const HELP_TEXT = `🤖 *Comandos disponibles:*

*CHATS* — ver conversaciones activas
*VER <tel>* — últimos mensajes de un cliente
*MSG <tel> <texto>* — enviar mensaje a cliente
*PEDIDOS* — pedidos pendientes
*PAGAR <id>* — marcar pedido como pagado
*PAUSAR <tel>* — pausar bot (tú atiendes)
*ACTIVAR <tel>* — reactivar bot
*MI ESTADO* — tus ajustes de notificaciones

_Ejemplo: MSG 56987654321 Hola, tu pedido está listo_`;

/**
 * Procesa un mensaje de un agente registrado y devuelve la respuesta.
 * @param {object} org            — {id, name}
 * @param {object} wc             — whatsapp config (para enviar respuesta al agente)
 * @param {object} agent          — usuario/agente registrado
 * @param {string} text           — texto del mensaje del agente
 * @returns {Promise<void>}
 */
async function handleAgentCommand(org, wc, agent, text) {
  const raw = (text || '').trim();
  const reply = await processCommand(org, agent, raw);
  if (reply) {
    await kapsoService.sendTextMessage(agent.whatsapp_phone, reply, wc).catch(err =>
      console.warn('[AgentCmd] No se pudo enviar respuesta al agente:', err.message)
    );
  }
}

async function processCommand(org, agent, raw) {
  const upper = raw.toUpperCase();
  const first  = upper.split(/\s+/)[0];

  // AYUDA / HELP
  if (first === 'AYUDA' || first === 'HELP' || first === '/AYUDA') {
    return HELP_TEXT;
  }

  // MI ESTADO
  if (upper.startsWith('MI ESTADO') || upper.startsWith('ESTADO')) {
    const prefs = agent.wa_notifications || {};
    return [
      `👤 *${agent.name || agent.email}* (${agent.role})`,
      '',
      '*Notificaciones activas:*',
      `${prefs.new_messages  ? '✅' : '❌'} Nuevos mensajes`,
      `${prefs.escalations   ? '✅' : '❌'} Escalaciones`,
      `${prefs.payments      ? '✅' : '❌'} Comprobantes de pago`,
    ].join('\n');
  }

  // CHATS
  if (first === 'CHATS' || first === 'CONVERSACIONES') {
    return await cmdChats(org);
  }

  // PEDIDOS
  if (first === 'PEDIDOS') {
    return await cmdPedidos(org);
  }

  // PAGAR <id>
  if (first === 'PAGAR') {
    const orderId = parseInt(raw.split(/\s+/)[1]);
    if (!orderId) return '❌ Uso: PAGAR <id_pedido>\nEjemplo: PAGAR 42';
    return await cmdPagar(org, orderId);
  }

  // VER <phone>
  if (first === 'VER') {
    const phone = extractPhone(raw, 1);
    if (!phone) return '❌ Uso: VER <teléfono>\nEjemplo: VER 56987654321';
    return await cmdVer(org, phone);
  }

  // MSG <phone> <text>
  if (first === 'MSG' || first === 'RESPONDER' || first === 'R') {
    const parts = raw.split(/\s+/);
    if (parts.length < 3) return '❌ Uso: MSG <teléfono> <mensaje>\nEjemplo: MSG 56987654321 Hola, tu pedido ya salió';
    const phone = extractPhone(raw, 1);
    const msgText = parts.slice(2).join(' ');
    if (!phone || !msgText) return '❌ Uso: MSG <teléfono> <mensaje>';
    return await cmdMsg(org, phone, msgText, agent, wc);
  }

  // PAUSAR <phone>
  if (first === 'PAUSAR' || first === 'PAUSA') {
    const phone = extractPhone(raw, 1);
    if (!phone) return '❌ Uso: PAUSAR <teléfono>';
    return await cmdPausar(org, phone, agent);
  }

  // ACTIVAR <phone>
  if (first === 'ACTIVAR' || first === 'REACTIVAR') {
    const phone = extractPhone(raw, 1);
    if (!phone) return '❌ Uso: ACTIVAR <teléfono>';
    return await cmdActivar(org, phone);
  }

  // Comando no reconocido
  return `❓ Comando no reconocido: _${raw.slice(0, 40)}_\n\nEscribe *AYUDA* para ver los comandos disponibles.`;
}

// ─── Implementaciones de cada comando ─────────────────────────────

async function cmdChats(org) {
  const convs = await db.getAllConversations(org.id);
  if (!convs.length) return '📭 No hay conversaciones activas.';

  // Ordenar: primero las con mensajes sin leer, luego por última actividad
  const sorted = [...convs].sort((a, b) => {
    const unreadDiff = (b.unread_count || 0) - (a.unread_count || 0);
    if (unreadDiff !== 0) return unreadDiff;
    return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
  });

  const lines = sorted.slice(0, 10).map(c => {
    const name   = c.contact_name && c.contact_name !== c.phone_number ? c.contact_name : c.phone_number;
    const unread = c.unread_count > 0 ? ` 🔴 ${c.unread_count}` : '';
    const mode   = c.agent_mode === 'human' ? ' 🟡' : '';
    const last   = c.last_message ? ` — _${c.last_message.slice(0, 50)}_` : '';
    return `• *${name}* (${c.phone_number})${unread}${mode}${last}`;
  });

  const total = convs.length;
  const header = `💬 *Conversaciones* (${Math.min(10, total)} de ${total})\n🔴 = sin leer  🟡 = agente activo\n`;
  return header + lines.join('\n');
}

async function cmdPedidos(org) {
  const orders = await db.getOrdersByOrg(org.id);
  const pending = orders.filter(o => ['sent', 'draft', 'payment_received'].includes(o.status));
  if (!pending.length) return '✅ No hay pedidos pendientes.';

  const lines = pending.slice(0, 10).map(o => {
    const date  = new Date(o.created_at).toLocaleDateString('es-CL', { day: '2-digit', month: 'short' });
    const total = o.total_price ? `$${Number(o.total_price).toLocaleString('es-CL')}` : '?';
    const name  = o.customer_name || o.customer_phone || '?';
    const st    = { sent: 'enviado', draft: 'borrador', payment_received: 'pago recibido' }[o.status] || o.status;
    return `• *#${o.id}* ${name} — ${total} — _{${st}}_  (${date})`;
  });

  return `📦 *Pedidos pendientes* (${pending.length})\n\n` + lines.join('\n') + '\n\n_Escribe PAGAR <id> para confirmar pago_';
}

async function cmdPagar(org, orderId) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
    [orderId, org.id]
  );
  if (!rows.length) return `❌ Pedido #${orderId} no encontrado.`;
  const order = rows[0];
  if (order.status === 'completed') return `ℹ️ El pedido #${orderId} ya está completado.`;

  await db.updateOrder(orderId, { status: 'completed' });
  const name = order.customer_name || order.customer_phone || 'cliente';
  return `✅ *Pedido #${orderId}* marcado como pagado.\n👤 ${name}`;
}

async function cmdVer(org, phone) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  // Buscar conversación por variantes del teléfono
  const { rows: convRows } = await pool.query(
    `SELECT id, contact_name, phone_number, agent_mode, unread_count
     FROM conversations
     WHERE organization_id = $1
       AND phone_number IN ($2, $3, $4)
     LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  if (!convRows.length) return `❌ No encontré conversación con ${phone}.`;
  const conv = convRows[0];

  const messages = await db.getLastMessages(conv.id, 6);
  if (!messages.length) return `📭 No hay mensajes con ${conv.contact_name || phone}.`;

  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  const mode = conv.agent_mode === 'human' ? '🟡 Agente activo' : '🤖 Bot activo';
  const lines = messages.map(m => {
    const dir  = m.direction === 'inbound' ? '←' : '→';
    const who  = m.direction === 'inbound' ? name : 'Bot';
    const text = (m.content || '').slice(0, 100);
    return `${dir} *${who}:* ${text}`;
  });

  return [
    `👤 *${name}* (${conv.phone_number}) | ${mode}`,
    '',
    ...lines,
    '',
    `_Usa MSG ${conv.phone_number} <texto> para responder_`,
  ].join('\n');
}

async function cmdMsg(org, phone, msgText, agent, wc) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows: convRows } = await pool.query(
    `SELECT id, contact_name, phone_number
     FROM conversations
     WHERE organization_id = $1
       AND phone_number IN ($2, $3, $4)
     LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  // Si no existe conversación, crearla
  const targetPhone = convRows.length ? convRows[0].phone_number : normalized;
  const conv = convRows.length
    ? convRows[0]
    : await db.upsertConversation(org.id, targetPhone, null);

  // Enviar mensaje al cliente
  const sent = await kapsoService.sendTextMessage(targetPhone, msgText, wc).catch(err => {
    console.error('[AgentCmd] Error enviando msg al cliente:', err.message);
    return null;
  });

  if (!sent) return `❌ No se pudo enviar el mensaje a ${targetPhone}.`;

  // Guardar en DB
  await db.saveMessage({
    conversationId:    conv.id,
    whatsappMessageId: sent?.messages?.[0]?.id,
    direction:         'outbound',
    content:           msgText,
    sentBy:            'human',
    agentType:         agent.name || agent.email,
  });
  await db.updateConversationLastMessage(conv.id, msgText, false);

  const name = conv.contact_name && conv.contact_name !== targetPhone ? conv.contact_name : targetPhone;
  return `✅ Mensaje enviado a *${name}*:\n_"${msgText.slice(0, 80)}"_`;
}

async function cmdPausar(org, phone, agent) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows } = await pool.query(
    `SELECT id, contact_name, phone_number, agent_mode FROM conversations
     WHERE organization_id = $1 AND phone_number IN ($2, $3, $4) LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  if (!rows.length) return `❌ No encontré conversación con ${phone}.`;
  const conv = rows[0];

  if (conv.agent_mode === 'human') {
    return `ℹ️ El bot ya estaba pausado para *${conv.contact_name || phone}*.\nUsa ACTIVAR ${phone} para reactivarlo.`;
  }

  await db.setAgentMode(conv.id, 'human');
  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  return `🟡 Bot pausado para *${name}*.\nAhora puedes atenderle directamente. Escribe MSG ${conv.phone_number} <texto> para responder.\nUsa ACTIVAR ${conv.phone_number} cuando termines.`;
}

async function cmdActivar(org, phone) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows } = await pool.query(
    `SELECT id, contact_name, phone_number, agent_mode FROM conversations
     WHERE organization_id = $1 AND phone_number IN ($2, $3, $4) LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  if (!rows.length) return `❌ No encontré conversación con ${phone}.`;
  const conv = rows[0];

  if (conv.agent_mode === 'ai') {
    return `ℹ️ El bot ya estaba activo para *${conv.contact_name || phone}*.`;
  }

  await db.setAgentMode(conv.id, 'ai');
  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  return `🤖 Bot reactivado para *${name}*. El bot retomará las respuestas automáticas.`;
}

// ─── Helpers ──────────────────────────────────────────────────────

function extractPhone(raw, tokenIndex) {
  const parts = raw.split(/\s+/);
  const token = parts[tokenIndex];
  if (!token) return null;
  // Aceptar formatos: 56987654321, +56987654321, 987654321
  const digits = token.replace(/[^\d]/g, '');
  if (digits.length < 8) return null;
  return digits;
}

module.exports = { handleAgentCommand };
