/**
 * orders.js — Rutas para gestionar pedidos del CRM
 *
 * GET  /api/orders            → Lista todos los pedidos
 * GET  /api/orders/stats      → Resumen rápido (total, pagados, pendientes, ingresos)
 * GET  /api/orders/:id        → Detalle de un pedido
 * PATCH /api/orders/:id/status → Cambiar estado manualmente
 * POST /api/orders/:id/resend-link → Reenviar link de pago por WhatsApp
 */

const express     = require('express');
const router      = express.Router();
const db          = require('../db/database');
const { getPool } = require('../db/database');
const shopifyApi  = require('../services/shopify-api');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/orders
 * Todas las órdenes de la organización con info de conversación
 */
router.get('/', async (req, res) => {
  try {
    const { rows: orders } = await getPool().query(
      `SELECT
        o.*,
        c.phone_number,
        c.contact_name,
        c.pipeline_state
      FROM orders o
      JOIN conversations c ON o.conversation_id = c.id
      WHERE o.organization_id = $1
      ORDER BY o.created_at DESC`,
      [req.orgId]
    );

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
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [totalRow] }   = await pool.query('SELECT COUNT(*) as n FROM orders WHERE organization_id = $1', [req.orgId]);
    const { rows: [paidRow] }    = await pool.query("SELECT COUNT(*) as n FROM orders WHERE organization_id = $1 AND status = 'paid'", [req.orgId]);
    const { rows: [pendingRow] } = await pool.query("SELECT COUNT(*) as n FROM orders WHERE organization_id = $1 AND status IN ('draft','sent')", [req.orgId]);
    const { rows: [revenueRow] } = await pool.query("SELECT SUM(total_price::numeric) as s FROM orders WHERE organization_id = $1 AND status = 'paid'", [req.orgId]);
    const { rows: [todayRow] }   = await pool.query("SELECT COUNT(*) as n FROM orders WHERE organization_id = $1 AND created_at::date = CURRENT_DATE", [req.orgId]);

    res.json({
      success: true,
      data: {
        total:   parseInt(totalRow.n),
        paid:    parseInt(paidRow.n),
        pending: parseInt(pendingRow.n),
        revenue: parseFloat(revenueRow.s) || 0,
        today:   parseInt(todayRow.n),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/shopify?status=any&limit=50&cursor=
 * Órdenes reales de Shopify via GraphQL directo (no del bot)
 * IMPORTANTE: debe estar ANTES de /:id para no ser interceptado
 */
router.get('/shopify', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, orders: [], total: 0 });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const limit  = Math.min(parseInt(req.query.limit) || 50, 250);
    const cursor = req.query.cursor || null;
    const status = req.query.status || 'any';

    const result = await shopifyApi.getOrders(shop, token, { limit, cursor, status });
    res.json(result);
  } catch (err) {
    console.error('[Orders/Shopify]', err.message);
    if (err.message.includes('accessToken') || err.message.includes('401')) {
      return res.status(401).json({
        success: false,
        error:   'La conexión con Shopify expiró. Ve a Ajustes → Shopify → Reconectar.',
        code:    'SHOPIFY_RECONNECT',
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/:id
 * Detalle de una orden
 */
router.get('/:id', async (req, res) => {
  try {
    const { rows: [order] } = await getPool().query(
      `SELECT o.*, c.phone_number, c.contact_name
       FROM orders o JOIN conversations c ON o.conversation_id = c.id
       WHERE o.id = $1 AND o.organization_id = $2`,
      [parseInt(req.params.id), req.orgId]
    );

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
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['draft', 'sent', 'paid', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${validStatuses.join(', ')}` });
    }

    const { rows: [order] } = await getPool().query(
      'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
      [parseInt(req.params.id), req.orgId]
    );
    if (!order) return res.status(404).json({ success: false, error: 'Orden no encontrada' });

    const updated = await db.updateOrder(order.id, { status });
    res.json({ success: true, data: updated });
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
    const { rows: [order] } = await getPool().query(
      `SELECT o.*, c.phone_number FROM orders o
       JOIN conversations c ON o.conversation_id = c.id
       WHERE o.id = $1 AND o.organization_id = $2`,
      [parseInt(req.params.id), req.orgId]
    );

    if (!order) return res.status(404).json({ success: false, error: 'Orden no encontrada' });
    if (!order.invoice_url) return res.status(400).json({ success: false, error: 'Sin link de pago disponible' });

    const whatsappService = require('../services/whatsapp');
    const wc = await db.getWhatsappConfig(req.orgId);
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
 * Este endpoint devuelve el estado actual de la orden en la DB local.
 */
router.post('/:id/sync-shopify', async (req, res) => {
  try {
    const { rows: [order] } = await getPool().query(
      'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
      [parseInt(req.params.id), req.orgId]
    );
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
