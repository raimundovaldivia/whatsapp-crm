const express = require('express');
const router = require('express').Router();
const db = require('../db/database');
const { getPool } = require('../db/database');
const whatsappService = require('../services/whatsapp');
const twilioService   = require('../services/twilio-whatsapp');
const kapsoService    = require('../services/kapso-whatsapp');
const { notifyAdminHandoff } = require('../services/notifications');
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
    const { unread } = req.query;
    res.json({ success: true, data: await db.getAllConversations(req.orgId, { unreadOnly: unread === 'true' }) });
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

    // Notificar al admin si se cambia a modo humano manualmente desde el CRM
    if (mode === 'human') {
      notifyAdminHandoff(req.orgId, conv, 'Cambio manual desde el CRM');
    }

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
 * POST /api/conversations/:id/orders
 * Crear una orden manual desde el panel admin.
 * Body: { items: [{productId, title, price, quantity}], sendSummary: boolean }
 */
router.post('/:id/orders', async (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    const conv   = await db.getConversationById(convId, req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const { items = [], sendSummary = true } = req.body;
    if (!items.length) return res.status(400).json({ success: false, error: 'Agrega al menos un producto' });

    const totalPrice = items.reduce((s, i) => s + (parseFloat(i.price) * parseInt(i.quantity || 1)), 0);

    const order = await db.createOrder({
      conversationId: convId,
      organizationId: req.orgId,
      items,
      customerName:    conv.contact_name || conv.phone_number,
      customerPhone:   conv.phone_number,
      shippingAddress: {},
      totalPrice,
    });

    // Guardar mensaje de resumen en el chat y enviarlo al cliente
    if (sendSummary) {
      const lines = items.map(i => `• ${i.title} x${i.quantity || 1} — $${(parseFloat(i.price) * parseInt(i.quantity || 1)).toLocaleString('es-CL')}`);
      const summary = `🛒 *Pedido #${order.id} generado*\n\n${lines.join('\n')}\n\n*Total: $${totalPrice.toLocaleString('es-CL')}*\n\nTe contactaremos para coordinar la entrega y el pago.`;

      const wc = await db.getWhatsappConfig(req.orgId);
      if (wc) {
        try {
          const provider = wc.provider || 'kapso';
          if (provider === 'kapso') {
            await require('../services/kapso-whatsapp').sendTextMessage(conv.phone_number, summary, wc);
          } else if (provider === 'twilio') {
            await require('../services/twilio-whatsapp').sendTextMessage(conv.phone_number, summary, wc);
          } else {
            await require('../services/whatsapp').sendTextMessage(conv.phone_number, summary, wc);
          }
        } catch (_) { /* no bloquear si el WA falla */ }
      }
      const savedMsg = await db.saveMessage({
        conversationId:    convId,
        whatsappMessageId: `order_${order.id}_${Date.now()}`,
        content:           summary,
        direction:         'outbound',
        type:              'text',
        sentBy:            'human',
      });
      await db.updateConversationLastMessage(convId, summary);
      const updatedConv = await db.getConversationById(convId);
      const io = req.app.get('io');
      io?.emit(`new_message_${req.orgId}`, { message: savedMsg, conversation: updatedConv });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('[Conversations/createOrder]', err.message);
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

/**
 * POST /api/conversations/merge-duplicates
 * Encuentra conversaciones duplicadas (mismo teléfono con/sin '+') y las fusiona.
 * Mantiene la que tiene más mensajes y borra la otra.
 */
router.post('/merge-duplicates', async (req, res) => {
  const pool = getPool();
  try {
    // 1. Normalizar: quitar '+' de todos los phone_number en esta org
    await pool.query(
      `UPDATE conversations
         SET phone_number = REGEXP_REPLACE(phone_number, '^\\+', ''), updated_at = NOW()
       WHERE organization_id = $1 AND phone_number LIKE '+%'`,
      [req.orgId]
    );

    // 2. Encontrar duplicados que aún persistan (mismo número, distintos IDs)
    const dups = await pool.query(
      `SELECT phone_number, ARRAY_AGG(id ORDER BY
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) DESC,
          c.created_at ASC
       ) AS ids
       FROM conversations c
       WHERE organization_id = $1
       GROUP BY phone_number
       HAVING COUNT(*) > 1`,
      [req.orgId]
    );

    let merged = 0;
    for (const row of dups.rows) {
      const [keepId, ...dupeIds] = row.ids;
      for (const dupeId of dupeIds) {
        // Reasignar mensajes del duplicado al que se conserva
        await pool.query(
          'UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2',
          [keepId, dupeId]
        );
        // Copiar el nombre si el que se conserva no tiene uno real
        const dupe = await pool.query('SELECT contact_name FROM conversations WHERE id = $1', [dupeId]);
        const dupeName = dupe.rows[0]?.contact_name;
        if (dupeName && !/^\d+$/.test(dupeName) && dupeName !== 'Cliente') {
          await pool.query(
            `UPDATE conversations SET contact_name = $1, updated_at = NOW()
             WHERE id = $2 AND (contact_name IS NULL OR contact_name = 'Cliente' OR contact_name ~ '^[0-9]+$')`,
            [dupeName, keepId]
          );
        }
        await pool.query('DELETE FROM conversations WHERE id = $1', [dupeId]);
        merged++;
      }
    }

    // 3. También normalizar teléfonos en la tabla contacts
    await pool.query(
      `UPDATE contacts
         SET phone = REGEXP_REPLACE(phone, '^\\+', ''), updated_at = NOW()
       WHERE organization_id = $1 AND phone LIKE '+%'`,
      [req.orgId]
    );

    res.json({ success: true, normalizedWithPlus: true, mergedConversations: merged });
  } catch (err) {
    console.error('[merge-duplicates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
