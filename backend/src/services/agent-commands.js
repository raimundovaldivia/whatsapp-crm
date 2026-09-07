/**
 * agent-commands.js — Agente IA para consultas CRM vía WhatsApp
 *
 * Los agentes registrados envían mensajes con prefijo # al número del negocio.
 * Este servicio usa Claude Haiku para interpretar lenguaje natural:
 *   - Preguntas de datos → genera SQL seguro (solo SELECT), ejecuta, formatea respuesta
 *   - Acciones de gestión → PAUSAR/ACTIVAR/MSG/PAGAR/etc.
 *   - Preguntas generales → responde directamente con IA
 *
 * Ejemplo: "#cuántos pedidos tenemos pendientes?"
 *          "#pausar 56987654321"
 *          "#quién compró más este mes?"
 */

const db           = require('../db/database');
const kapsoService = require('./kapso-whatsapp');
const Anthropic    = require('@anthropic-ai/sdk');

const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Schema del DB (read-only, para el prompt del agente IA) ──────────────────
const DB_SCHEMA = `
Tablas disponibles (PostgreSQL). Siempre filtra por organization_id = <org_id>.

conversations (id, organization_id, phone_number, contact_name, agent_mode['ai'|'human'], unread_count, last_message, last_message_at, created_at)
messages (id, conversation_id, direction['inbound'|'outbound'], content, type, status, sent_by, agent_type, created_at)
contacts (id, organization_id, phone, name, email, city, address, client_type['empresa'|'persona'|null], created_at, updated_at)
orders (id, organization_id, conversation_id, customer_phone, customer_name, status['draft'|'sent'|'payment_received'|'completed'|'cancelled'], total_price, items jsonb, created_at, updated_at)
products (id, organization_id, title, handle, price, compare_at_price, available, vendor, product_type, tags, created_at)
users (id, organization_id, email, name, role, whatsapp_phone, wa_notifications jsonb)
`.trim();

// ─── Prompt del sistema para el agente IA ────────────────────────────────────
function buildSystemPrompt(orgId) {
  return `Eres un asistente CRM inteligente para un negocio. Respondes consultas de los agentes del negocio que te escriben por WhatsApp.

Tienes acceso a la base de datos PostgreSQL del negocio. El organization_id de este negocio es ${orgId}.

${DB_SCHEMA}

REGLAS CRÍTICAS:
1. NUNCA generes SQL que modifique datos (INSERT, UPDATE, DELETE, DROP, etc.). Solo SELECT.
2. SIEMPRE incluye WHERE organization_id = ${orgId} (o filtra por conversation que pertenece a la org).
3. Para consultas de datos, devuelve un objeto JSON con este formato exacto:
   {"action":"sql","query":"SELECT ... FROM ... WHERE organization_id = ${orgId} ...","explanation":"qué hace esta consulta"}
4. Para acciones de gestión (pausar bot, activar bot, enviar mensaje, marcar pago), devuelve:
   {"action":"manage","command":"PAUSAR|ACTIVAR|MSG|PAGAR","params":{"phone":"...","text":"...","orderId":123}}
5. Para preguntas generales o conversacionales que no requieren datos ni acciones, devuelve:
   {"action":"answer","text":"tu respuesta en español"}
6. Para mostrar ayuda, devuelve:
   {"action":"help"}

Responde ÚNICAMENTE con el JSON, sin texto adicional, sin markdown, sin explicaciones fuera del JSON.

Ejemplos:
- "cuántos pedidos pendientes hay" → {"action":"sql","query":"SELECT COUNT(*) FROM orders WHERE organization_id = ${orgId} AND status IN ('sent','draft','payment_received')","explanation":"pedidos pendientes"}
- "pausar 56987654321" → {"action":"manage","command":"PAUSAR","params":{"phone":"56987654321"}}
- "qué hace este sistema" → {"action":"answer","text":"Soy tu asistente CRM..."}
- "ayuda" → {"action":"help"}`;
}

// ─── Texto de ayuda ───────────────────────────────────────────────────────────
const HELP_TEXT = `🤖 *Asistente CRM con IA*
_Escribe con # para activar el agente_

Puedes preguntarme cualquier cosa sobre el negocio en lenguaje natural:

📊 *Consultas de datos:*
• _#cuántos pedidos hay pendientes?_
• _#qué clientes no compran hace 2 semanas?_
• _#cuál fue la venta total este mes?_
• _#quién es el cliente que más compra?_

⚙️ *Gestión:*
• _#pausar 56987654321_ — pausa el bot
• _#activar 56987654321_ — reactiva el bot
• _#msg 56987654321 Hola!_ — envía mensaje
• _#pagar 42_ — marca pedido como pagado
• _#chats_ — conversaciones activas
• _#pedidos_ — pedidos pendientes

_Los mensajes sin # van al chat normal del bot._`;

// ─── Función principal ────────────────────────────────────────────────────────
async function handleAgentCommand(org, wc, agent, text) {
  const raw = (text || '').trim();
  try {
    const reply = await processAICommand(org, wc, agent, raw);
    if (reply) {
      await kapsoService.sendTextMessage(agent.whatsapp_phone, reply, wc).catch(err =>
        console.warn('[AgentCmd] No se pudo enviar respuesta al agente:', err.message)
      );
    }
  } catch (err) {
    console.error('[AgentCmd] Error procesando comando:', err.message);
    await kapsoService.sendTextMessage(
      agent.whatsapp_phone,
      `❌ Error procesando tu consulta: ${err.message.slice(0, 100)}`,
      wc
    ).catch(() => {});
  }
}

async function processAICommand(org, wc, agent, raw) {
  console.log(`[AgentCmd] 🤖 ${agent.name || agent.email}: "${raw.slice(0, 100)}"`);

  // ── Parsear intención con Claude Haiku ──
  let parsed;
  try {
    const aiRes = await aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: buildSystemPrompt(org.id),
      messages: [{ role: 'user', content: raw }],
    });
    const jsonText = aiRes.content[0]?.text?.trim() || '{}';
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error('[AgentCmd] Error llamando IA:', err.message);
    // Fallback: tratar como ayuda
    return HELP_TEXT;
  }

  const action = parsed.action;

  // ── Ayuda ──
  if (action === 'help') {
    return HELP_TEXT;
  }

  // ── Respuesta directa ──
  if (action === 'answer') {
    return parsed.text || '🤔 No entendí tu consulta.';
  }

  // ── Consulta SQL ──
  if (action === 'sql') {
    return await executeSqlQuery(org, parsed.query, parsed.explanation, raw);
  }

  // ── Acciones de gestión ──
  if (action === 'manage') {
    return await executeManageCommand(org, wc, agent, parsed.command, parsed.params || {});
  }

  return `🤔 No entendí tu consulta. Escribe _#ayuda_ para ver qué puedo hacer.`;
}

// ─── Ejecutar consulta SQL segura ─────────────────────────────────────────────
async function executeSqlQuery(org, query, explanation, originalQuestion) {
  // Validación de seguridad: solo permitir SELECT
  const normalized = (query || '').trim().toUpperCase();
  if (!normalized.startsWith('SELECT')) {
    return `❌ Solo puedo ejecutar consultas de lectura (SELECT).`;
  }
  // Bloquear keywords peligrosas
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE|pg_sleep|pg_read_file)\b/i;
  if (dangerous.test(query)) {
    return `❌ Consulta no permitida por seguridad.`;
  }

  let rows;
  try {
    const pool = db.getPool();
    const result = await pool.query(query);
    rows = result.rows;
  } catch (err) {
    console.error('[AgentCmd] Error SQL:', err.message, '\nQuery:', query);
    return `❌ Error en la consulta: ${err.message.slice(0, 120)}`;
  }

  if (!rows || rows.length === 0) {
    return `📭 No encontré resultados para: _${explanation || originalQuestion}_`;
  }

  // Formatear resultado con IA
  const formattedResult = await formatSqlResult(rows, originalQuestion, explanation);
  return formattedResult;
}

// ─── Formatear resultado de SQL en lenguaje natural ───────────────────────────
async function formatSqlResult(rows, question, explanation) {
  const MAX_ROWS = 20;
  const truncated = rows.length > MAX_ROWS;
  const sample = rows.slice(0, MAX_ROWS);

  const dataStr = JSON.stringify(sample, null, 2);

  const prompt = `Eres un asistente CRM. Formatea estos datos de base de datos como una respuesta clara y concisa en español para WhatsApp.

Pregunta original: "${question}"
${explanation ? `Consulta ejecutada: ${explanation}` : ''}
${truncated ? `Nota: Se muestran ${MAX_ROWS} de ${rows.length} resultados totales.` : ''}

Datos:
${dataStr}

Responde de forma directa y útil, usando formato WhatsApp (*negrita*, _cursiva_). Máximo 600 caracteres. Si son números, muéstralos con formato legible (ej: $1.234.567). No incluyas el JSON crudo.`;

  try {
    const res = await aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    let text = res.content[0]?.text?.trim() || '';
    if (truncated) {
      text += `\n\n_Mostrando ${MAX_ROWS} de ${rows.length} resultados_`;
    }
    return text;
  } catch (err) {
    // Fallback: mostrar datos en texto plano
    const lines = sample.map(r => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | '));
    return `📊 *${explanation || 'Resultado'}*\n\n` + lines.join('\n');
  }
}

// ─── Ejecutar comandos de gestión ─────────────────────────────────────────────
async function executeManageCommand(org, wc, agent, command, params) {
  switch ((command || '').toUpperCase()) {
    case 'PAUSAR':
    case 'PAUSA':
      if (!params.phone) return '❌ Indica el teléfono. Ej: _#pausar 56987654321_';
      return await cmdPausar(org, params.phone, agent);

    case 'ACTIVAR':
    case 'REACTIVAR':
      if (!params.phone) return '❌ Indica el teléfono. Ej: _#activar 56987654321_';
      return await cmdActivar(org, params.phone);

    case 'MSG':
    case 'RESPONDER':
      if (!params.phone || !params.text) return '❌ Indica teléfono y mensaje. Ej: _#msg 56987654321 Hola!_';
      return await cmdMsg(org, params.phone, params.text, agent, wc);

    case 'PAGAR':
      if (!params.orderId) return '❌ Indica el ID del pedido. Ej: _#pagar 42_';
      return await cmdPagar(org, parseInt(params.orderId));

    case 'CHATS':
    case 'CONVERSACIONES':
      return await cmdChats(org);

    case 'PEDIDOS':
      return await cmdPedidos(org);

    case 'ESTADO':
      return cmdEstado(agent);

    default:
      return `❓ Acción no reconocida: ${command}\n\nEscribe _#ayuda_ para ver las opciones.`;
  }
}

// ─── Implementaciones de acciones ─────────────────────────────────────────────

async function cmdChats(org) {
  const convs = await db.getAllConversations(org.id);
  if (!convs.length) return '📭 No hay conversaciones activas.';

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
  return `💬 *Conversaciones* (${Math.min(10, total)} de ${total})\n🔴 = sin leer  🟡 = agente activo\n\n` + lines.join('\n');
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

  return `📦 *Pedidos pendientes* (${pending.length})\n\n` + lines.join('\n') + '\n\n_Escribe #pagar <id> para confirmar pago_';
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
    `_Usa #msg ${conv.phone_number} <texto> para responder_`,
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

  const targetPhone = convRows.length ? convRows[0].phone_number : normalized;
  const conv = convRows.length
    ? convRows[0]
    : await db.upsertConversation(org.id, targetPhone, null);

  const sent = await kapsoService.sendTextMessage(targetPhone, msgText, wc).catch(err => {
    console.error('[AgentCmd] Error enviando msg al cliente:', err.message);
    return null;
  });

  if (!sent) return `❌ No se pudo enviar el mensaje a ${targetPhone}.`;

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
    return `ℹ️ El bot ya estaba pausado para *${conv.contact_name || phone}*.\nUsa _#activar ${phone}_ para reactivarlo.`;
  }

  await db.setAgentMode(conv.id, 'human');
  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  return `🟡 Bot pausado para *${name}*.\nAhora puedes atenderle directamente. Escribe _#msg ${conv.phone_number} <texto>_ para responder.\nUsa _#activar ${conv.phone_number}_ cuando termines.`;
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

function cmdEstado(agent) {
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

module.exports = { handleAgentCommand };
