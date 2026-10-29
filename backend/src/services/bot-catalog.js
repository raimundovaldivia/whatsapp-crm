// Catálogo compartido por WhatsApp y el simulador. Nunca consulta Shopify en
// vivo ni vuelve a su caché cuando la tienda eligió el catálogo local.
async function loadBotCatalog(db, orgId, { business = false } = {}) {
  const source = await db.getSetting(orgId, 'catalog_source');
  const visible = rows => business ? rows : rows.filter(p => !p.is_business);
  if (source !== 'local') {
    const cached = await db.getCachedProducts(orgId);
    if (cached?.length) return visible(cached).map(p => {
      if (p.raw_json) { try { return typeof p.raw_json === 'string' ? JSON.parse(p.raw_json) : p.raw_json; } catch {} }
      return { id: p.external_id, title: p.title, description: p.description,
        priceMin: Number(p.price) || 0, priceMax: Number(p.price) || 0,
        inventoryQuantity: p.inventory_quantity, sku: p.sku, imageUrl: p.image_url,
        tags: p.tags, productType: p.product_type, handle: p.handle };
    });
  }
  const own = await db.getProducts(orgId, true);
  return visible(own || []).map(p => ({
    id: String(p.id), title: p.title, description: p.description, sku: p.sku,
    priceMin: Number(p.price) || 0, priceMax: Number(p.price) || 0,
    compare_price: p.compare_price ?? null, bulk_price: p.bulk_price ?? null,
    bulk_min_qty: p.bulk_min_qty ?? null, inventoryQuantity: p.stock ?? null,
    imageUrl: p.image_url || null, handle: p.handle || p.title?.toLowerCase().replace(/\s+/g, '-'),
    productType: p.category || '', active: p.active,
  }));
}

module.exports = { loadBotCatalog };
