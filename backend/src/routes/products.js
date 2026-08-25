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

    // Traer TODOS los productos con paginación completa
    const shopifyProducts = await shopifyApi.getAllProducts(shop, token);

    let imported = 0, updated = 0;
    const existing = await db.getProducts(req.orgId);
    const existingTitles = new Map(existing.map(p => [p.title.toLowerCase(), p]));

    for (const sp of shopifyProducts) {
      // El objeto ya viene procesado por shopify-api.js (GraphQL)
      const variant     = sp.variants?.[0] || {};
      const price       = parseFloat(variant.price || sp.priceMin || 0);
      const comparePrice = parseFloat(variant.compareAt || 0) || null;
      const title       = sp.title || '';
      const description = sp.description || '';
      const sku         = variant.sku || null;
      const stock       = variant.stock ?? variant.inventoryQuantity ?? -1;
      const active      = sp.status === 'ACTIVE' || sp.status === 'active';

      // imageUrl viene directamente como URL (GraphQL) — no como { src }
      const imageUrl = sp.imageUrl || sp.image || null;

      const existingProduct = existingTitles.get(title.toLowerCase());
      if (existingProduct) {
        await db.updateProduct(req.orgId, existingProduct.id, {
          price, compare_price: comparePrice, image_url: imageUrl,
          description, sku, stock, active,  // también actualiza active e imagen
        });
        updated++;
      } else {
        await db.createProduct(req.orgId, {
          title, description, price, comparePrice, sku, stock, imageUrl, active,
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
