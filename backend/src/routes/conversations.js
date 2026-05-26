const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { getPool } = require('../db/database');
const whatsappService = require('../services/whatsapp');
const twilioService   = require('../services/twilio-whatsapp');
const kapsoService    = require('../services/kapso-whatsapp');
const { requireAuth } = require('../middleware/auth');

let io;
function setSocketIO(socketIO) { io = socketIO; }

// Todas las rutas requieren auth
router.use(requireAuth);

/**
 * GET /api/conversations
 */
router.get('/', async (req, res) => {
  try {
    res.json({ success: true, data: await db.getAllConversations(req.orgId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/:id/messages
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    const messages = await db.getMessagesByConversation(conv.id, parseInt(req.query.limit) || 50);
    await db.markConversationAsRead(conv.id);
    res.json({ success: true, data: { conversation: conv, messages } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/messages — Mensaje manual
 */
router.post('/:id/messages', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, error: 'Texto vacío' });

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    // Enviar por el proveedor correcto según configuración
    let sentResult;
    try {
      if (wc.provider === 'twilio') {
        sentResult = await twilioService.sendTextMessage(conv.phone_number, text.trim(), wc);
      } else if (wc.provider === 'kapso') {
        sentResult = await kapsoService.sendTextMessage(conv.phone_number, text.trim(), wc);
      } else {
        sentResult = await whatsappService.sendTextMessage(conv.phone_number, text.trim(), wc);
      }
    } catch (sendErr) {
      if (sendErr.is24hWindow) {
        return res.status(400).json({
          success: false,
          error: 'WINDOW_EXPIRED',
          message: 'La ventana de 24 horas expiró. El cliente debe escribirte primero para que puedas responder.',
        });
      }
      throw sendErr;
    }

    const message = await db.saveMessage({
      conversationId: conv.id,
      whatsappMessageId: sentResult?.messageId || sentResult?.messages?.[0]?.id || null,
      direction: 'outbound',
      content: text.trim(),
      sentBy: 'human',
    });

    await db.updateConversationLastMessage(conv.id, text.trim());
    const updated = await db.getConversationById(conv.id);
    io?.emit(`new_message_${req.orgId}`, { message, conversation: updated });

    res.json({ success: true, data: message });
  } catch (err) {
    console.error('[Conv] Error enviando:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/agent-mode
 */
router.patch('/:id/agent-mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['ai', 'human'].includes(mode)) return res.status(400).json({ success: false, error: 'mode inválido' });

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    await db.setAgentMode(conv.id, mode);
    io?.emit(`agent_mode_changed_${req.orgId}`, { conversationId: conv.id, mode });

    res.json({ success: true, data: await db.getConversationById(conv.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/read
 */
router.patch('/:id/read', async (req, res) => {
  try {
    await db.markConversationAsRead(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/start
 * Inicia o reutiliza una conversación con un número y envía el primer mensaje.
 * Body: { phone: "56912345678", name?: "Juan", text: "Hola..." }
 */
router.post('/start', async (req, res) => {
  try {
    const { phone, name, text } = req.body;
    if (!phone?.trim()) return res.status(400).json({ success: false, error: 'Número de teléfono requerido' });
    if (!text?.trim())  return res.status(400).json({ success: false, error: 'Mensaje requerido' });

    // Normalizar el teléfono: solo dígitos, sin +
    const phoneNorm = phone.trim().replace(/^\+/, '').replace(/\s/g, '');

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    // Buscar conversación existente con ese número
    const { rows: existing } = await getPool().query(
      `SELECT id FROM conversations WHERE organization_id = $1 AND phone_number = $2 LIMIT 1`,
      [req.orgId, phoneNorm]
    );

    let convId;
    if (existing.length > 0) {
      convId = existing[0].id;
    } else {
      // Crear nueva conversación
      const { rows: created } = await getPool().query(
        `INSERT INTO conversations (organization_id, phone_number, contact_name, last_message, agent_mode, pipeline_state)
         VALUES ($1, $2, $3, $4, 'human', 'exploring') RETURNING id`,
        [req.orgId, phoneNorm, name?.trim() || phoneNorm, text.trim()]
      );
      convId = created[0].id;
    }

    // Enviar por el proveedor correcto
    let sentResult;
    if (wc.provider === 'twilio') {
      sentResult = await twilioService.sendTextMessage(phoneNorm, text.trim(), wc);
    } else if (wc.provider === 'kapso') {
      sentResult = await kapsoService.sendTextMessage(phoneNorm, text.trim(), wc);
    } else {
      sentResult = await whatsappService.sendTextMessage(phoneNorm, text.trim(), wc);
    }

    const message = await db.saveMessage({
      conversationId: convId,
      whatsappMessageId: sentResult?.messages?.[0]?.id || null,
      direction: 'outbound',
      content: text.trim(),
      sentBy: 'human',
    });

    await db.updateConversationLastMessage(convId, text.trim());
    const conv = await db.getConversationById(convId);
    io?.emit(`new_message_${req.orgId}`, { message, conversation: conv });

    res.json({ success: true, data: { conversationId: convId, message, conversation: conv } });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[Conv/start] Error:', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

/**
 * GET /api/conversations/:id/orders
 */
router.get('/:id/orders', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM orders WHERE conversation_id = $1 AND organization_id = $2 ORDER BY created_at DESC',
      [parseInt(req.params.id), req.orgId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/escalation-feedback
 * Guarda si la escalación fue correcta o innecesaria
 * Body: { feedback: 'correct' | 'unnecessary' }
 */
router.post('/:id/escalation-feedback', async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!['correct', 'unnecessary'].includes(feedback)) {
      return res.status(400).json({ success: false, error: 'feedback debe ser correct o unnecessary' });
    }

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    // Guardar feedback
    await db.saveEscalationFeedback(
      req.orgId,
      conv.id,
      conv.last_escalation_trigger || '',
      conv.last_escalation_reason  || '',
      feedback
    );

    // Limpiar el contexto de escalación para no mostrar los botones de nuevo
    await db.clearLastEscalation(conv.id);

    // Contar cuántos negativos hay para loggear
    const negCount = feedback === 'unnecessary' ? 1 : 0;
    if (negCount > 0) {
      console.log(`[Feedback] ❌ Escalación innecesaria registrada para conv ${conv.id}: "${conv.last_escalation_trigger?.slice(0,50)}"`);
    } else {
      console.log(`[Feedback] ✅ Escalación correcta confirmada para conv ${conv.id}`);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/send-template
 * Envía un template de WhatsApp a una conversación específica.
 * Útil cuando la ventana de 24h ha expirado.
 * Body: { templateName, languageCode?, components? }
 *   components ejemplo: [{ type: 'body', parameters: [{ type: 'text', text: 'Juan' }] }]
 */
router.post('/:id/send-template', async (req, res) => {
  try {
    const { templateName, languageCode, components, previewText } = req.body;
    if (!templateName?.trim()) {
      return res.status(400).json({ success: false, error: 'templateName requerido' });
    }

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
      return res.status(400).json({ success: false, error: 'Templates solo disponibles con Kapso o Meta' });
    }

    const kapsoService = require('../services/kapso-whatsapp');
    const sentResult = await kapsoService.sendTemplate(
      conv.phone_number,
      templateName.trim(),
      languageCode || 'es',
      components || [],
      wc
    );

    const savedContent = previewText
      ? `[Template: ${templateName.trim()}]\n\n${previewText}`
      : `[Template: ${templateName.trim()}]`;

    const message = await db.saveMessage({
      conversationId:    conv.id,
      whatsappMessageId: sentResult?.messages?.[0]?.id || null,
      direction:         'outbound',
      content:           savedContent,
      sentBy:            'human',
      agentType:         null,
    });

    await db.updateConversationLastMessage(conv.id, `[Template enviado: ${templateName.trim()}]`);
    const updated = await db.getConversationById(conv.id);
    io?.emit(`new_message_${req.orgId}`, { message, conversation: updated });

    res.json({ success: true, data: message });
  } catch (err) {
    console.error('[Conv/send-template] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/conversations/:id/messages
 * Borra todos los mensajes de una conversación y resetea su estado.
 * Solo disponible para raivaldiviabou@gmail.com (uso en testing).
 */
router.delete('/:id/messages', async (req, res) => {
  try {
    // Verificar que el usuario es el dev autorizado
    const user = await db.getUserById(req.userId);
    if (!user || user.email !== 'raivaldiviabou@gmail.com') {
      return res.status(403).json({ success: false, error: 'No autorizado' });
    }

    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const pool = getPool();

    // Borrar todos los mensajes
    const { rowCount } = await pool.query(
      'DELETE FROM messages WHERE conversation_id = $1',
      [conv.id]
    );

    // Resetear estado de la conversación
    await pool.query(
      `UPDATE conversations SET
        pipeline_state         = 'exploring',
        order_draft            = '{}',
        agent_mode             = 'ai',
        last_message           = NULL,
        last_message_at        = CURRENT_TIMESTAMP,
        unread_count           = 0,
        last_escalation_trigger = NULL,
        last_escalation_reason  = NULL,
        last_escalation_at      = NULL,
        updated_at             = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [conv.id]
    );

    console.log(`[DevTool] 🗑️  ${rowCount} mensajes borrados en conv ${conv.id} por ${user.email}`);

    const freshConv = await db.getConversationById(conv.id);
    io?.emit(`new_message_${req.orgId}`, { message: null, conversation: freshConv });

    res.json({ success: true, deleted: rowCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
