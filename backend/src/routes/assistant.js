/**
 * assistant.js — API del asistente IA del CRM
 *
 * POST /api/assistant/chat   → Enviar mensaje al asistente
 * GET  /api/assistant/history → Obtener historial guardado
 * DELETE /api/assistant/history → Limpiar historial
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db/database');
const assistant = require('../services/agents/assistant');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * POST /api/assistant/chat
 * Body: { message, history: [{role, content}] }
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

    // Obtener estado del setup
    const org = await db.getOrgById(req.orgId);
    const isSetupDone = !!(org?.setup_done);

    const result = await assistant.chat(req.orgId, isSetupDone, history, message);

    // Persistir historial en settings para retomar si el usuario cierra
    const newHistory = [
      ...history.slice(-20),
      { role: 'user',      content: message },
      { role: 'assistant', content: result.response },
    ];
    await db.setSetting(req.orgId, 'assistant_history', JSON.stringify(newHistory));

    res.json({
      response:     result.response,
      clientAction: result.clientAction,
      orgState:     result.orgState,
    });
  } catch (err) {
    console.error('[Assistant]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/assistant/history
 * Devuelve el historial guardado para retomar la conversación
 */
router.get('/history', async (req, res) => {
  try {
    const raw = await db.getSetting(req.orgId, 'assistant_history');
    const history = raw ? JSON.parse(raw) : [];
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

/**
 * DELETE /api/assistant/history
 * Limpia el historial (nueva conversación)
 */
router.delete('/history', async (req, res) => {
  try {
    await db.setSetting(req.orgId, 'assistant_history', '[]');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
