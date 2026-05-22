/**
 * catalogo.js — Catálogo de productos para el frontend del CRM
 *
 * GET /api/catalogo          → lista de productos desde raigentic
 * POST /api/catalogo/sync    → sincroniza productos con Shopify
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db/database');
const raigentic = require('../services/raigentic');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/catalogo?search=&limit=100&offset=0
 */
router.get('/', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, products: [], total: 0, message: 'Sin tienda Shopify conectada' });

    const shop   = ds.config?.storeUrl;
    const search = req.query.search || '';
    const limit  = Math.min(parseInt(req.query.limit) || 100, 250);
    const offset = parseInt(req.query.offset) || 0;

    const opts = { limit, offset };
    if (search) opts.search = search;

    const result = await raigentic.getProductos(shop, opts);

    res.json({
      success:  true,
      shop,
      products: result.products || [],
      total:    result.total || 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[Catalogo] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/catalogo/sync — Sincroniza todos los productos desde Shopify
 */
router.post('/sync', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.status(400).json({ success: false, error: 'Sin tienda Shopify conectada' });

    const shop = ds.config?.storeUrl;
    const result = await raigentic.sincronizarProductos(shop);

    // Invalidar caché para que el siguiente GET traiga datos frescos
    raigentic.invalidarCacheProductos(shop);

    res.json({ success: true, shop, ...result });
  } catch (err) {
    console.error('[Catalogo] Error sync:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
