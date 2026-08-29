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

    // Normalizar el teléfono: con código de país, sin +
    const phoneNorm = db.normalizePhone(phone.trim());

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
 * PATCH /api/conversations/:id/pipeline-state
 * Permite cambiar manualmente el pipeline_state (ej: sacar a un cliente de hot lead)
 */
router.patch('/:id/pipeline-state', async (req, res) => {
  try {
    const { state, excludeHotLead } = req.body;
    const VALID = ['exploring', 'interested', 'collecting_order', 'awaiting_payment', 'done'];
    if (!VALID.includes(state)) {
      return res.status(400).json({ success: false, error: `Estado inválido. Válidos: ${VALID.join(', ')}` });
    }
    await db.updatePipelineState(parseInt(req.params.id), state);
    // Si se excluye de hot leads, marcar la bandera para que el scan no la vuelva a añadir
    if (excludeHotLead) {
      await getPool().query(
        'UPDATE conversations SET hot_lead_excluded = TRUE, updated_at = NOW() WHERE id = $1',
        [parseInt(req.params.id)]
      );
    }
    res.json({ success: true, state, excludeHotLead: !!excludeHotLead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/client-type
 * Marcar manualmente un contacto como "empresa" o "personal"
 */
router.patch('/:id/client-type', async (req, res) => {
  try {
    const { clientType } = req.body;
    if (!['personal', 'empresa'].includes(clientType)) {
      return res.status(400).json({ success: false, error: 'clientType debe ser "personal" o "empresa"' });
    }
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    const contact = await db.updateContactClientType(req.orgId, conv.phone_number, clientType);
    res.json({ success: true, clientType, contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

    const { items = [], sendSummary = true, shippingAddress = {} } = req.body;
    if (!items.length) return res.status(400).json({ success: false, error: 'Agrega al menos un producto' });

    const totalPrice = items.reduce((s, i) => s + (parseFloat(i.price) * parseInt(i.quantity || 1)), 0);

    // Resolver nombre y dirección desde contacts (fuente de verdad)
    let customerName = conv.contact_name;
    const rawPhone = conv.phone_number;
    const contact = await db.getContact(req.orgId, rawPhone);

    if (!customerName || customerName === rawPhone || /^\d+$/.test(customerName) || customerName === 'Cliente') {
      if (contact?.name && contact.name !== rawPhone && !/^\d+$/.test(contact.name)) {
        customerName = contact.name;
      }
    }
    customerName = customerName || rawPhone;

    // Dirección: usar la del modal; si está vacía, usar la del contacto como fallback
    let finalAddress = shippingAddress;
    const addrEmpty = !shippingAddress?.address && !shippingAddress?.address1;
    if (addrEmpty && contact?.address) {
      finalAddress = { address: contact.address, city: contact.city || '' };
    }

    const order = await db.createOrder({
      conversationId: convId,
      organizationId: req.orgId,
      items,
      customerName,
      customerPhone:   conv.phone_number,
      shippingAddress: finalAddress,
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
    let merged = 0;

    // ── Paso 1: Pares exactos con/sin '+' ────────────────────────────────
    // Busca conversaciones donde existe UNA con phone='56...' y OTRA con phone='+56...'
    // Mantiene la sin '+' (la del webhook), mueve mensajes, borra la con '+'.
    const pairs = await pool.query(
      `SELECT c_keep.id AS keep_id, c_dupe.id AS dupe_id,
              c_dupe.contact_name AS dupe_name, c_keep.contact_name AS keep_name
       FROM conversations c_keep
       JOIN conversations c_dupe
         ON c_dupe.organization_id = c_keep.organization_id
        AND c_dupe.phone_number = '+' || c_keep.phone_number
       WHERE c_keep.organization_id = $1
         AND c_keep.phone_number NOT LIKE '+%'`,
      [req.orgId]
    );

    for (const row of pairs.rows) {
      const { keep_id, dupe_id, dupe_name, keep_name } = row;
      // Mover mensajes del duplicado (con +) al que conservamos (sin +)
      await pool.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [keep_id, dupe_id]);
      // Copiar nombre si el duplicado tiene uno mejor
      const keepIsGeneric = !keep_name || keep_name === 'Cliente' || /^\d+$/.test(keep_name);
      if (dupe_name && !/^\d+$/.test(dupe_name) && dupe_name !== 'Cliente' && keepIsGeneric) {
        await pool.query('UPDATE conversations SET contact_name = $1, updated_at = NOW() WHERE id = $2', [dupe_name, keep_id]);
      }
      // Sincronizar last_message y last_message_at del que conservamos
      await pool.query(
        `UPDATE conversations c SET
           last_message = sub.last_message, last_message_at = sub.last_message_at, updated_at = NOW()
         FROM (SELECT content AS last_message, created_at AS last_message_at
               FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1) sub
         WHERE c.id = $1`,
        [keep_id]
      );
      await pool.query('DELETE FROM conversations WHERE id = $1', [dupe_id]);
      merged++;
    }

    // ── Paso 2: Pares sin código de país (9XXXXXXXX vs 569XXXXXXXX) ─────────
    // Busca conversaciones donde phone='9XXXXXXXX' y existe otra con phone='569XXXXXXXX'
    // Mantiene la que tiene más mensajes.
    const pairsNoCC = await pool.query(
      `SELECT
         c_long.id  AS keep_id,  c_long.contact_name  AS keep_name,
         c_short.id AS dupe_id,  c_short.contact_name AS dupe_name
       FROM conversations c_long
       JOIN conversations c_short
         ON c_short.organization_id = c_long.organization_id
        AND c_long.phone_number = '56' || c_short.phone_number
       WHERE c_long.organization_id = $1
         AND c_short.phone_number ~ '^9[0-9]{8}$'`,
      [req.orgId]
    );

    for (const row of pairsNoCC.rows) {
      const { keep_id, dupe_id, dupe_name, keep_name } = row;
      await pool.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [keep_id, dupe_id]);
      const keepIsGeneric = !keep_name || keep_name === 'Cliente' || /^\d+$/.test(keep_name);
      if (dupe_name && !/^\d+$/.test(dupe_name) && dupe_name !== 'Cliente' && keepIsGeneric) {
        await pool.query('UPDATE conversations SET contact_name = $1, updated_at = NOW() WHERE id = $2', [dupe_name, keep_id]);
      }
      await pool.query(
        `UPDATE conversations c SET
           last_message = sub.last_message, last_message_at = sub.last_message_at, updated_at = NOW()
         FROM (SELECT content AS last_message, created_at AS last_message_at
               FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1) sub
         WHERE c.id = $1`,
        [keep_id]
      );
      await pool.query('DELETE FROM conversations WHERE id = $1', [dupe_id]);
      merged++;
    }

    // ── Paso 3: 9XXXXXXXX vs +569XXXXXXXX ───────────────────────────────────
    // El caso que faltaba: número sin código de país vs con + y código de país
    const pairsShortVsPlusFull = await pool.query(
      `SELECT
         c_long.id  AS keep_id,  c_long.contact_name  AS keep_name,
         c_short.id AS dupe_id,  c_short.contact_name AS dupe_name
       FROM conversations c_long
       JOIN conversations c_short
         ON c_short.organization_id = c_long.organization_id
        AND c_long.phone_number = '56' || c_short.phone_number
       WHERE c_long.organization_id = $1
         AND c_short.phone_number ~ '^9[0-9]{8}$'
         AND c_long.phone_number ~ '^569[0-9]{8}$'`,
      [req.orgId]
    );

    // También buscar: 9XXXXXXXX vs +56XXXXXXXXX
    const pairsShortVsPlusFullInv = await pool.query(
      `SELECT
         c_full.id  AS keep_id,  c_full.contact_name  AS keep_name,
         c_short.id AS dupe_id,  c_short.contact_name AS dupe_name
       FROM conversations c_full
       JOIN conversations c_short
         ON c_short.organization_id = c_full.organization_id
        AND c_full.phone_number = '+56' || c_short.phone_number
       WHERE c_full.organization_id = $1
         AND c_short.phone_number ~ '^9[0-9]{8}$'`,
      [req.orgId]
    );

    for (const row of [...pairsShortVsPlusFull.rows, ...pairsShortVsPlusFullInv.rows]) {
      const { keep_id, dupe_id, dupe_name, keep_name } = row;
      await pool.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [keep_id, dupe_id]);
      const keepIsGeneric = !keep_name || keep_name === 'Cliente' || /^\d+$/.test(keep_name);
      if (dupe_name && !/^\d+$/.test(dupe_name) && dupe_name !== 'Cliente' && keepIsGeneric) {
        await pool.query('UPDATE conversations SET contact_name = $1, updated_at = NOW() WHERE id = $2', [dupe_name, keep_id]);
      }
      await pool.query(
        `UPDATE conversations c SET
           last_message = sub.last_message, last_message_at = sub.last_message_at, updated_at = NOW()
         FROM (SELECT content AS last_message, created_at AS last_message_at
               FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1) sub
         WHERE c.id = $1`,
        [keep_id]
      );
      await pool.query('DELETE FROM conversations WHERE id = $1', [dupe_id]);
      merged++;
    }

    // ── Paso 4: Normalizar phones en contacts (sin constraint issue) ──────
    // En contacts la clave es (organization_id, phone) — puede haber pares +/sin +
    // Borramos el '+' solo si NO existe ya uno sin '+' para esa org
    await pool.query(
      `DELETE FROM contacts
       WHERE organization_id = $1 AND phone LIKE '+%'
         AND EXISTS (
           SELECT 1 FROM contacts c2
           WHERE c2.organization_id = $1
             AND c2.phone = SUBSTRING(contacts.phone FROM 2)
         )`,
      [req.orgId]
    );
    // Los que quedan con '+' y no tienen duplicado: actualizarlos
    await pool.query(
      `UPDATE contacts SET phone = SUBSTRING(phone FROM 2), updated_at = NOW()
       WHERE organization_id = $1 AND phone LIKE '+%'`,
      [req.orgId]
    );

    // ── Paso 5: Normalizar conversations.phone_number a formato canónico ────
    // Conversaciones con phone 9XXXXXXXX (sin 56) que no tienen par → actualizar a 569XXXXXXXX
    await pool.query(
      `UPDATE conversations SET phone_number = '56' || phone_number, updated_at = NOW()
       WHERE organization_id = $1
         AND phone_number ~ '^9[0-9]{8}$'
         AND NOT EXISTS (
           SELECT 1 FROM conversations c2
           WHERE c2.organization_id = $1
             AND c2.phone_number = '56' || conversations.phone_number
         )`,
      [req.orgId]
    );
    // Conversaciones con phone +56XXXXXXXXX → quitar el +
    await pool.query(
      `UPDATE conversations SET phone_number = SUBSTRING(phone_number FROM 2), updated_at = NOW()
       WHERE organization_id = $1
         AND phone_number LIKE '+%'
         AND NOT EXISTS (
           SELECT 1 FROM conversations c2
           WHERE c2.organization_id = $1
             AND c2.phone_number = SUBSTRING(conversations.phone_number FROM 2)
         )`,
      [req.orgId]
    );

    res.json({ success: true, mergedConversations: merged });
  } catch (err) {
    console.error('[merge-duplicates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/search-by-phone?phone=xxx
 * Busca TODAS las conversaciones de un número en cualquier formato (56xxx, +56xxx, xxx sin prefijo).
 * Útil para diagnosticar chats perdidos y encontrar duplicados.
 */
router.get('/search-by-phone', async (req, res) => {
  const pool = getPool();
  try {
    const rawPhone = (req.query.phone || '').replace(/\s/g, '').replace(/^\+/, '');
    if (!rawPhone) return res.status(400).json({ success: false, error: 'Falta parámetro phone' });

    // Construir todas las variantes del número (normalizar primero a canónico 56XXXXXXXXX)
    let canonical = rawPhone;
    if (/^9\d{8}$/.test(canonical)) canonical = '56' + canonical;

    const variants = new Set([rawPhone]);
    if (/^569\d{8}$/.test(canonical)) {
      variants.add(canonical);              // 56991623745
      variants.add(canonical.slice(2));     // 991623745
      variants.add('+' + canonical);        // +56991623745
      variants.add('+' + canonical.slice(2)); // +991623745
    } else {
      variants.add('+' + rawPhone);
    }

    const placeholders = [...variants].map((_, i) => `$${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `SELECT c.id, c.phone_number, c.contact_name, c.pipeline_state, c.agent_mode,
              c.last_message_at, c.hot_lead_excluded,
              COUNT(m.id)::int AS message_count,
              MIN(m.created_at) AS first_message_at
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.organization_id = $1
         AND c.phone_number IN (${placeholders})
       GROUP BY c.id
       ORDER BY c.last_message_at DESC`,
      [req.orgId, ...[...variants]]
    );

    res.json({ success: true, phone: rawPhone, variants: [...variants], conversations: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/merge-into/:targetId
 * Fusiona UNA conversación específica (sourceId del body) dentro de targetId.
 * Mueve los mensajes y borra la conversación fuente.
 */
router.post('/merge-into/:targetId', async (req, res) => {
  const pool = getPool();
  try {
    const targetId = parseInt(req.params.targetId);
    const { sourceId } = req.body;
    if (!sourceId || !targetId || sourceId === targetId) {
      return res.status(400).json({ success: false, error: 'Parámetros inválidos' });
    }
    // Verificar que ambas son de esta org
    const target = await pool.query('SELECT id FROM conversations WHERE id = $1 AND organization_id = $2', [targetId, req.orgId]);
    const source = await pool.query('SELECT id FROM conversations WHERE id = $1 AND organization_id = $2', [sourceId, req.orgId]);
    if (!target.rows.length || !source.rows.length) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada' });
    }
    await pool.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [targetId, sourceId]);
    // Actualizar last_message del target
    await pool.query(
      `UPDATE conversations SET
         last_message    = sub.content,
         last_message_at = sub.created_at,
         updated_at      = NOW()
       FROM (SELECT content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1) sub
       WHERE conversations.id = $1`,
      [targetId]
    );
    await pool.query('DELETE FROM conversations WHERE id = $1', [sourceId]);
    res.json({ success: true, mergedInto: targetId, deleted: sourceId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/trigger-follow-up
 * Dispara el follow-up bot ahora mismo para conversaciones abandonadas de esta org.
 * El cron corre automáticamente cada 30min pero este endpoint lo activa a demanda.
 */
router.post('/trigger-follow-up', async (req, res) => {
  const pool = getPool();
  try {
    const Anthropic    = require('@anthropic-ai/sdk');
    const kapsoService = require('../services/kapso-whatsapp');
    const client       = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Conversaciones abandonadas: sin respuesta >2h, <22h, modo IA, no cerradas
    // Ampliamos a cualquier pipeline_state activo (no solo interested/collecting)
    const { rows: stalled } = await pool.query(
      `SELECT c.id, c.phone_number, c.contact_name, c.pipeline_state, c.order_draft,
              c.follow_up_sent_at, c.last_inbound_at
       FROM conversations c
       WHERE c.organization_id = $1
         AND c.agent_mode = 'ai'
         AND c.pipeline_state NOT IN ('done')
         AND c.last_message_at < NOW() - INTERVAL '2 hours'
         AND c.last_message_at > NOW() - INTERVAL '22 hours'
         AND (c.follow_up_sent_at IS NULL OR c.follow_up_sent_at < NOW() - INTERVAL '6 hours')
       ORDER BY c.last_message_at ASC
       LIMIT 30`,
      [req.orgId]
    );

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    const storeContext = await db.getSetting(req.orgId, 'store_context') || '';
    let sent = 0;

    const PROMPT = `Eres alguien que trabaja en una tienda y escribes a un cliente que no respondió.
CONTEXTO TIENDA: ${storeContext}
ÚLTIMOS MENSAJES:
{HISTORIAL}
Escribe UN mensaje de 1-2 líneas para retomar. Tono cálido y casual. Referencia algo específico.
Si es de noche (>21h), escribe: SKIP. Sin comillas. Solo el mensaje.`;

    const hora = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });

    for (const conv of stalled) {
      try {
        const msgs = await db.getLastMessages(conv.id, 8);
        if (!msgs.length) continue;

        const historial = msgs.map(m =>
          `${m.direction === 'inbound' ? (conv.contact_name || 'Cliente') : 'Nosotros'}: ${(m.content || '').slice(0, 200)}`
        ).join('\n');

        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: PROMPT.replace('{HISTORIAL}', historial),
          messages: [{ role: 'user', content: `Hora actual: ${hora}. Genera el mensaje.` }],
        });

        const text = (response.content[0]?.text || '').trim();
        if (!text || text === 'SKIP') continue;

        await kapsoService.sendTextMessage(conv.phone_number, text, wc);
        const savedMsg = await db.saveMessage({
          conversationId: conv.id, whatsappMessageId: null,
          direction: 'outbound', content: text, sentBy: 'ai', agentType: 'follow_up',
        });
        await db.updateConversationLastMessage(conv.id, text, false);
        await pool.query('UPDATE conversations SET follow_up_sent_at = NOW() WHERE id = $1', [conv.id]);

        const updatedConv = await db.getConversationById(conv.id);
        io?.emit(`new_message_${req.orgId}`, { message: savedMsg, conversation: updatedConv });
        sent++;
        await new Promise(r => setTimeout(r, 1200));
      } catch (e) {
        console.error(`[trigger-follow-up] conv ${conv.id}:`, e.message);
      }
    }

    res.json({ success: true, checked: stalled.length, sent });
  } catch (err) {
    console.error('[trigger-follow-up]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/scan-hot-leads
 * Analiza conversaciones con actividad en las últimas 48h usando IA (Haiku)
 * y actualiza su pipeline_state a 'interested' si detecta intención de compra hoy.
 */
router.post('/scan-hot-leads', async (req, res) => {
  const pool = getPool();
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Conversaciones con actividad en últimas 48h que no estén en 'done' ni excluidas manualmente
    const { rows: convs } = await pool.query(
      `SELECT c.id, c.contact_name, c.phone_number, c.pipeline_state
       FROM conversations c
       WHERE c.organization_id = $1
         AND c.last_message_at > NOW() - INTERVAL '48 hours'
         AND c.pipeline_state NOT IN ('done', 'interested', 'collecting_order')
         AND (c.hot_lead_excluded IS NULL OR c.hot_lead_excluded = FALSE)
       ORDER BY c.last_message_at DESC
       LIMIT 60`,
      [req.orgId]
    );

    let updated = 0;
    for (const conv of convs) {
      // Obtener los últimos 10 mensajes
      const { rows: msgs } = await pool.query(
        `SELECT direction, content FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [conv.id]
      );
      if (!msgs.length) continue;

      const history = msgs.reverse().map(m =>
        `${m.direction === 'inbound' ? 'Cliente' : 'Bot'}: ${(m.content || '').slice(0, 200)}`
      ).join('\n');

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system: 'Eres un clasificador de intención de compra. Responde SOLO con "si" o "no".',
        messages: [{
          role: 'user',
          content: `¿El cliente en esta conversación muestra intención clara de comprar HOY o muy pronto (hace preguntas de precio, disponibilidad, despacho, o dice que lo quiere)?\n\n${history}`,
        }],
      });

      const answer = response.content[0]?.text?.trim().toLowerCase() || '';
      if (answer.startsWith('si') || answer === 'sí') {
        await pool.query(
          `UPDATE conversations SET pipeline_state = 'interested', updated_at = NOW() WHERE id = $1`,
          [conv.id]
        );
        updated++;
      }

      // Rate limit: pequeña pausa entre llamadas
      await new Promise(r => setTimeout(r, 200));
    }

    res.json({ success: true, scanned: convs.length, hotLeadsFound: updated });
  } catch (err) {
    console.error('[scan-hot-leads]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/conversations/:id/analyze
 * Analiza la conversación con IA y devuelve un reporte del comportamiento del bot.
 */
router.post('/:id/analyze', async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const conv = await db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'Conversación no encontrada' });

    const messages = await db.getMessagesByConversation(conv.id, 200);
    if (!messages.length) return res.json({ success: true, analysis: { error: 'Sin mensajes para analizar' } });

    // Formatear historial para el análisis
    const transcript = messages.map(m => {
      const who = m.direction === 'inbound' ? '👤 Cliente' : (m.sent_by === 'human' ? '🧑 Agente humano' : '🤖 Bot');
      const time = new Date(m.created_at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${who}: ${m.content}`;
    }).join('\n');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `Eres un analista de calidad para un CRM de WhatsApp con bot de ventas IA.
Tu tarea: analizar conversaciones y evaluar el desempeño del bot.
Responde SIEMPRE en JSON con esta estructura exacta:
{
  "resumen": "1-2 oraciones describiendo qué pasó",
  "intencion_cliente": "qué quería el cliente",
  "deteccion_correcta": true/false,
  "estado_final": "compró | agendó | interesado | exploró | insatisfecho | se dio de baja | otro",
  "puntaje_bot": 1-5,
  "aciertos": ["lista de cosas que hizo bien el bot"],
  "errores": ["lista de errores o problemas detectados"],
  "oportunidades": ["cosas que el bot pudo hacer mejor"],
  "proxima_accion": "qué debería hacer el negocio ahora"
}
Sin texto fuera del JSON. Sin markdown.`,
      messages: [{
        role: 'user',
        content: `Estado actual de la conversación: ${conv.pipeline_state || 'exploring'}
Cliente: ${conv.contact_name || conv.phone_number}

CONVERSACIÓN:
${transcript}

Analiza y devuelve el JSON.`,
      }],
    });

    let analysis;
    try {
      // El modelo a veces envuelve el JSON en ```json ... ``` — limpiar antes de parsear
      const raw = resp.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      analysis = JSON.parse(raw);
    } catch {
      analysis = { resumen: resp.content[0].text, error: 'Formato inesperado' };
    }

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[Conv/analyze]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
