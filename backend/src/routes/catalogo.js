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
  const ds = await db.getPrimaryDataSource(req.orgId);
  if (!ds) return res.json({ success: true, products: [], total: 0, message: 'Sin tienda Shopify conectada' });

  const shop   = ds.config?.storeUrl;
  const search = req.query.search || '';
  const limit  = Math.min(parseInt(req.query.limit) || 100, 250);
  const offset = parseInt(req.query.offset) || 0;

  // ── Intentar traer desde raigentic ──────────────────────────────────
  try {
    const opts = { limit, offset };
    if (search) opts.search = search;

    const result = await raigentic.getProductos(shop, opts);
    const products = result.products || [];

    // Guardar en caché de DB si hay productos y no es búsqueda filtrada
    if (!search && products.length > 0) {
      db.cacheProducts(req.orgId, ds.id, products.map(p => ({
        externalId:        String(p.id || p.externalId || p.external_id || ''),
        title:             p.title || '',
        description:       p.description || p.body_html || '',
        price:             String(p.priceMin ?? p.price_min ?? p.price ?? '0'),
        compareAtPrice:    String(p.compareAtPrice ?? p.compare_at_price ?? ''),
        sku:               p.sku || p.variants?.[0]?.sku || '',
        inventoryQuantity: p.inventoryTotal ?? p.inventory_total ?? null,
        imageUrl:          p.imageUrl || p.image_url || p.image?.src || '',
        tags:              Array.isArray(p.tags) ? p.tags.join(',') : (p.tags || ''),
        productType:       p.productType || p.product_type || '',
        handle:            p.handle || '',
        rawJson:           JSON.stringify(p),
      }))).catch(() => {}); // no crítico
    }

    return res.json({ success: true, shop, products, total: result.total || products.length, limit, offset });

  } catch (err) {
    const status = err.response?.status;
    const isSleeping = !status || status === 502 || status === 503 || status === 504;
    console.warn(`[Catalogo] raigentic ${isSleeping ? 'dormido' : 'error'} (${status}): ${err.message}`);

    // ── Fallback: caché de DB ────────────────────────────────────────
    try {
      const cached = await db.getCachedProducts(req.orgId);
      const ageMin = await db.getProductsCacheAge(req.orgId);

      let filtered = cached;
      if (search) {
        const q = search.toLowerCase();
        filtered = cached.filter(p =>
          p.title?.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.tags?.toLowerCase().includes(q)
        );
      }

      const sliced = filtered.slice(offset, offset + limit);
      const ageStr = isFinite(ageMin) ? `hace ${Math.round(ageMin)} min` : 'sin fecha';

      return res.json({
        success:   true,
        shop,
        products:  sliced.map(p => ({
          id:          p.external_id,
          title:       p.title,
          description: p.description,
          price:       p.price,
          imageUrl:    p.image_url,
          handle:      p.handle,
          productType: p.product_type,
          tags:        p.tags,
        })),
        total:     filtered.length,
        limit,
        offset,
        fromCache: true,
        cacheAge:  ageStr,
        warning:   isSleeping
          ? `raigentic está iniciando. Mostrando ${cached.length} productos del caché (${ageStr}). Reintenta en 30s.`
          : `Error conectando con Shopify. Mostrando caché (${ageStr}).`,
      });
    } catch (cacheErr) {
      // Si hasta el caché falla, devolver vacío con mensaje claro
      return res.json({
        success:  true,
        shop,
        products: [],
        total:    0,
        warning:  'raigentic no disponible y sin caché local. Usa "Sincronizar" cuando esté disponible.',
      });
    }
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
