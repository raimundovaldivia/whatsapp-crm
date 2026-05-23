/**
 * catalogo.js — Catálogo de productos desde Shopify GraphQL directo
 *
 * GET /api/catalogo          → Lista de productos (con búsqueda y paginación)
 * GET /api/catalogo/all      → TODOS los productos (para sincronizar)
 */

const express    = require('express');
const router     = express.Router();
const db         = require('../db/database');
const shopifyApi = require('../services/shopify-api');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/catalogo?search=&limit=100&cursor=
 * Lista de productos de Shopify con búsqueda y paginación cursor-based.
 */
router.get('/', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, products: [], total: 0, message: 'Sin tienda Shopify conectada' });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const search = req.query.search || '';
    const limit  = Math.min(parseInt(req.query.limit) || 100, 250);
    const cursor = req.query.cursor || null;

    const result = await shopifyApi.getProducts(shop, token, { limit, cursor, search });

    return res.json({
      success:     true,
      shop,
      products:    result.products,
      total:       result.total,
      hasNextPage: result.hasNextPage,
      endCursor:   result.endCursor,
      limit,
    });

  } catch (err) {
    console.error('[Catalogo]', err.message);

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
 * GET /api/catalogo/all
 * Descarga TODOS los productos paginando internamente.
 * Útil para sincronización y para el agente IA.
 */
router.get('/all', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, products: [], total: 0 });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const products = await shopifyApi.getAllProducts(shop, token);

    res.json({ success: true, shop, products, total: products.length });
  } catch (err) {
    console.error('[Catalogo/all]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
