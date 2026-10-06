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
const collection  = require('../services/payment-collection');
const { paymentBreakdown } = require('../utils/payment-breakdown');
const { recordRouteOutcome } = require('../services/delivery-attempts');
const deliveryNotifications = require('../services/delivery-notifications');
const { resolveCustomerPhones } = require('../services/customer-identity');
const { requireAuth, requireRole } = require('../middleware/auth');

async function sendOrderEditNotification(...args) {
  if (typeof deliveryNotifications.sendOrderEditNotification !== 'function') {
    return { sent: false, skipped: true, reason: 'NOTIFICATION_UNAVAILABLE' };
  }
  try {
    return await deliveryNotifications.sendOrderEditNotification(...args);
  } catch (error) {
    console.error('[Orders] Pedido editado, pero falló el aviso:', error.message);
    return { sent: false, skipped: true, reason: 'SEND_FAILED', error: error.message };
  }
}

let io;
function setSocketIO(socketIO) { io = socketIO; }

router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const deliveryEdit = req.method === 'PATCH' && (/^\/(set-items|history-edit|reschedule)$/.test(req.path) || /^\/(?:shopify\/)?\d+\/address$/.test(req.path));
  return requireRole('owner', 'admin', 'supervisor', ...(deliveryEdit ? ['coordinador'] : []))(req, res, next);
});

/**
 * POST /api/orders
 * Crear pedido manual (sin conversación de WhatsApp)
 */
router.post('/', async (req, res) => {
  try {
    const { customerName, phone, address, city, items, status, notes } = req.body;
    if (!customerName) return res.status(400).json({ error: 'customerName es requerido' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Agrega al menos un producto' });

    const total = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
    const itemsJson = JSON.stringify(items.map(i => ({
      name: i.name || i.title || '',
      quantity: Number(i.quantity) || 1,
      price: Number(i.price) || 0,
    })));

    const shippingJson = address ? JSON.stringify({ address1: address, city: city || '' }) : null;
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
        END AS customer_name_resolved,
        ct.address1  AS contact_address1,
        ct.address   AS contact_address,
        ct.city      AS contact_city,
        ct.province  AS contact_province
      FROM orders o
      LEFT JOIN conversations c ON o.conversation_id = c.id
      LEFT JOIN LATERAL (
        SELECT name, address1, address, city, province
        FROM contacts
        WHERE organization_id = o.organization_id
          AND phone = ANY(ARRAY[
                o.customer_phone,
                CASE WHEN o.customer_phone ~ '^569' THEN SUBSTRING(o.customer_phone FROM 3) END,
                CASE WHEN o.customer_phone ~ '^9'   THEN '56' || o.customer_phone END,
                CASE WHEN o.customer_phone ~ '^569' THEN '+' || o.customer_phone END
              ])
        LIMIT 1
      ) ct ON true
      WHERE o.organization_id = $1
      ORDER BY o.created_at DESC`,
      [req.orgId]
    );

    const parsed = orders.map(o => {
      const addr = safeJSON(o.shipping_address, {});
      // Si la orden no tiene dirección propia, usar la del contacto
      if (!addr.address && !addr.address1) {
        if (o.contact_address1) addr.address1 = o.contact_address1;
        else if (o.contact_address) addr.address1 = o.contact_address;
        if (o.contact_city)     addr.city     = o.contact_city;
        if (o.contact_province) addr.province = o.contact_province;
      }
      return {
        ...o,
        customer_name:    o.customer_name_resolved || o.customer_name,
        items:            safeJSON(o.items, []),
        shipping_address: addr,
      };
    });

    res.json({ success: true, data: parsed });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/stats
 * Panorama general de ventas de la empresa (bot + Shopify)
 */
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();

    // Ventas hoy — solo shopify_orders (fuente correcta, sin doble conteo)
    const { rows: [ventasHoyRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_price), 0) AS s
      FROM shopify_orders
      WHERE organization_id = $1
        AND shopify_created_at IS NOT NULL
        AND (shopify_created_at AT TIME ZONE 'America/Santiago')::date = (NOW() AT TIME ZONE 'America/Santiago')::date
        AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
    `, [req.orgId]);

    // Pedidos hoy
    const { rows: [pedidosHoyRow] } = await pool.query(`
      SELECT COUNT(*) AS n
      FROM shopify_orders
      WHERE organization_id = $1
        AND shopify_created_at IS NOT NULL
        AND (shopify_created_at AT TIME ZONE 'America/Santiago')::date = (NOW() AT TIME ZONE 'America/Santiago')::date
        AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
    `, [req.orgId]);

    // Ventas este mes
    const { rows: [ventasMesRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_price), 0) AS s
      FROM shopify_orders
      WHERE organization_id = $1
        AND shopify_created_at IS NOT NULL
        AND DATE_TRUNC('month', shopify_created_at AT TIME ZONE 'America/Santiago') = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Santiago')
        AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
    `, [req.orgId]);

    // Pedidos este mes
    const { rows: [pedidosMesRow] } = await pool.query(`
      SELECT COUNT(*) AS n
      FROM shopify_orders
      WHERE organization_id = $1
        AND shopify_created_at IS NOT NULL
        AND DATE_TRUNC('month', shopify_created_at AT TIME ZONE 'America/Santiago') = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Santiago')
        AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
    `, [req.orgId]);

    // Ventas históricas totales (toda la DB)
    const { rows: [ventasTotalRow] } = await pool.query(`
      SELECT COALESCE(SUM(total_price), 0) AS s
      FROM shopify_orders
      WHERE organization_id = $1
        AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
    `, [req.orgId]);

    const { rows: [pedidosTotalRow] } = await pool.query(`
      SELECT COUNT(*) AS n
      FROM shopify_orders
      WHERE organization_id = $1
        AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
    `, [req.orgId]);

    res.json({
      success: true,
      data: {
        ventasHoy:    parseFloat(ventasHoyRow.s)    || 0,
        pedidosHoy:   parseInt(pedidosHoyRow.n)     || 0,
        ventasMes:    parseFloat(ventasMesRow.s)    || 0,
        pedidosMes:   parseInt(pedidosMesRow.n)     || 0,
        ventasTotal:  parseFloat(ventasTotalRow.s)  || 0,
        pedidosTotal: parseInt(pedidosTotalRow.n)   || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/history/:phone
 * Historial de compras de un cliente por número de teléfono.
 * Busca en shopify_orders con variantes del número (56xxx, 9xxx, +56xxx).
 */
router.get('/history/:phone', async (req, res) => {
  try {
    const pool  = getPool();
    const phone = req.params.phone.replace(/\s+/g, '');
    // Incluye formatos equivalentes y teléfonos anteriores que estén unidos
    // por una identidad fuerte (Shopify, email o nombre+dirección).
    const variants = await resolveCustomerPhones(pool, req.orgId, phone);

    const { rows: shopifyOrders } = await pool.query(`
      SELECT id, shopify_order_id, shopify_name, customer_name, total_price,
             financial_status, fulfillment_status, shopify_created_at, items,
             shipping_address1, shipping_city, payment_method, payment_marked_at,
             payment_cash_amount, payment_transfer_amount, payment_record_source,
             crm_status, delivered_at
      FROM shopify_orders
      WHERE organization_id = $1
        AND customer_phone = ANY($2::text[])
      ORDER BY shopify_created_at DESC
      LIMIT 20
    `, [req.orgId, variants]);

    const { rows: botOrders } = await pool.query(`
      SELECT id, customer_name, total_price, status, created_at, items, shipping_address,
             payment_method, payment_marked_at, payment_cash_amount,
             payment_transfer_amount, payment_record_source, delivered_at
      FROM orders
      WHERE organization_id = $1
        AND customer_phone = ANY($2::text[])
        AND status NOT IN ('cancelled')
      ORDER BY created_at DESC
      LIMIT 10
    `, [req.orgId, variants]);

    // Dirección actual del contacto (fuente autoritativa)
    const { rows: contactRows } = await pool.query(`
      SELECT address1, address, city FROM contacts
      WHERE organization_id = $1 AND phone = ANY($2::text[])
      LIMIT 1
    `, [req.orgId, variants]);
    const contactAddress = contactRows[0]
      ? [contactRows[0].address1 || contactRows[0].address, contactRows[0].city].filter(Boolean).join(', ')
      : null;

    // Resumen agregado
    const validShopify = shopifyOrders.filter(o => !['VOIDED','REFUNDED'].includes((o.financial_status||'').toUpperCase()));
    const totalGastado  = validShopify.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const totalPedidos  = validShopify.length;
    const ultimaCompra  = shopifyOrders[0]?.shopify_created_at || null;

    res.json({
      success: true,
      data: {
        summary: { totalPedidos, totalGastado, ultimaCompra },
        contactAddress,
        shopifyOrders,
        botOrders,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/shopify
 * Lee las órdenes de Shopify desde nuestra DB, auto-completando dirección
 * desde contacts cuando la orden no la tiene.
 * IMPORTANTE: debe estar ANTES de /:id para no ser interceptado.
 */
router.get('/shopify', async (req, res) => {
  try {
    const pool     = getPool();
    const lastSync = await db.getShopifyOrdersSyncedAt(req.orgId);

    // JOIN con contacts — el contacto ES la fuente autoritativa de dirección.
    // El teléfono normalizado (56XXXXXXXXX) es la clave de enlace.
    // El CASE en el JOIN maneja teléfonos sin normalizar en shopify_orders (registros legacy).
    const { rows } = await pool.query(`
      SELECT
        so.*,
        ct.address1   AS contact_address1,
        ct.city       AS contact_city,
        ct.province   AS contact_province
      FROM shopify_orders so
      LEFT JOIN LATERAL (
        SELECT address1, city, province
        FROM contacts
        WHERE organization_id = so.organization_id
          AND phone = CASE
            WHEN so.customer_phone ~ '^9[0-9]{8}$' THEN '56' || so.customer_phone
            ELSE so.customer_phone
          END
        LIMIT 1
      ) ct ON true
      WHERE so.organization_id = $1
      ORDER BY so.shopify_created_at DESC NULLS LAST
    `, [req.orgId]);

    // El contacto es la fuente autoritativa: sus datos SIEMPRE prevalecen sobre la orden.
    // Principio: phone = clave primaria de enlace; contact = fuente de verdad para dirección.
    const orders = rows.map(o => {
      const result = { ...o };
      // Preferir datos del contacto cuando existen (no solo como fallback)
      if (result.contact_city)    result.shipping_city     = result.contact_city;
      if (result.contact_address1) result.shipping_address1 = result.contact_address1;
      // Limpiar campos auxiliares del JOIN
      delete result.contact_address1;
      delete result.contact_city;
      delete result.contact_province;
      return result;
    });

    res.json({ success: true, orders, total: orders.length, lastSync });
  } catch (err) {
    console.error('[Orders/Shopify GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/shopify/:id/address
 * Editar dirección de una orden de Shopify (en nuestra DB local).
 * Body: { address1, city, province }
 */
router.patch('/shopify/:id/address', async (req, res) => {
  try {
    const { address1, city, province, updateContact = false } = req.body;
    if (!address1?.trim()) return res.status(400).json({ error: 'address1 es requerido' });

    const pool = getPool();
    const { rows: [before] } = await pool.query(
      'SELECT * FROM shopify_orders WHERE id = $1 AND organization_id = $2',
      [parseInt(req.params.id), req.orgId]
    );
    if (!before) return res.status(404).json({ error: 'Orden no encontrada' });
    const { rows } = await pool.query(
      `UPDATE shopify_orders
         SET shipping_city       = COALESCE($3, shipping_city),
             shipping_address1   = $2,
             synced_at           = NOW()
       WHERE id = $1 AND organization_id = $4
       RETURNING *`,
      [parseInt(req.params.id), address1.trim(), city?.trim() || null, req.orgId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Orden no encontrada' });

    // Cuando se edita desde el historial, el usuario puede convertir esta
    // dirección en la dirección vigente del cliente.
    if (updateContact && rows[0].customer_phone) {
      await getPool().query(
        `UPDATE contacts SET
           address1   = $2,
           address    = $2,
           city       = $3,
           updated_at = NOW()
         WHERE organization_id = $1 AND phone = $4`,
        [req.orgId, address1.trim(), city?.trim() || null, rows[0].customer_phone]
      );
    }

    const notification = await sendOrderEditNotification(req.orgId, {
      source: 'shopify', id: rows[0].shopify_order_id, before, after: rows[0],
    });
    res.json({ success: true, data: rows[0], notification });
  } catch (err) {
    console.error('[Orders/Shopify PATCH address]', err.message);
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
 * PATCH /api/orders/:id/items
 * Reemplaza los items de un pedido bot y recalcula el total.
 * Body: { items: [{ name, quantity, price }] }
 */
router.patch('/:id/items', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un array' });
    const total = items.reduce((s, i) => s + (Number(i.price) * Number(i.quantity)), 0);
    const pool = getPool();
    const orderId = parseInt(req.params.id);
    const { rows: [before] } = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
      [orderId, req.orgId]
    );
    if (!before) return res.status(404).json({ error: 'Pedido no encontrado' });
    const { rows: [updated] } = await pool.query(
      `UPDATE orders SET items = $1, total_price = $2, updated_at = NOW()
        WHERE id = $3 AND organization_id = $4 RETURNING *`,
      [JSON.stringify(items), String(total), orderId, req.orgId]
    );
    const notification = await sendOrderEditNotification(req.orgId, {
      source: 'bot', id: orderId, before, after: updated,
    });
    res.json({ success: true, data: updated, notification });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/:id/address
 * Actualizar dirección de un pedido (bot) sin conversación o con dirección vacía
 */
router.patch('/:id/address', async (req, res) => {
  try {
    const { address, city, updateContact = false } = req.body;
    if (!address) return res.status(400).json({ error: 'address es requerido' });
    const addrJson = JSON.stringify({ address, city: city || '' });
    const pool = getPool();
    const orderId = parseInt(req.params.id);
    const { rows: [before] } = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
      [orderId, req.orgId]
    );
    if (!before) return res.status(404).json({ error: 'Pedido no encontrado' });
    const { rows: [order] } = await pool.query(
      `UPDATE orders SET shipping_address = $1 WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [addrJson, orderId, req.orgId]
    );
    if (updateContact && order.customer_phone) {
      await pool.query(
        `UPDATE contacts SET
           address1 = $2,
           address = $2,
           city = $3,
           updated_at = NOW()
         WHERE organization_id = $1 AND phone = $4`,
        [req.orgId, address.trim(), city?.trim() || null, order.customer_phone]
      );
    }
    const notification = await sendOrderEditNotification(req.orgId, {
      source: 'bot', id: orderId, before, after: order,
    });
    res.json({ success: true, order, notification });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orders/:id
 * Detalle de una orden
 */
/**
 * GET /api/orders/scheduled
 * IMPORTANTE: debe estar ANTES de /:id para no ser interceptado por el wildcard.
 */
router.get('/scheduled', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT so.*, c.contact_name, c.phone_number AS conv_phone
       FROM scheduled_orders so
       LEFT JOIN conversations c ON c.id = so.conversation_id
       WHERE so.organization_id = $1
       ORDER BY so.desired_date ASC, so.created_at DESC`,
      [req.orgId]
    );
    res.json({ success: true, orders: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/scheduled/:id/cancel
 * IMPORTANTE: debe estar ANTES de /:id para no ser interceptado.
 */
router.patch('/scheduled/:id/cancel', async (req, res) => {
  try {
    const pool = getPool();
    const { rowCount } = await pool.query(
      `UPDATE scheduled_orders SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status = 'pending'`,
      [req.params.id, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: 'No encontrado o ya procesado' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─── COBRANZA ─────────────────────────────────────────────────────────────
 * OJO: estas rutas van ANTES de router.get('/:id'), si no Express matchea
 * '/pending-charge' como un id de pedido.
 */

/**
 * GET /api/orders/pending-charge
 * Pedidos entregados, marcados como transferencia por el repartidor, que
 * todavía no tienen comprobante verificado. Alimenta el tab "Por cobrar".
 */
router.get('/pending-charge', async (req, res) => {
  try {
    const [orders, settings] = await Promise.all([
      collection.getPendingCharges(req.orgId),
      collection.getChargeSettings(req.orgId),
    ]);
    // Preview del mensaje tal como le llegaría a cada cliente
    const withPreview = orders.map(o => ({
      ...o,
      preview: collection.buildChargeMessage(o, settings),
    }));
    res.json({
      success: true,
      orders:  withPreview,
      total:   withPreview.reduce((s, o) => s + o.total_price, 0),
      settings,
    });
  } catch (err) {
    console.error('[Orders/pending-charge]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/orders/send-charge
 * Envía el mensaje de cobro a los pedidos seleccionados.
 * Body: { orders: [{ source: 'bot'|'shopify', id }], force?: boolean }
 *
 * Nunca falla en bloque: devuelve el resultado pedido por pedido, para que el
 * panel pueda mostrar cuáles salieron y cuáles no (y por qué).
 */
router.post('/verify-charges', async (req, res) => {
  const selection = req.body.orders;
  if (!Array.isArray(selection) || !selection.length || selection.length > 5 || selection.some(o => !o || !['bot','shopify'].includes(o.source) || o.id == null)) return res.status(400).json({ success: false, error: 'Selecciona entre 1 y 5 pedidos válidos' });
  try {
    const results = await collection.reconcileCharges(req.orgId, selection, io);
    res.json({ success: true, results });
  } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});

router.post('/send-charge', async (req, res) => {
  const { orders: selection = [], force = false, template = null } = req.body;
  if (template && template !== collection.CHARGE_TEMPLATE_NAME) {
    return res.status(400).json({ success: false, error: `El template "${template}" no es compatible con cobranza. Usa ${collection.CHARGE_TEMPLATE_NAME}.` });
  }
  if (!Array.isArray(selection) || selection.length === 0) {
    return res.status(400).json({ success: false, error: 'Selecciona al menos un pedido' });
  }
  if (selection.length > 100) {
    return res.status(400).json({ success: false, error: 'Máximo 100 pedidos por envío' });
  }

  try {
    const pending = await collection.getPendingCharges(req.orgId);
    const results = [];

    for (const sel of selection) {
      const order = pending.find(
        o => o.source === sel.source && String(o.id) === String(sel.id)
      );
      if (!order) {
        results.push({ ...sel, ok: false, reason: 'no_por_cobrar' });
        continue;
      }
      if (['pending', 'pre_verified'].includes(order.proof_status)) {
        results.push({ ...sel, ok: false, reason: 'voucher_por_revisar', proofId: order.proof_id });
        continue;
      }
      const r = await collection.sendChargeRequest(req.orgId, order, { force, io, templateOverride: template });
      results.push({
        source: order.source,
        id:     order.id,
        label:  order.order_label,
        name:   order.customer_name,
        ...r,
      });
    }

    const sent = results.filter(r => r.ok).length;
    res.json({ success: true, sent, failed: results.length - sent, results });
  } catch (err) {
    console.error('[Orders/send-charge]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/payment-method
 * Corregir a mano el medio de pago de un pedido (si el repartidor se equivocó).
 * Body: { source: 'bot'|'shopify', id, paymentMethod, paymentCashAmount?, paymentTransferAmount? }
 */
router.patch('/payment-method', async (req, res) => {
  const { source, id, paymentMethod, paymentCashAmount, paymentTransferAmount } = req.body;
  const VALID = ['efectivo', 'transferencia', 'mixto', 'otro', null];
  if (!['bot', 'shopify'].includes(source)) {
    return res.status(400).json({ success: false, error: "source debe ser 'bot' o 'shopify'" });
  }
  if (!VALID.includes(paymentMethod ?? null)) {
    return res.status(400).json({ success: false, error: 'Medio de pago inválido' });
  }

  try {
    const pool = getPool();
    const method = paymentMethod ?? null;
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idCol = source === 'shopify' ? 'shopify_order_id' : 'id';
    const { rows: [existing] } = await pool.query(
      `SELECT total_price FROM ${table} WHERE ${idCol} = $1 AND organization_id = $2`,
      [source === 'shopify' ? String(id) : parseInt(id), req.orgId]
    );
    if (!existing) return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    const total = Math.round(Number(existing.total_price) || 0);
    const { cash: cashAmount, transfer: transferAmount } = paymentBreakdown(method, total, paymentCashAmount, paymentTransferAmount);
    // Al cambiar el medio de pago reconciliamos el estado de pago:
    //  • A transferencia/otro/—: si estaba "pagado" SOLO por efectivo/marca manual
    //    (sin comprobante verificado), vuelve a "entregado" → reaparece en Por cobrar.
    //    No toca los pagados con comprobante real ni (en Shopify) los pagados online.
    //  • A efectivo: si ya se entregó, queda pagado (efectivo al entregar).
    const nonCash = method === null || method === 'transferencia' || method === 'mixto' || method === 'otro';
    const { rowCount } = source === 'shopify'
      ? await pool.query(
          `UPDATE shopify_orders
              SET payment_method = $1,
                  payment_cash_amount = $5,
                  payment_transfer_amount = $6,
                  financial_status = CASE
                    WHEN $4::boolean AND LOWER(COALESCE(financial_status,'')) = 'paid'
                         AND payment_marked_at IS NOT NULL
                      THEN 'pending'
                    WHEN $1 = 'efectivo' AND crm_status = 'entregado'
                      THEN 'paid'
                    ELSE financial_status END,
                  payment_marked_at = CASE
                    WHEN $1 = 'efectivo' AND crm_status = 'entregado' THEN NOW()
                    WHEN $4::boolean AND LOWER(COALESCE(financial_status,'')) = 'paid'
                         AND payment_marked_at IS NOT NULL THEN NULL
                    ELSE payment_marked_at END
            WHERE shopify_order_id = $2 AND organization_id = $3`,
          [method, String(id), req.orgId, nonCash, cashAmount, transferAmount]
        )
      : await pool.query(
          `UPDATE orders o
              SET payment_method = $1,
                  payment_cash_amount = $5,
                  payment_transfer_amount = $6,
                  status = CASE
                    WHEN $4::boolean AND o.status = 'paid'
                         AND NOT EXISTS (SELECT 1 FROM payment_proofs pp
                                          WHERE pp.order_id = o.id
                                            AND pp.status IN ('verified','pre_verified'))
                      THEN 'entregado'
                    WHEN $1 = 'efectivo' AND o.status = 'entregado'
                      THEN 'paid'
                    ELSE o.status END,
                  payment_marked_at = CASE
                    WHEN $1 = 'efectivo' AND o.status = 'entregado' THEN NOW()
                    WHEN $4::boolean AND o.status = 'paid'
                         AND NOT EXISTS (SELECT 1 FROM payment_proofs pp
                                          WHERE pp.order_id = o.id
                                            AND pp.status IN ('verified','pre_verified'))
                      THEN NULL
                    ELSE payment_marked_at END,
                  updated_at = NOW()
            WHERE o.id = $2 AND o.organization_id = $3`,
          [method, parseInt(id), req.orgId, nonCash, cashAmount, transferAmount]
        );

    if (!rowCount) return res.status(404).json({ success: false, error: 'Pedido no encontrado' });

    // ── Cobro automático: mismo comportamiento que la app de reparto ──────
    // Si la org activó autoSendOnTransfer y el pedido ya está entregado (y
    // sin comprobante), el mensaje de cobro sale al marcar "transferencia".
    let autoCharge = null;
    if (['transferencia', 'mixto'].includes(method)) {
      try {
        const settings = await collection.getChargeSettings(req.orgId);
        if (settings.autoSendOnTransfer) {
          const order = await collection.getOrderForCharge(req.orgId, source, id);
          if (order) {
            const r = await collection.sendChargeRequest(req.orgId, order, { io });
            autoCharge = { attempted: true, ...r };
          } else {
            // No está "por cobrar" todavía (p. ej. aún no se entregó): saldrá al entregar.
            autoCharge = { attempted: false, reason: 'pedido_no_por_cobrar' };
          }
        }
      } catch (err) {
        console.error('[Orders/payment-method] Cobro automático falló:', err.message);
        autoCharge = { attempted: true, ok: false, reason: 'error', error: err.message };
      }
    }

    res.json({ success: true, autoCharge });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
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
 * PATCH /api/orders/adjust-total
 * Corrige el MONTO real del pedido cuando lo entregado difiere de lo pedido
 * (ej: se entregaron solo los huevos sin la aceituna). Sirve tanto para el
 * cobro como para los totales de Despachos.
 * Body: { source: 'bot'|'shopify', id, total, note? }
 */
router.patch('/adjust-total', async (req, res) => {
  const { source, id, total, note } = req.body;
  const amount = Math.round(Number(total));
  if (!['bot', 'shopify'].includes(source)) {
    return res.status(400).json({ success: false, error: "source debe ser 'bot' o 'shopify'" });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ success: false, error: 'total inválido' });
  }
  try {
    const pool = getPool();
    const cleanNote = (note || '').toString().slice(0, 300);
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idColumn = source === 'shopify' ? 'shopify_order_id' : 'id';
    const key = source === 'shopify' ? String(id) : parseInt(id);
    const { rows: [before] } = await pool.query(
      `SELECT * FROM ${table} WHERE ${idColumn} = $1 AND organization_id = $2`,
      [key, req.orgId]
    );
    if (!before) return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    const result = source === 'shopify'
      ? await pool.query(
          `UPDATE shopify_orders
              SET total_price = $1, delivery_modified = TRUE,
                  delivery_note = COALESCE(NULLIF($4, ''), delivery_note)
            WHERE shopify_order_id = $2 AND organization_id = $3 RETURNING *`,
          [String(amount), String(id), req.orgId, cleanNote]
        )
      : await pool.query(
          `UPDATE orders
              SET total_price = $1, delivery_modified = TRUE, updated_at = NOW(),
                  delivery_note = COALESCE(NULLIF($4, ''), delivery_note)
            WHERE id = $2 AND organization_id = $3 RETURNING *`,
          [String(amount), parseInt(id), req.orgId, cleanNote]
        );
    const notification = await sendOrderEditNotification(req.orgId, {
      source, id, before, after: result.rows[0],
    });
    res.json({ success: true, total: amount, notification });
  } catch (err) {
    console.error('[Orders/adjust-total]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/reschedule
 * Reprograma un pedido a otra fecha SIN cancelarlo (el cliente lo quiere para
 * otro día). Fija delivery_date, lo mantiene/vuelve a dejar despachable y anota
 * el motivo. Body: { source, id, date: 'YYYY-MM-DD', note? }
 */
router.patch('/reschedule', async (req, res) => {
  const { source, id, date, note } = req.body;
  if (!['bot', 'shopify'].includes(source)) {
    return res.status(400).json({ success: false, error: "source debe ser 'bot' o 'shopify'" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return res.status(400).json({ success: false, error: 'date debe ser YYYY-MM-DD' });
  }
  let client;
  let committed = false;
  try {
    client = await getPool().connect();
    const stamp = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });
    const reason = (note || '').toString().slice(0, 200);
    const noteText = `[reprogramado ${stamp}] para ${date}${reason ? ` — ${reason}` : ''}`;
    await client.query('BEGIN');
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idColumn = source === 'shopify' ? 'shopify_order_id' : 'id';
    const key = source === 'shopify' ? String(id) : parseInt(id);
    const { rows: [before] } = await client.query(
      `SELECT * FROM ${table} WHERE ${idColumn} = $1 AND organization_id = $2 FOR UPDATE`,
      [key, req.orgId]
    );
    if (!before) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }
    const result = source === 'shopify'
      ? await client.query(
          `UPDATE shopify_orders
              SET delivery_date = $1::date,
                  crm_status    = 'por_despachar',
                  delivery_note = $4,
                  last_attempt_status = 'reprogramado',
                  last_attempt_at = NOW(),
                  synced_at     = NOW()
            WHERE shopify_order_id = $2 AND organization_id = $3 RETURNING *`,
          [date, String(id), req.orgId, noteText]
        )
      : await client.query(
          `UPDATE orders
              SET delivery_date = $1::date,
                  status        = 'por_despachar',
                  last_attempt_status = 'reprogramado',
                  last_attempt_at = NOW(),
                  notes         = COALESCE(notes, '') || $4,
                  updated_at    = NOW()
            WHERE id = $2 AND organization_id = $3 RETURNING *`,
          [date, parseInt(id), req.orgId, `\n[admin] ${noteText}`]
        );
    const routeIds = await recordRouteOutcome(client, req.orgId, source, id, 'postponed', noteText);
    await client.query('COMMIT');
    committed = true;
    client.release();
    client = null;
    const notification = await sendOrderEditNotification(req.orgId, {
      source, id, before, after: result.rows[0],
    });
    res.json({ success: true, date, historicalRoutes: routeIds, notification });
  } catch (err) {
    if (client && !committed) await client.query('ROLLBACK').catch(() => {});
    client?.release?.();
    console.error('[Orders/reschedule]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/orders/order-items?source=bot|shopify&id=...
 * Devuelve los items del pedido con su precio y el total, para editarlos.
 */
router.get('/order-items', async (req, res) => {
  const { source, id } = req.query;
  if (!['bot', 'shopify'].includes(source)) return res.status(400).json({ success: false, error: 'source inválido' });
  try {
    const pool = getPool();
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idCol = source === 'shopify' ? 'shopify_order_id' : 'id';
    const idVal = source === 'shopify' ? String(id) : parseInt(id);
    const { rows: [row] } = await pool.query(
      `SELECT items, total_price FROM ${table} WHERE ${idCol} = $1 AND organization_id = $2`,
      [idVal, req.orgId]
    );
    if (!row) return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    let items = [];
    try { items = Array.isArray(row.items) ? row.items : (typeof row.items === 'string' ? JSON.parse(row.items || '[]') : (row.items || [])); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    const norm = items.map(i => ({ name: i.name || i.title || '', quantity: Number(i.quantity) || 0, price: Number(i.price) || 0, extra: !!i._deliveryExtra }));
    res.json({ success: true, items: norm, total: Math.round(parseFloat(row.total_price) || 0) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/set-items
 * Reemplaza los productos del pedido y recalcula el total (lo entregado != lo pedido).
 * Body: { source, id, items: [{ name, quantity, price, extra? }] }
 */
router.patch('/set-items', async (req, res) => {
  const { source, id, items } = req.body;
  if (!['bot', 'shopify'].includes(source)) return res.status(400).json({ success: false, error: 'source inválido' });
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items debe ser un array' });
  try {
    const clean = items
      .map(i => ({
        name: String(i.name || i.title || '').slice(0, 200),
        title: String(i.name || i.title || '').slice(0, 200),
        quantity: Math.max(0, Math.round(Number(i.quantity) || 0)),
        price: Math.max(0, Math.round(Number(i.price) || 0)),
        ...(i.extra ? { _deliveryExtra: true } : {}),
      }))
      .filter(i => i.name && i.quantity > 0);
    const total = clean.reduce((s, i) => s + i.price * i.quantity, 0);
    const itemsJson = JSON.stringify(clean);
    const pool = getPool();
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idColumn = source === 'shopify' ? 'shopify_order_id' : 'id';
    const key = source === 'shopify' ? String(id) : parseInt(id);
    const { rows: [before] } = await pool.query(
      `SELECT * FROM ${table} WHERE ${idColumn} = $1 AND organization_id = $2`,
      [key, req.orgId]
    );
    if (!before) return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    const result = source === 'shopify'
      ? await pool.query(
          `UPDATE shopify_orders SET items = $1::jsonb, total_price = $2, delivery_modified = TRUE
            WHERE shopify_order_id = $3 AND organization_id = $4 RETURNING *`,
          [itemsJson, total, String(id), req.orgId]
        )
      : await pool.query(
          `UPDATE orders SET items = $1, total_price = $2, delivery_modified = TRUE, updated_at = NOW()
            WHERE id = $3 AND organization_id = $4 RETURNING *`,
          [itemsJson, String(total), parseInt(id), req.orgId]
        );
    const after = result.rows[0];
    const notification = await sendOrderEditNotification(req.orgId, { source, id, before, after });
    res.json({ success: true, total, items: clean, notification });
  } catch (err) {
    console.error('[Orders/set-items]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/orders/history-edit
 * Edita productos y dirección como una sola operación desde el historial.
 * Body: { source, id, items, address, city, updateContact }
 */
router.patch('/history-edit', async (req, res) => {
  const { source, id, items, address, city, updateContact = false } = req.body;
  if (!['bot', 'shopify'].includes(source)) return res.status(400).json({ success: false, error: 'source inválido' });
  if (!Array.isArray(items)) return res.status(400).json({ success: false, error: 'items debe ser un array' });
  if (!String(address || '').trim()) return res.status(400).json({ success: false, error: 'La dirección es requerida' });

  const clean = items
    .map(item => ({
      name: String(item.name || item.title || '').trim().slice(0, 200),
      title: String(item.name || item.title || '').trim().slice(0, 200),
      quantity: Math.max(0, Math.round(Number(item.quantity) || 0)),
      price: Math.max(0, Math.round(Number(item.price) || 0)),
    }))
    .filter(item => item.name && item.quantity > 0);
  if (!clean.length) return res.status(400).json({ success: false, error: 'El pedido debe tener al menos un producto' });

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const total = clean.reduce((sum, item) => sum + item.price * item.quantity, 0);
    let order;
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idColumn = source === 'shopify' ? 'shopify_order_id' : 'id';
    const key = source === 'shopify' ? String(id) : parseInt(id);
    const { rows: [before] } = await client.query(
      `SELECT * FROM ${table} WHERE ${idColumn} = $1 AND organization_id = $2 FOR UPDATE`,
      [key, req.orgId]
    );
    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }
    if (source === 'shopify') {
      const { rows } = await client.query(
        `UPDATE shopify_orders
            SET items = $1::jsonb,
                total_price = $2,
                shipping_address1 = $3,
                shipping_city = $4,
                delivery_modified = TRUE,
                synced_at = NOW()
          WHERE shopify_order_id = $5 AND organization_id = $6
          RETURNING *`,
        [JSON.stringify(clean), total, address.trim(), String(city || '').trim() || null, String(id), req.orgId]
      );
      order = rows[0];
    } else {
      const { rows } = await client.query(
        `UPDATE orders
            SET items = $1,
                total_price = $2,
                shipping_address = $3,
                delivery_modified = TRUE,
                updated_at = NOW()
          WHERE id = $4 AND organization_id = $5
          RETURNING *`,
        [JSON.stringify(clean), String(total), JSON.stringify({ address: address.trim(), city: String(city || '').trim() }), parseInt(id), req.orgId]
      );
      order = rows[0];
    }
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }

    if (updateContact && order.customer_phone) {
      const phone = String(order.customer_phone).replace(/\s+/g, '');
      const variants = [...new Set([
        phone,
        phone.startsWith('56') ? phone.slice(2) : null,
        phone.startsWith('9') && phone.length === 9 ? `56${phone}` : null,
        !phone.startsWith('+') && phone.startsWith('56') ? `+${phone}` : null,
      ].filter(Boolean))];
      await client.query(
        `UPDATE contacts
            SET address1 = $3, address = $3, city = $4, updated_at = NOW()
          WHERE organization_id = $1 AND phone = ANY($2::text[])`,
        [req.orgId, variants, address.trim(), String(city || '').trim() || null]
      );
    }

    await client.query('COMMIT');
    const notification = await sendOrderEditNotification(req.orgId, { source, id, before, after: order });
    res.json({ success: true, total, items: clean, order, notification });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Orders/history-edit]', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/orders/history-payment
 * Registra manualmente un pago desde el historial del cliente. Es una marca
 * contable local: no captura dinero ni modifica la orden remota de Shopify.
 */
router.patch('/history-payment', async (req, res) => {
  const { source, id, paymentMethod, paymentCashAmount, paymentTransferAmount } = req.body || {};
  if (!['bot', 'shopify'].includes(source)) return res.status(400).json({ success: false, error: 'source inválido' });
  if (!['efectivo', 'transferencia', 'mixto', 'otro'].includes(paymentMethod)) {
    return res.status(400).json({ success: false, error: 'Selecciona un medio de pago válido' });
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const table = source === 'shopify' ? 'shopify_orders' : 'orders';
    const idColumn = source === 'shopify' ? 'shopify_order_id' : 'id';
    const key = source === 'shopify' ? String(id) : parseInt(id);
    if (source === 'bot' && !Number.isInteger(key)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Pedido inválido' });
    }
    const { rows: [order] } = await client.query(
      `SELECT * FROM ${table} WHERE ${idColumn}=$1 AND organization_id=$2 FOR UPDATE`,
      [key, req.orgId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Pedido no encontrado' });
    }
    const cancelled = source === 'shopify'
      ? ['VOIDED', 'REFUNDED'].includes(String(order.financial_status || '').toUpperCase()) || order.crm_status === 'cancelled'
      : order.status === 'cancelled';
    if (cancelled) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'No se puede registrar pago en un pedido cancelado o reembolsado' });
    }
    const alreadyPaid = source === 'shopify'
      ? String(order.financial_status || '').toUpperCase() === 'PAID'
      : ['paid', 'payment_received'].includes(order.status);
    if (alreadyPaid) {
      await client.query('COMMIT');
      return res.json({ success: true, alreadyPaid: true, order });
    }
    const total = Math.round(Number(order.total_price) || 0);
    if (total <= 0) throw Object.assign(new Error('El pedido no tiene un total válido'), { status: 400 });
    const amounts = paymentBreakdown(paymentMethod, total, paymentCashAmount, paymentTransferAmount);
    const result = source === 'shopify'
      ? await client.query(
          `UPDATE shopify_orders
              SET financial_status='paid', payment_method=$1,
                  payment_cash_amount=$2, payment_transfer_amount=$3,
                  payment_marked_at=NOW(), payment_marked_by=$4,
                  payment_record_source='manual_history', updated_at=NOW()
            WHERE shopify_order_id=$5 AND organization_id=$6 RETURNING *`,
          [paymentMethod, amounts.cash, amounts.transfer, req.userId, key, req.orgId]
        )
      : await client.query(
          `UPDATE orders
              SET status='paid', payment_method=$1,
                  payment_cash_amount=$2, payment_transfer_amount=$3,
                  payment_marked_at=NOW(), payment_marked_by=$4,
                  payment_record_source='manual_history', updated_at=NOW()
            WHERE id=$5 AND organization_id=$6 RETURNING *`,
          [paymentMethod, amounts.cash, amounts.transfer, req.userId, key, req.orgId]
        );
    await client.query('COMMIT');
    res.json({ success: true, alreadyPaid: false, order: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Orders/history-payment]', err.message);
    res.status(err.status === 400 ? 400 : 500).json({ success: false, error: err.message });
  } finally {
    client.release();
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

    const whatsappProvider = require('../services/whatsapp-provider');
    const conv = await db.getConversationById(order.conversation_id, req.orgId);
    const wc = await whatsappProvider.configForConversation(req.orgId, conv);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    const msg = `🔔 Recordatorio de tu pedido:\n\n💳 Completa tu pago aquí:\n${order.invoice_url}\n\n¡Te esperamos! 😊`;
    await whatsappProvider.sendTextMessage(order.phone_number, msg, wc);

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
  const VALID = ['nuevo','por_despachar','asignado_ruta','en_camino','no_entregado','entregado','paid','cancelled','draft','sent','payment_received'];
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
  try { return JSON.parse(str) ?? fallback; } catch { return fallback; }
}

module.exports = router;
module.exports.setSocketIO = setSocketIO;
