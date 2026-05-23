/**
 * clientes.js — Clientes desde Shopify GraphQL directo
 *
 * GET /api/clientes/all   → TODOS los clientes (loop en backend)
 * GET /api/clientes       → Una página de clientes (cursor-based)
 * GET /api/clientes/local → Clientes en DB local (conversaciones del bot)
 */

const express     = require('express');
const router      = express.Router();
const db          = require('../db/database');
const { getPool } = require('../db/database');
const shopifyApi  = require('../services/shopify-api');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/clientes/all
 * Descarga TODOS los clientes de Shopify paginando internamente.
 * El frontend hace UNA sola llamada y espera el resultado completo.
 */
router.get('/all', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, customers: [], total: 0 });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const query           = req.query.query || '';

    const customers = await shopifyApi.getAllCustomers(shop, token, query);

    res.json({
      success:   true,
      customers,
      total:     customers.length,
    });

  } catch (err) {
    console.error('[Clientes/all]', err.message);

    // Token expirado o inválido → guiar al usuario a reconectar
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
 * Clientes del bot (conversaciones locales)
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
 * Una página de clientes (para uso futuro con paginación en UI)
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
