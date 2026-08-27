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
 * POST /api/orders
 * Crear pedido manual (sin conversación de WhatsApp)
 */
router.post('/', async (req, res) => {
  try {
    const { customerName, phone, address, items, status, notes } = req.body;
    if (!customerName) return res.status(400).json({ error: 'customerName es requerido' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Agrega al menos un producto' });

    const total = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
    const itemsJson = JSON.stringify(items.map(i => ({
      name: i.name || i.title || '',
      quantity: Number(i.quantity) || 1,
      price: Number(i.price) || 0,
    })));

    const shippingJson = address ? JSON.stringify({ address1: address }) : null;
    const orderStatus  = status || 'nuevo';
    const pool = getPool();

    const { rows } = await pool.query(
      `INSERT INTO orders
         (organization_id, customer_name, customer_phone, shipping_address, items, total_price, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [req.orgId, customerName, phone || null, shippingJson, itemsJson, String(total), orderStatus]
    );
    res.status(201).json({ order: rows[0] });
  } catch (err) {
    console.error('[Orders] Error creando pedido manual:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
        c.pipeline_state,
        CASE
          WHEN o.customer_name IS NULL OR LOWER(TRIM(o.customer_name)) IN ('cliente','sin nombre','cliente sin nombre')
          THEN COALESCE(ct.name, o.customer_name)
          ELSE o.customer_name
        END AS customer_name_resolved
      FROM orders o
      LEFT JOIN conversations c ON o.conversation_id = c.id
      LEFT JOIN contacts ct
        ON ct.organization_id = o.organization_id
       AND ct.phone = ANY(ARRAY[
             o.customer_phone,
             CASE WHEN o.customer_phone ~ '^569' THEN SUBSTRING(o.customer_phone FROM 3) END,
             CASE WHEN o.customer_phone ~ '^9'   THEN '56' || o.customer_phone END,
             CASE WHEN o.customer_phone ~ '^569' THEN '+' || o.customer_phone END
           ])
      WHERE o.organization_id = $1
      ORDER BY o.created_at DESC`,
      [req.orgId]
    );

    const parsed = orders.map(o => ({
      ...o,
      customer_name: o.customer_name_resolved || o.customer_name,
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
 * Panorama general de ventas de la empresa (bot + Shopify)
 */
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();

    // Ventas hoy: bot (paid) + Shopify (paid)
    const { rows: [ventasHoyRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_price::numeric), 0) AS s FROM (
        SELECT total_price FROM orders
          WHERE organization_id = $1 AND status = 'paid'
            AND created_at::date = CURRENT_DATE
        UNION ALL
        SELECT total_price FROM shopify_orders
          WHERE organization_id = $1
            AND UPPER(financial_status) = 'PAID'
            AND shopify_created_at::date = CURRENT_DATE
      ) t
    `, [req.orgId]);

    // Pedidos hoy: ambas fuentes, cualquier estado no cancelado
    const { rows: [pedidosHoyRow] } = await pool.query(`
      SELECT COUNT(*) AS n FROM (
        SELECT id FROM orders
          WHERE organization_id = $1 AND status NOT IN ('cancelled')
            AND created_at::date = CURRENT_DATE
        UNION ALL
        SELECT id FROM shopify_orders
          WHERE organization_id = $1
            AND UPPER(financial_status) NOT IN ('VOIDED','REFUNDED')
            AND shopify_created_at::date = CURRENT_DATE
      ) t
    `, [req.orgId]);

    // Ventas este mes: bot (paid) + Shopify (paid)
    const { rows: [ventasMesRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_price::numeric), 0) AS s FROM (
        SELECT total_price FROM orders
          WHERE organization_id = $1 AND status = 'paid'
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
        UNION ALL
        SELECT total_price FROM shopify_orders
          WHERE organization_id = $1
            AND UPPER(financial_status) = 'PAID'
            AND DATE_TRUNC('month', shopify_created_at) = DATE_TRUNC('month', CURRENT_DATE)
      ) t
    `, [req.orgId]);

    // Pedidos este mes: ambas fuentes
    const { rows: [pedidosMesRow] } = await pool.query(`
      SELECT COUNT(*) AS n FROM (
        SELECT id FROM orders
          WHERE organization_id = $1 AND status NOT IN ('cancelled')
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
        UNION ALL
        SELECT id FROM shopify_orders
          WHERE organization_id = $1
            AND UPPER(financial_status) NOT IN ('VOIDED','REFUNDED')
            AND DATE_TRUNC('month', shopify_created_at) = DATE_TRUNC('month', CURRENT_DATE)
      ) t
    `, [req.orgId]);

    res.json({
      success: true,
      data: {
        ventasHoy:   parseFloat(ventasHoyRow.s)  || 0,
        pedidosHoy:  parseInt(pedidosHoyRow.n)   || 0,
        ventasMes:   parseFloat(ventasMesRow.s)  || 0,
        pedidosMes:  parseInt(pedidosMesRow.n)   || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/shopify
 * Lee las órdenes de Shopify desde nuestra DB (previamente sincronizadas).
 * IMPORTANTE: debe estar ANTES de /:id para no ser interceptado.
 */
router.get('/shopify', async (req, res) => {
  try {
    const orders   = await db.getShopifyOrders(req.orgId);
    const lastSync = await db.getShopifyOrdersSyncedAt(req.orgId);
    res.json({ success: true, orders, total: orders.length, lastSync });
  } catch (err) {
    console.error('[Orders/Shopify GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/orders/shopify/sync
 * Llama a Shopify, trae TODAS las órdenes y las upsertea en nuestra DB.
 */
router.post('/shopify/sync', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.status(400).json({ success: false, error: 'No hay fuente de datos Shopify configurada' });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const orders = await shopifyApi.getAllOrders(shop, token, { status: 'any' });

    await db.upsertShopifyOrders(req.orgId, orders);

    const lastSync = await db.getShopifyOrdersSyncedAt(req.orgId);
    res.json({ success: true, synced: orders.length, lastSync });
  } catch (err) {
    console.error('[Orders/Shopify SYNC]', err.message);
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
 * PATCH /api/orders/:id/address
 * Actualizar dirección de un pedido (bot) sin conversación o con dirección vacía
 */
router.patch('/:id/address', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address es requerido' });
    const addrJson = JSON.stringify({ address1: address });
    const { rows: [order] } = await getPool().query(
      `UPDATE orders SET shipping_address = $1 WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [addrJson, parseInt(req.params.id), req.orgId]
    );
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
       FROM orders o LEFT JOIN conversations c ON o.conversation_id = c.id
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

/**
 * DELETE /api/orders/bulk
 * Eliminar órdenes masivamente.
 * Body: { botIds: [1,2,3], shopifyIds: ["...","..."] }
 */
router.delete('/bulk', async (req, res) => {
  const { botIds = [], shopifyIds = [] } = req.body;
  try {
    const [botCount, shopifyCount] = await Promise.all([
      botIds.length     ? db.bulkDeleteBotOrders(req.orgId, botIds)         : 0,
      shopifyIds.length ? db.bulkDeleteShopifyOrders(req.orgId, shopifyIds) : 0,
    ]);
    res.json({ success: true, deleted: botCount + shopifyCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/bulk-status
 * Cambio masivo de estado.
 * Body: { status, botIds: [1,2,3], shopifyIds: ["gid://...","gid://..."] }
 */
router.patch('/bulk-status', async (req, res) => {
  const VALID = ['nuevo','por_despachar','en_camino','entregado','paid','cancelled','draft','sent','payment_received'];
  const { status, botIds = [], shopifyIds = [] } = req.body;
  if (!status || !VALID.includes(status)) {
    return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${VALID.join(', ')}` });
  }
  try {
    const [botCount, shopifyCount] = await Promise.all([
      botIds.length     ? db.bulkUpdateBotOrderStatus(req.orgId, botIds, status)         : 0,
      shopifyIds.length ? db.bulkUpdateShopifyOrderStatus(req.orgId, shopifyIds, status) : 0,
    ]);
    res.json({ success: true, updated: botCount + shopifyCount, botCount, shopifyCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function safeJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
