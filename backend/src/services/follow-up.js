/**
 * follow-up.js — Recupera conversaciones abandonadas dentro de la ventana de 24h
 *
 * Corre cada 30 minutos. Detecta clientes que mostraron interés pero dejaron
 * de responder. Genera mensajes humanos y contextuales con Claude Haiku y los
 * envía gratis (dentro de la ventana de 24h de WhatsApp).
 *
 * NUNCA menciona "ventana", "bot", "sistema" ni nada técnico al cliente.
 * Suena como alguien de la tienda que se acordó del cliente.
 */

const Anthropic        = require('@anthropic-ai/sdk');
const db               = require('../db/database');
const kapsoService     = require('./kapso-whatsapp');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FOLLOW_UP_PROMPT = `Eres alguien que trabaja en una tienda y vas a escribirle a un cliente que estaba interesado pero dejó de responder.

CONTEXTO DE LA TIENDA: {STORE_CONTEXT}

ÚLTIMOS MENSAJES DE LA CONVERSACIÓN:
{HISTORIAL}

ESTADO DEL PEDIDO EN PROGRESO: {ORDER_DRAFT}

HORA CHILENA ACTUAL: {HORA}

Tu tarea: escribe UN solo mensaje de WhatsApp para retomar la conversación.

REGLAS CRÍTICAS:
- Máximo 2 líneas
- Tono casual y cálido, como un amigo del negocio
- Referencia algo específico de la conversación (el producto que vio, su nombre si lo sabes, etc.)
- Crea urgencia REAL si aplica (stock limitado, horario de entrega de hoy, etc.)
- NUNCA menciones "ventana de chat", "bot", "sistema", "recordatorio automático" ni nada técnico
- NUNCA seas genérico: "Hola, ¿necesitas ayuda?" está PROHIBIDO
- Usa emojis con moderación (1-2 máximo)
- Si es de noche (después de las 21h), espera y no envíes nada (devuelve exactamente: SKIP)
- Si el cliente ya confirmó pedido, devuelve exactamente: SKIP

Solo el mensaje, nada más. Sin comillas.`;

async function generateFollowUpMessage(conv, history, storeContext) {
  const orderDraft = (() => { try { return JSON.parse(conv.order_draft || '{}'); } catch { return {}; } })();
  const draftStr = Object.keys(orderDraft).length > 0
    ? JSON.stringify(orderDraft)
    : 'Ninguno — el cliente mostró interés pero no llegó a dar datos';

  const historialStr = history
    .slice(-6)
    .map(m => `${m.direction === 'inbound' ? `${conv.contact_name || 'Cliente'}` : 'Nosotros'}: ${m.content}`)
    .join('\n');

  const hora = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });

  const system = FOLLOW_UP_PROMPT
    .replace('{STORE_CONTEXT}', storeContext || 'Tienda online, productos de calidad.')
    .replace('{HISTORIAL}', historialStr || 'Sin mensajes previos')
    .replace('{ORDER_DRAFT}', draftStr)
    .replace('{HORA}', hora);

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 120,
    system,
    messages:   [{ role: 'user', content: 'Genera el mensaje de seguimiento.' }],
  });

  const text = response.content[0]?.text?.trim() || '';
  return text;
}

async function runFollowUp(io = null) {
  let sent = 0, skipped = 0;

  try {
    const stalled = await db.getStalledConversations();
    if (!stalled.length) return;

    console.log(`[FollowUp] 🔍 ${stalled.length} conversación(es) abandonada(s) encontradas`);

    for (const conv of stalled) {
      try {
        // Obtener historial y configuración de la org
        const history      = await db.getLastMessages(conv.id, 8);
        const storeContext = await db.getSetting(conv.organization_id, 'store_context') || '';

        // Generar mensaje con IA
        const message = await generateFollowUpMessage(conv, history, storeContext);

        if (!message || message === 'SKIP') {
          console.log(`[FollowUp] SKIP conv ${conv.id} (${conv.contact_name})`);
          skipped++;
          continue;
        }

        // Obtener config de WhatsApp de la org
        const whatsappConfig = await db.getWhatsappConfig(conv.organization_id);
        if (!whatsappConfig) {
          console.warn(`[FollowUp] Sin WhatsApp config para org ${conv.organization_id}`);
          continue;
        }

        // Enviar el mensaje
        await kapsoService.sendTextMessage(conv.phone_number, message, whatsappConfig);

        // Guardar en DB y marcar follow-up enviado
        await db.saveMessage({
          conversationId:    conv.id,
          whatsappMessageId: null,
          direction:         'outbound',
          content:           message,
          sentBy:            'ai',
          agentType:         'follow_up',
        });
        await db.updateConversationLastMessage(conv.id, message, false);
        await db.updateFollowUpSent(conv.id);

        // Notificar al panel en tiempo real
        if (io) {
          const updatedConv = await db.getConversationById(conv.id);
          io.emit(`new_message_${conv.organization_id}`, {
            message:      { conversationId: conv.id, direction: 'outbound', content: message, agentType: 'follow_up' },
            conversation: updatedConv,
          });
        }

        console.log(`[FollowUp] ✅ Mensaje enviado a ${conv.contact_name} (${conv.phone_number}): "${message.slice(0, 60)}..."`);
        sent++;

        // Pausa entre envíos para no saturar la API
        await new Promise(r => setTimeout(r, 1500));

      } catch (convErr) {
        console.error(`[FollowUp] Error procesando conv ${conv.id}:`, convErr.message);
      }
    }

    if (sent > 0 || skipped > 0) {
      console.log(`[FollowUp] ✅ Resumen: ${sent} enviados, ${skipped} saltados`);
    }

  } catch (err) {
    console.error('[FollowUp] Error general:', err.message);
  }
}

/**
 * Inicia el job de follow-up con intervalo de 30 minutos.
 * @param {object} io - instancia de Socket.IO (opcional)
 */
function startFollowUpJob(io = null) {
  const INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

  console.log('[FollowUp] 🚀 Job iniciado — corre cada 30 minutos');

  // Primera corrida después de 5 minutos del arranque (para no saturar el inicio)
  setTimeout(() => {
    runFollowUp(io);
    setInterval(() => runFollowUp(io), INTERVAL_MS);
  }, 5 * 60 * 1000);
}

module.exports = { startFollowUpJob, runFollowUp };
