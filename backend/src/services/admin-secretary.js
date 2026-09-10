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

  // Formatear historial de la conversación con el cliente
  const customerHistoryStr = session.customerHistory
    .filter(m => m.content && !m.content.startsWith('[Template') && !m.content.startsWith('🎤'))
    .map(m => {
      const who = m.direction === 'inbound' ? 'Cliente' : 'Bot';
      return `${who}: ${m.content.slice(0, 160)}`;
    })
    .join('\n');

  const systemPrompt = `Eres la secretaria virtual de un negocio de WhatsApp. Sos el puente inteligente entre el ejecutivo y los clientes.

CLIENTE ACTUAL: ${session.customerName} (${session.customerPhone})

CONVERSACIÓN DEL CLIENTE (más reciente al final):
${customerHistoryStr || '(sin historial disponible)'}

TU ROL:
- Cuando el ejecutivo hace una PREGUNTA sobre el cliente, el pedido o la situación → respondele solo a él con la información que tenés. No mandes nada al cliente.
- Cuando el ejecutivo da una INSTRUCCIÓN de qué responderle al cliente → generá el mensaje apropiado y enviáselo al cliente.
- Cuando el ejecutivo dice que quiere atender él directamente → hacé el handoff.

ESTILO DEL MENSAJE AL CLIENTE (cuando type=send):
- Máximo 2-3 líneas, tono cálido y directo como alguien del equipo
- Usá el nombre del cliente si está disponible
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
    // Fallback si Claude no devuelve JSON válido: tratar como instrucción de envío
    result = {
      type:            'send',
      adminMessage:    'Entendido, enviando al cliente.',
      customerMessage: adminText,
    };
  }

  // Guardar este turno en el historial admin-bot
  session.adminHistory = [
    ...messages,
    { role: 'assistant', content: JSON.stringify(result) },
  ];

  return { ...result, session };
}

module.exports = { processAdminMessage, closeSession, getSession, openSession };
