/**
 * clientes.js — Clientes desde Shopify (fuente principal)
 *
 * GET /api/clientes/all   → TODOS los clientes de Shopify (loop en backend, 1 sola llamada al frontend)
 * GET /api/clientes       → una página de clientes (cursor-based, para uso futuro)
 * GET /api/clientes/local → clientes en DB local del bot (conversaciones)
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db/database');
const { getPool } = require('../db/database');
const raigentic = require('../services/raigentic');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * GET /api/clientes/all
 * Descarga TODOS los clientes de Shopify paginando internamente (servidor a servidor).
 * El frontend hace UNA sola llamada y espera el resultado completo.
 */
router.get('/all', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, customers: [], total: 0 });

    const shop  = ds.config?.storeUrl;
    const query = req.query.query || undefined;

    let allCustomers = [];
    let cursor       = undefined;
    let page         = 0;

    while (true) {
      page++;

      // Retry hasta 3 veces en caso de 503/429 de Shopify
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await raigentic.getClientes(shop, { limit: 100, cursor, query });
          break; // éxito
        } catch (err) {
          const status = err.response?.status;
          if ((status === 503 || status === 429) && attempt < 3) {
            const wait = attempt * 1500; // 1.5s, 3s
            console.warn(`[Clientes/all] Shopify ${status}, reintentando en ${wait}ms (intento ${attempt}/3)`);
            await sleep(wait);
          } else {
            throw err;
          }
        }
      }

      if (!result.success) {
        throw new Error(result.error || 'Error obteniendo clientes');
      }

      allCustomers = allCustomers.concat(result.customers || []);
      console.log(`[Clientes/all] Página ${page}: ${result.customers?.length || 0} clientes (total: ${allCustomers.length})`);

      if (!result.hasNextPage || !result.endCursor) break;
      cursor = result.endCursor;

      // Pausa entre páginas para no saturar la API de Shopify
      await sleep(300);

      // Límite de seguridad: máximo 50 páginas (5.000 clientes con limit=100)
      if (page >= 50) {
        console.warn('[Clientes/all] Límite de páginas alcanzado (50). Deteniendo.');
        break;
      }
    }

    res.json({
      success:   true,
      customers: allCustomers,
      total:     allCustomers.length,
    });

  } catch (err) {
    console.error('[Clientes/all]', err.message);
    const isTimeout = err.code === 'ECONNABORTED';
    const friendly  = isTimeout
      ? 'Raigentic tardó demasiado (cold start). Intenta de nuevo.'
      : err.response?.data?.error || err.message;
    res.status(500).json({ success: false, error: friendly });
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
 * Una página de clientes (mantener para compatibilidad)
 */
router.get('/', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, customers: [], total: 0 });

    const shop   = ds.config?.storeUrl;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 250);
    const cursor = req.query.cursor || undefined;
    const query  = req.query.query  || undefined;

    const result = await raigentic.getClientes(shop, { limit, cursor, query });
    res.json(result);
  } catch (err) {
    console.error('[Clientes/Shopify]', err.message);
    const isTimeout = err.code === 'ECONNABORTED';
    const friendly  = isTimeout
      ? 'Raigentic tardó demasiado (cold start). Intenta de nuevo.'
      : err.response?.data?.error || err.message;
    res.status(500).json({ success: false, error: friendly });
  }
});

module.exports = router;
