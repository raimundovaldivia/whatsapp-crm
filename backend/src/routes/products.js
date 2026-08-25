/**
 * products.js — CRUD de productos propios (independiente de Shopify)
 *
 * GET    /api/products              → listar productos
 * POST   /api/products              → crear producto
 * PUT    /api/products/:id          → actualizar producto
 * DELETE /api/products/:id          → eliminar producto
 * POST   /api/products/import-shopify → importar desde Shopify
 */

const express    = require('express');
const router     = express.Router();
const db         = require('../db/database');
const shopifyApi = require('../services/shopify-api');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ── GET /api/products ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const products = await db.getProducts(req.orgId);
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { title, description, price, comparePrice, sku, stock, imageUrl, active, position } = req.body;
    if (!title || price == null) return res.status(400).json({ error: 'title y price son requeridos' });
    const product = await db.createProduct(req.orgId, { title, description, price, comparePrice, sku, stock, imageUrl, active, position });
    res.status(201).json({ product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/products/:id ──────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { title, description, price, compare_price, comparePrice, sku, stock, image_url, imageUrl, active, position } = req.body;
    const updates = {};
    if (title       !== undefined) updates.title         = title;
    if (description !== undefined) updates.description   = description;
    if (price       !== undefined) updates.price         = price;
    if ((comparePrice ?? compare_price) !== undefined) updates.compare_price = comparePrice ?? compare_price;
    if (sku         !== undefined) updates.sku           = sku;
    if (stock       !== undefined) updates.stock         = stock;
    if ((imageUrl ?? image_url) !== undefined) updates.image_url = imageUrl ?? image_url;
    if (active      !== undefined) updates.active        = active;
    if (position    !== undefined) updates.position      = position;

    const product = await db.updateProduct(req.orgId, parseInt(req.params.id), updates);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/products/:id ───────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await db.deleteProduct(req.orgId, parseInt(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/products/import-shopify ─────────────────────────────
// Copia todos los productos de Shopify a la tabla products propia.
// Los productos existentes (mismo SKU o título) se actualizan.
router.post('/import-shopify', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds?.config?.accessToken) {
      return res.status(400).json({ error: 'No hay conexión con Shopify configurada' });
    }

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const { products: shopifyProducts } = await shopifyApi.getProducts(shop, token, { limit: 250 });

    let imported = 0, updated = 0;
    const existing = await db.getProducts(req.orgId);
    const existingTitles = new Map(existing.map(p => [p.title.toLowerCase(), p]));

    for (const sp of shopifyProducts) {
      const variant = sp.variants?.[0] || {};
      const price   = parseFloat(variant.price || sp.price || 0);
      const title   = sp.title || '';
      const imageUrl = sp.image?.src || sp.images?.[0]?.src || null;
      const description = shopifyApi.stripHtml ? shopifyApi.stripHtml(sp.body_html || '') : (sp.body_html || '');

      const existingProduct = existingTitles.get(title.toLowerCase());
      if (existingProduct) {
        await db.updateProduct(req.orgId, existingProduct.id, {
          price, image_url: imageUrl, description,
          sku: variant.sku || null,
          stock: variant.inventory_quantity ?? -1,
        });
        updated++;
      } else {
        await db.createProduct(req.orgId, {
          title, description, price,
          comparePrice: parseFloat(variant.compare_at_price || 0) || null,
          sku:          variant.sku || null,
          stock:        variant.inventory_quantity ?? -1,
          imageUrl,
          active: sp.status === 'active',
        });
        imported++;
      }
    }

    res.json({ success: true, imported, updated, total: imported + updated });
  } catch (err) {
    console.error('[Products] Error importando desde Shopify:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
