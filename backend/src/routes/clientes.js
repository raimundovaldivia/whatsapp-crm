/**
 * clientes.js — Clientes Shopify servidos desde DB local (contacts)
 *
 * GET  /api/clientes/all   → Clientes desde contacts (sincronizados)
 * POST /api/clientes/sync  → Sincroniza clientes de Shopify → contacts
 * GET  /api/clientes/local → Clientes del bot (conversaciones WhatsApp)
 * GET  /api/clientes       → Una página de Shopify (fallback, paginación)
 */

const express     = require('express');
const router      = express.Router();
const db          = require('../db/database');
const { getPool } = require('../db/database');
const shopifyApi  = require('../services/shopify-api');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/** Convierte una fila de contacts al formato que espera el frontend */
function contactToCustomer(c) {
  // orders_count viene de customer profile sync (Shopify)
  // total_orders viene de order sync (conteo real)
  // real_orders viene del JOIN con shopify_orders en /all
  const ordersCount = parseInt(c.real_orders || c.orders_count || c.total_orders) || 0;
  const totalSpent  = parseFloat(c.real_spent || c.total_spent) || 0;
  return {
    id:          c.id,
    shopifyId:   c.shopify_id,
    name:        c.name || '—',
    firstName:   (c.name || '').split(' ')[0],
    email:       c.email,
    phone:       c.phone,
    ordersCount,
    totalSpent,
    currency:    c.currency || 'CLP',
    tags:        Array.isArray(c.tags) ? c.tags : (c.tags ? JSON.parse(c.tags) : []),
    address: {
      address1: c.address1 || c.address || null,
      address2: c.address2 || null,
      city:     c.city     || null,
      province: c.province || null,
      zip:      c.zip      || null,
      country:  c.country  || null,
    },
    createdAt:   c.shopify_created_at || c.created_at,
    lastOrder:   c.last_order_data
                   ? (typeof c.last_order_data === 'string' ? JSON.parse(c.last_order_data) : c.last_order_data)
                   : null,
    note:        c.shopify_note || c.notes || null,
    shopifySyncedAt: c.shopify_synced_at || null,
  };
}

/**
 * GET /api/clientes/all
 * Devuelve clientes desde la tabla contacts local (sin llamar a Shopify).
 * Si no hay clientes sincronizados, indica que hay que hacer /sync primero.
 */
router.get('/all', async (req, res) => {
  try {
    const q = (req.query.query || '').toLowerCase();
    const params = [req.orgId];

    let whereExtra = '';
    if (q) {
      params.push(`%${q}%`);
      whereExtra = ` AND (LOWER(co.name) LIKE $${params.length}
                      OR LOWER(co.email) LIKE $${params.length}
                      OR co.phone LIKE $${params.length})`;
    }

    // JOIN con shopify_orders para obtener conteo real y última dirección
    const sql = `
      SELECT
        co.*,
        COALESCE(ord.real_orders, 0)          AS real_orders,
        COALESCE(ord.real_spent,  0)          AS real_spent,
        ord.last_shipping_address             AS last_raw,
        ord.last_shipping_city                AS ord_city
      FROM contacts co
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)                            AS real_orders,
          SUM(total_price::numeric)           AS real_spent,
          (
            SELECT raw_json->>'shippingAddress'
            FROM shopify_orders so2
            WHERE so2.organization_id = $1
              AND so2.customer_phone = co.phone
            ORDER BY so2.shopify_created_at DESC NULLS LAST
            LIMIT 1
          )                                   AS last_shipping_address,
          (
            SELECT shipping_city
            FROM shopify_orders so2
            WHERE so2.organization_id = $1
              AND so2.customer_phone = co.phone
            ORDER BY so2.shopify_created_at DESC NULLS LAST
            LIMIT 1
          )                                   AS last_shipping_city
        FROM shopify_orders so
        WHERE so.organization_id = $1
          AND so.customer_phone = co.phone
      ) ord ON true
      WHERE co.organization_id = $1
        AND (co.shopify_id IS NOT NULL OR co.contact_type = 'customer')
        ${whereExtra}
      ORDER BY co.last_order_at DESC NULLS LAST, co.created_at DESC
    `;

    const { rows } = await getPool().query(sql, params);

    // Si el contacto no tiene dirección guardada, usar la del último pedido de shopify_orders
    const customers = rows.map(c => {
      if (!c.address1 && !c.address) {
        if (c.last_raw) {
          try {
            const addr = JSON.parse(c.last_raw);
            c.address1 = addr?.address1 || null;
            c.city     = c.city || addr?.city || c.ord_city || null;
          } catch {}
        } else if (c.ord_city) {
          c.city = c.city || c.ord_city;
        }
      }
      return contactToCustomer(c);
    });

    res.json({
      success:   true,
      customers,
      total:     customers.length,
      fromCache: true,
      needsSync: customers.length === 0,
    });

  } catch (err) {
    console.error('[Clientes/all]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/clientes/sync
 * Descarga todos los clientes de Shopify y los upsertea en contacts.
 * Llamar desde el frontend con un botón "Sincronizar clientes".
 */
router.post('/sync', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.status(400).json({ success: false, error: 'No hay fuente de datos Shopify configurada' });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const customers = await shopifyApi.getAllCustomers(shop, token, '');

    let synced = 0;
    for (const c of customers) {
      await db.upsertShopifyCustomerProfile(req.orgId, c);
      synced++;
    }

    res.json({ success: true, synced });

  } catch (err) {
    console.error('[Clientes/sync]', err.message);
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
 * GET /api/clientes/local
 * Clientes del bot (conversaciones locales de WhatsApp)
 */
router.get('/local', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT
        c.id            AS conversation_id,
        c.phone_number,
        c.contact_name,
        c.pipeline_state,
        c.last_message_at,
        COUNT(DISTINCT o.id)                    AS total_orders,
        SUM(o.total_price::numeric)             AS total_spent,
        MAX(o.created_at)                       AS last_order_at
      FROM conversations c
      LEFT JOIN orders o ON o.conversation_id = c.id AND o.organization_id = $1
      WHERE c.organization_id = $2
      GROUP BY c.id
      ORDER BY c.last_message_at DESC`,
      [req.orgId, req.orgId]
    );

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/clientes?limit=50&cursor=&query=
 * Una página de clientes desde Shopify (fallback / paginación externa)
 */
router.get('/', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, customers: [], total: 0 });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const limit  = Math.min(parseInt(req.query.limit) || 50, 250);
    const cursor = req.query.cursor || null;
    const query  = req.query.query  || '';

    const result = await shopifyApi.getCustomers(shop, token, { limit, cursor, query });
    res.json(result);
  } catch (err) {
    console.error('[Clientes]', err.message);
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

module.exports = router;
