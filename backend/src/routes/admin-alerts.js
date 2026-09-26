/**
 * admin-alerts.js — Control de la cola de alertas al admin (CRM)
 *
 * Da visibilidad sobre las alertas que NO se pudieron entregar al admin por
 * WhatsApp (ventana de 24h cerrada) y quedaron en admin_outbox. Permite:
 *   - ver cuántas hay y de qué conversaciones,
 *   - saber si el canal de WhatsApp del admin está abierto o cerrado,
 *   - reenviarlas ahora (si la ventana ya se reabrió),
 *   - descartar una que ya no aplica.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { getPool } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { drainAdminOutbox, isWindowOpen } = require('../services/admin-notify');

router.use(requireAuth);
router.use(requireRole('owner', 'admin', 'supervisor'));

const KIND_LABEL = { help: 'Consulta', handoff: 'Handoff', payment: 'Pago' };

// ── GET /api/admin-alerts ────────────────────────────────────────────
// Estado del canal + alertas pendientes (con nombre de la conversación).
router.get('/', async (req, res) => {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT ao.id, ao.body, ao.kind, ao.conversation_id, ao.created_at,
              c.contact_name, c.phone_number
         FROM admin_outbox ao
         LEFT JOIN conversations c ON c.id = ao.conversation_id
        WHERE ao.organization_id = $1 AND ao.status = 'pending'
        ORDER BY ao.created_at DESC`,
      [req.orgId]
    );

    const [windowOpen, lastInbound, adminPhone] = await Promise.all([
      isWindowOpen(req.orgId),
      db.getSetting(req.orgId, 'admin_window_last_inbound').catch(() => null),
      db.getSetting(req.orgId, 'admin_alert_phone').catch(() => null),
    ]);

    // Dedup por conversación para el conteo "real" (una conversación = un aviso)
    const convSet = new Set();
    let uniqueCount = 0;
    for (const r of rows) {
      const key = r.conversation_id != null ? `c${r.conversation_id}` : `x${r.id}`;
      if (!convSet.has(key)) { convSet.add(key); uniqueCount++; }
    }

    const { rows: deliveries } = await pool.query(`SELECT d.id, d.conversation_id, d.kind,
      d.status, d.error, d.created_at, d.delivered_at, d.read_at,
      COALESCE(c.contact_name,c.phone_number,'Cliente') AS client_name
      FROM admin_notification_deliveries d LEFT JOIN conversations c ON c.id=d.conversation_id
      WHERE d.organization_id=$1 ORDER BY d.created_at DESC LIMIT 30`, [req.orgId]);
    res.json({
      success: true,
      windowOpen,
      lastInbound,
      adminConfigured: !!adminPhone,
      count: uniqueCount,
      alerts: rows.map(r => ({
        id:           r.id,
        kind:         r.kind,
        kindLabel:    KIND_LABEL[r.kind] || r.kind,
        conversationId: r.conversation_id,
        clientName:   r.contact_name || r.phone_number || 'Cliente',
        phone:        r.phone_number || '',
        preview:      (r.body || '').slice(0, 200),
        createdAt:    r.created_at,
      })),
      deliveries,
      attention: await require('../services/human-attention').pending(req.orgId),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send a fixed diagnostic only to the saved administrator phone.
router.post('/test', async (req,res) => {
  try {
    const result=await require('../services/admin-notify').notifyAdmin(req.orgId,{
      kind:'test', body:'✅ Prueba de avisos del CRM. Este es el número configurado para recibir las consultas que necesitan atención humana. No es un mensaje de un cliente.'
    });
    res.json({success:true,...result});
  } catch(error) { res.status(500).json({success:false,error:'No se pudo registrar el aviso de prueba'}); }
});

// ── POST /api/admin-alerts/flush ─────────────────────────────────────
// Intenta entregar la cola ahora. Solo funciona si la ventana está abierta
// (el admin escribió al número en las últimas 24h).
router.post('/flush', async (req, res) => {
  try {
    const open = await isWindowOpen(req.orgId);
    if (!open) {
      return res.json({
        success: false,
        windowOpen: false,
        error: 'El canal de WhatsApp del admin está cerrado. Escribe cualquier mensaje al número del negocio desde el teléfono del admin y se reenviarán solas.',
      });
    }
    const r = await drainAdminOutbox(req.orgId);
    res.json({ success: true, windowOpen: true, drained: r.drained || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/admin-alerts/:id ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const pool = getPool();
  try {
    const { rowCount } = await pool.query(
      `UPDATE admin_outbox SET status = 'expired'
        WHERE id = $1 AND organization_id = $2 AND status = 'pending'`,
      [parseInt(req.params.id), req.orgId]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: 'Alerta no encontrada' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
