/**
 * orders.js — Rutas para gestionar pedidos del CRM
 *
 * GET  /api/orders            → Lista todos los pedidos
 * GET  /api/orders/stats      → Resumen rápido (total, pagados, pendientes, ingresos)
 * GET  /api/orders/:id        → Detalle de un pedido
 * PATCH /api/orders/:id/status → Cambiar estado manualmente
 * POST /api/orders/:id/resend-link → Reenviar link de pago por WhatsApp
 */

const express    = require('express');
const router     = express.Router();
const db         = require('../db/database');
const raigentic  = require('../services/raigentic');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/orders
 * Todas las órdenes de la organización con info de conversación
 */
router.get('/', (req, res) => {
  try {
    const orders = db.getDb().prepare(`
      SELECT
        o.*,
        c.phone_number,
        c.contact_name,
        c.pipeline_state
      FROM orders o
      JOIN conversations c ON o.conversation_id = c.id
      WHERE o.organization_id = ?
      ORDER BY o.created_at DESC
    `).all(req.orgId);

    const parsed = orders.map(o => ({
      ...o,
      items: safeJSON(o.items, []),
      shipping_address: safeJSON(o.shipping_address, {}),
    }));

    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/stats
 * Resumen rápido para el dashboard
 */
router.get('/stats', (req, res) => {
  try {
    const d = db.getDb();
    const total      = d.prepare('SELECT COUNT(*) as n FROM orders WHERE organization_id = ?').get(req.orgId);
    const paid       = d.prepare("SELECT COUNT(*) as n FROM orders WHERE organization_id = ? AND status = 'paid'").get(req.orgId);
    const pending    = d.prepare("SELECT COUNT(*) as n FROM orders WHERE organization_id = ? AND status IN ('draft','sent')").get(req.orgId);
    const revenue    = d.prepare("SELECT SUM(CAST(total_price AS REAL)) as s FROM orders WHERE organization_id = ? AND status = 'paid'").get(req.orgId);
    const today      = d.prepare("SELECT COUNT(*) as n FROM orders WHERE organization_id = ? AND date(created_at) = date('now')").get(req.orgId);

    res.json({
      success: true,
      data: {
        total:   total.n,
        paid:    paid.n,
        pending: pending.n,
        revenue: revenue.s || 0,
        today:   today.n,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/shopify?status=any&limit=50&cursor=
 * Órdenes reales de Shopify via raigentic (no del bot)
 * IMPORTANTE: debe estar ANTES de /:id para no ser interceptado
 */
router.get('/shopify', async (req, res) => {
  try {
    const ds = db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, orders: [], total: 0 });

    const shop   = ds.config?.storeUrl;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 250);
    const cursor = req.query.cursor || undefined;
    const status = req.query.status || 'any';

    const result = await raigentic.getOrdenes(shop, { limit, cursor, status });
    res.json(result);
  } catch (err) {
    console.error('[Orders/Shopify]', err.message);
    // Dar mensaje amigable según el tipo de error
    const isTimeout  = err.code === 'ECONNABORTED';
    const isNotFound = err.response?.status === 404;
    const isUnauth   = err.response?.status === 401;
    const friendly = isTimeout  ? 'Raigentic tardó demasiado en responder (cold start). Inténtalo de nuevo en 30s.'
                   : isNotFound ? 'Endpoint /api/ordenes no encontrado en raigentic. Asegúrate de que la última versión esté desplegada en Render.'
                   : isUnauth   ? 'BOT_API_SECRET incorrecto entre CRM y raigentic.'
                   : err.message;
    res.status(500).json({ success: false, error: friendly });
  }
});

/**
 * GET /api/orders/:id
 * Detalle de una orden
 */
router.get('/:id', (req, res) => {
  try {
    const order = db.getDb().prepare(`
      SELECT o.*, c.phone_number, c.contact_name
      FROM orders o JOIN conversations c ON o.conversation_id = c.id
      WHERE o.id = ? AND o.organization_id = ?
    `).get(parseInt(req.params.id), req.orgId);

    if (!order) return res.status(404).json({ success: false, error: 'Orden no encontrada' });

    res.json({
      success: true,
      data: {
        ...order,
        items: safeJSON(order.items, []),
        shipping_address: safeJSON(order.shipping_address, {}),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/:id/status
 * Actualizar estado manualmente (ej: marcar como pagada)
 */
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['draft', 'sent', 'paid', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${validStatuses.join(', ')}` });
    }

    const order = db.getDb().prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?')
      .get(parseInt(req.params.id), req.orgId);
    if (!order) return res.status(404).json({ success: false, error: 'Orden no encontrada' });

    db.updateOrder(order.id, { status });
    res.json({ success: true, data: db.getDb().prepare('SELECT * FROM orders WHERE id = ?').get(order.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/orders/:id/resend-link
 * Reenvía el link de pago al cliente por WhatsApp
 */
router.post('/:id/resend-link', async (req, res) => {
  try {
    const order = db.getDb().prepare(`
      SELECT o.*, c.phone_number FROM orders o
      JOIN conversations c ON o.conversation_id = c.id
      WHERE o.id = ? AND o.organization_id = ?
    `).get(parseInt(req.params.id), req.orgId);

    if (!order) return res.status(404).json({ success: false, error: 'Orden no encontrada' });
    if (!order.invoice_url) return res.status(400).json({ success: false, error: 'Sin link de pago disponible' });

    const whatsappService = require('../services/whatsapp');
    const wc = db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    const msg = `🔔 Recordatorio de tu pedido:\n\n💳 Completa tu pago aquí:\n${order.invoice_url}\n\n¡Te esperamos! 😊`;
    await whatsappService.sendTextMessage(order.phone_number, msg, wc);

    res.json({ success: true, message: 'Link reenviado correctamente' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/orders/:id/sync-shopify
 * El estado de las órdenes llega automáticamente via webhooks de Shopify → raigentic.
 * Este endpoint devuelve el estado actual en la DB local.
 */
router.post('/:id/sync-shopify', async (req, res) => {
  try {
    const order = db.getDb().prepare('SELECT * FROM orders WHERE id = ? AND organization_id = ?')
      .get(parseInt(req.params.id), req.orgId);
    if (!order) return res.status(404).json({ success: false, error: 'Orden no encontrada' });
    if (!order.shopify_draft_id) return res.status(400).json({ success: false, error: 'Sin ID de Shopify en esta orden' });

    res.json({
      success: true,
      message: 'El estado se sincroniza automáticamente via webhooks de Shopify.',
      data: {
        localStatus:    order.status,
        shopifyDraftId: order.shopify_draft_id,
        shopifyOrderId: order.shopify_order_id,
        invoiceUrl:     order.invoice_url,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function safeJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
