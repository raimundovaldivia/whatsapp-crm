/**
 * reconciliation.js — Conciliación bancaria (cartola Santander ↔ pedidos)
 *
 * POST /api/reconciliation/upload            { filename, base64 }  → importa abonos del PDF
 * GET  /api/reconciliation/suggestions       abonos pendientes con pedidos candidatos
 * GET  /api/reconciliation/movements?status= listado (pending | matched | ignored)
 * GET  /api/reconciliation/statements        cartolas subidas
 * GET  /api/reconciliation/stats
 * GET  /api/reconciliation/orders?q=         pedidos sin pagar (para asignar a mano)
 * POST /api/reconciliation/movements/:id/confirm  { orders:[{source,id}], note }
 * POST /api/reconciliation/movements/:id/ignore   { note }
 * POST /api/reconciliation/movements/:id/unmatch
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const recon   = require('../services/reconciliation');

router.use(requireAuth);
router.use(requireRole('owner', 'admin', 'supervisor'));

const MAX_PDF_BYTES = 8 * 1024 * 1024;

router.post('/upload', async (req, res) => {
  try {
    const { filename, base64 } = req.body || {};
    if (!base64) return res.status(400).json({ success: false, error: 'Falta el archivo' });
    const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buf.length > MAX_PDF_BYTES) return res.status(400).json({ success: false, error: 'El PDF pesa más de 8 MB' });
    if (buf.slice(0, 5).toString() !== '%PDF-') return res.status(400).json({ success: false, error: 'El archivo no es un PDF' });
    const r = await recon.importStatement(req.orgId, buf, filename || 'cartola.pdf', req.userId);
    if (!r.ok) return res.status(422).json({ success: false, ...r });
    res.json({ success: true, ...r });
  } catch (err) {
    console.error('[Reconciliation/upload]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/suggestions', async (req, res) => {
  try { res.json({ success: true, ...(await recon.suggest(req.orgId)) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/movements', async (req, res) => {
  try {
    const { status, from, to } = req.query;
    res.json({ success: true, movements: await recon.listMovements(req.orgId, { status: status || null, from: from || null, to: to || null }) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/statements', async (req, res) => {
  try { res.json({ success: true, statements: await recon.listStatements(req.orgId) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try { res.json({ success: true, stats: await recon.stats(req.orgId) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/orders', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    let orders = await recon.getUnpaidOrders(req.orgId);
    if (q) orders = orders.filter(o => [o.customer_name, o.label, o.phone, String(o.total)].some(v => String(v || '').toLowerCase().includes(q)));
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ success: true, orders: orders.slice(0, 50) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/movements/:id/confirm', async (req, res) => {
  try {
    const orders = Array.isArray(req.body?.orders) ? req.body.orders.filter(o => o && ['bot', 'shopify'].includes(o.source) && o.id) : [];
    if (!orders.length) return res.status(400).json({ success: false, error: 'Indica al menos un pedido' });
    const r = await recon.confirm(req.orgId, parseInt(req.params.id), orders, req.userId, req.body?.note || null);
    res.json({ success: true, ...r });
  } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
});

router.post('/movements/:id/ignore', async (req, res) => {
  try { res.json({ success: true, ...(await recon.ignore(req.orgId, parseInt(req.params.id), req.body?.note, req.userId)) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/movements/:id/unmatch', async (req, res) => {
  try { res.json({ success: true, ...(await recon.unmatch(req.orgId, parseInt(req.params.id))) }); }
  catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
});

module.exports = router;
