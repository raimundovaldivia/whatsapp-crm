const express = require('express');
const router = express.Router();
const db = require('../db/database');
const whatsappService = require('../services/whatsapp');
const twilioService   = require('../services/twilio-whatsapp');
const { requireAuth } = require('../middleware/auth');

let io;
function setSocketIO(socketIO) { io = socketIO; }

// Todas las rutas requieren auth
router.use(requireAuth);

/**
 * GET /api/conversations
 */
router.get('/', (req, res) => {
  try {
    res.json({ success: true, data: db.getAllConversations(req.orgId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/:id/messages
 */
router.get('/:id/messages', (req, res) => {
  try {
    const conv = db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    const messages = db.getMessagesByConversation(conv.id, parseInt(req.query.limit) || 50);
    db.markConversationAsRead(conv.id);
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

    const conv = db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    const wc = db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    // Enviar por el proveedor correcto según configuración
    let sentResult;
    if (wc.provider === 'twilio') {
      sentResult = await twilioService.sendTextMessage(conv.phone_number, text.trim(), wc);
    } else {
      sentResult = await whatsappService.sendTextMessage(conv.phone_number, text.trim(), wc);
    }

    const message = db.saveMessage({
      conversationId: conv.id,
      whatsappMessageId: sentResult?.messageId || sentResult?.messages?.[0]?.id || null,
      direction: 'outbound',
      content: text.trim(),
      sentBy: 'human',
    });

    db.updateConversationLastMessage(conv.id, text.trim());
    const updated = db.getConversationById(conv.id);
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
router.patch('/:id/agent-mode', (req, res) => {
  try {
    const { mode } = req.body;
    if (!['ai', 'human'].includes(mode)) return res.status(400).json({ success: false, error: 'mode inválido' });

    const conv = db.getConversationById(parseInt(req.params.id), req.orgId);
    if (!conv) return res.status(404).json({ success: false, error: 'No encontrada' });

    db.setAgentMode(conv.id, mode);
    io?.emit(`agent_mode_changed_${req.orgId}`, { conversationId: conv.id, mode });

    res.json({ success: true, data: db.getConversationById(conv.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/conversations/:id/read
 */
router.patch('/:id/read', (req, res) => {
  try {
    db.markConversationAsRead(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/conversations/:id/orders
 */
router.get('/:id/orders', (req, res) => {
  try {
    const orders = db.getDb().prepare(
      'SELECT * FROM orders WHERE conversation_id = ? AND organization_id = ? ORDER BY created_at DESC'
    ).all(parseInt(req.params.id), req.orgId);
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
