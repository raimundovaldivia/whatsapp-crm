/**
 * admin-secretary.js — Secretaria virtual entre el ejecutivo y el bot
 *
 * Cuando el bot necesita ayuda, inicia una conversación natural con el admin.
 * El admin puede:
 *   - Preguntar sobre el cliente ("¿qué pidió exactamente?")  → bot responde solo al admin
 *   - Dar instrucciones ("dile que llega mañana")             → bot genera y envía al cliente
 *   - Querer atender directo ("yo lo manejo", "tomar")        → bot hace handoff
 *
 * La sesión dura mientras el admin sigue respondiendo (timeout: 45 min).
 */

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Sesiones activas: una por org ───────────────────────────────────────────
const SESSION_TIMEOUT_MS = 45 * 60 * 1000; // 45 min de inactividad → cierra sesión
const sessions = new Map(); // orgId (string) → session

function getSession(orgId) {
  const session = sessions.get(String(orgId));
  if (!session) return null;
  if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(String(orgId));
    return null;
  }
  return session;
}

async function openSession(orgId, pending) {
  const conv     = await db.getConversationById(pending.conversation_id).catch(() => null);
  const messages = await db.getLastMessages(pending.conversation_id, 14).catch(() => []);

  const session = {
    orgId:         String(orgId),
    convId:        pending.conversation_id,
    pendingId:     pending.id,
    customerPhone: pending.customer_phone,
    customerName:  conv?.contact_name || pending.customer_phone,
    customerHistory: messages,
    adminHistory:  [], // turnos admin↔bot (para multi-turno)
    lastActivity:  Date.now(),
  };
  sessions.set(String(orgId), session);
  return session;
}

function closeSession(orgId) {
  sessions.delete(String(orgId));
}

function touchSession(orgId) {
  const s = sessions.get(String(orgId));
  if (s) s.lastActivity = Date.now();
}

// ─── Procesamiento principal ──────────────────────────────────────────────────

/**
 * Procesa un mensaje del admin en el contexto de la conversación activa.
 * @returns {{ type, adminMessage, customerMessage, session }}
 *   type: 'answer' | 'send' | 'takeover'
 *   adminMessage:   lo que le decimos al ejecutivo
 *   customerMessage: (solo si type=send) el texto generado para el cliente
 */
async function processAdminMessage(orgId, adminText, pending) {
  // Abrir o reusar sesión
  let session = getSession(orgId);
  if (!session) {
    if (!pending) return null;
    session = await openSession(orgId, pending);
  }
  touchSession(orgId);

  // Mantener el contexto del cliente actualizado durante coordinaciones largas.
  // Si el cliente escribió mientras el administrador pensaba la respuesta,
  // Diva debe conocerlo antes de interpretar la siguiente instrucción.
  session.customerHistory = await db.getLastMessages(session.convId, 20)
    .catch(() => session.customerHistory);

  // Formatear historial de la conversación con el cliente
  const customerHistoryStr = session.customerHistory
    .filter(m => m.content && !m.content.startsWith('[Template') && !m.content.startsWith('🎤'))
    .map(m => {
      const who = m.direction === 'inbound' ? 'Cliente' : 'Bot';
      return `${who}: ${m.content.slice(0, 160)}`;
    })
    .join('\n');

  const systemPrompt = `Tu nombre es Diva. Eres la asistente de coordinación de un negocio de WhatsApp y trabajas junto al administrador para resolver conversaciones reales con clientes.

CLIENTE ACTUAL: ${session.customerName} (${session.customerPhone})

CONVERSACIÓN DEL CLIENTE (más reciente al final):
${customerHistoryStr || '(sin historial disponible)'}

TU ROL:
- Cuando el ejecutivo hace una PREGUNTA sobre el cliente, el pedido o la situación → respóndele solo a él con la información disponible. No mandes nada al cliente.
- Cuando el ejecutivo da una INSTRUCCIÓN de qué responderle al cliente → prepara el mensaje apropiado para enviarlo al cliente.
- Cuando el ejecutivo dice que quiere atender él directamente → haz el handoff.
- Entiende referencias de los turnos anteriores como "dile eso", "confírmale" o "mejor mañana", pero solo si el dato referido es inequívoco.
- Conserva literalmente fechas, horas, precios, direcciones y compromisos indicados por el administrador. No los suavices ni los completes por intuición.
- No inventes información ni prometas acciones fuera de estas capacidades. Si falta un dato indispensable, haz una sola pregunta concreta.

ESTILO CON EL ADMINISTRADOR:
- Habla como una colega eficiente: primero la respuesta o decisión, después un siguiente paso breve cuando ayude.
- Evita repetir el contexto completo, saludar en cada turno o responder con frases genéricas.
- Si no hay evidencia suficiente, dilo directamente y especifica qué dato falta.

ESTILO DEL MENSAJE AL CLIENTE (cuando type=send):
- Máximo 2-3 líneas, tono cálido, natural y directo como alguien real del equipo
- Usa el nombre solo cuando suene natural; no lo repitas en todos los mensajes
- Responde exactamente a lo último que preguntó el cliente y reconoce su emoción si está molesto o preocupado
- No repitas información que el cliente ya confirmó ni hagas más de una pregunta a la vez
- Sin asteriscos, sin listas, sin markdown

Respondé ÚNICAMENTE con JSON válido, sin explicaciones adicionales:
{
  "type": "answer" | "send" | "takeover",
  "adminMessage": "lo que le decís al ejecutivo (confirmación, respuesta, etc.)",
  "customerMessage": "mensaje para el cliente — SOLO si type es send"
}`;

  // Historial multi-turno de la conversación admin-bot
  const messages = [
    ...session.adminHistory,
    { role: 'user', content: adminText },
  ];

  let result;
  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system:     systemPrompt,
      messages,
    });

    const raw = response.content[0]?.text?.trim() || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    result = JSON.parse(cleaned);
  } catch {
    // Si la respuesta no es segura, Diva pide aclaración y no envía nada.
    result = {
      type:            'answer',
      adminMessage:    'No pude interpretar la instrucción con seguridad. ¿Puedes indicarme nuevamente qué deseas responderle al cliente?',
      customerMessage: '',
    };
  }

  // Guardar este turno en el historial admin-bot
  session.adminHistory = [
    ...messages,
    { role: 'assistant', content: JSON.stringify(result) },
  ].slice(-10);

  return { ...result, session };
}

module.exports = { processAdminMessage, closeSession, getSession, openSession };
