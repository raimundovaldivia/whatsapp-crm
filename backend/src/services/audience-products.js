const { fold } = require('./product-identity');

async function loadAudienceCatalog(db, orgId) {
  if (await db.getSetting(orgId, 'catalog_source') !== 'local') {
    const cached = await db.getCachedProducts(orgId);
    if (cached.length) return cached.map(p => ({ ...p, id: p.external_id, shopify: true }));
  }
  return db.getProducts(orgId);
}

// Prefer stable identifiers. Imported orders can predate the local catalog and
// may only have the SKU or the original title of a discontinued product.
function catalogPurchaseMatcher(catalog, requestedIds) {
  const selected = new Set(requestedIds.map(String));
  const catalogIds = new Set(catalog.map(p => String(p.id)));
  if ([...selected].some(id => !catalogIds.has(id))) return null;

  const wanted = catalog.filter(p => selected.has(String(p.id)) ||
    (p.replacement_product_id != null && selected.has(String(p.replacement_product_id))));
  const idKey = id => String(id ?? '').replace(/^gid:\/\/shopify\/Product\//, '');
  const knownIds = new Set(catalog.map(p => idKey(p.id)));
  const wantedIds = new Set(wanted.map(p => idKey(p.id)));
  const skuKey = sku => String(sku ?? '').trim().toLowerCase();
  const knownSkus = new Set(catalog.map(p => skuKey(p.sku)).filter(Boolean));
  const wantedSkus = new Set(wanted.map(p => skuKey(p.sku)).filter(Boolean));
  const titles = new Set(wanted.map(p => fold(p.title)).filter(Boolean));
  const shopifyCatalog = catalog.some(p => p.shopify);
  return (item, fromShopify) => {
    if (!item || item._deliveryExtra) return false;
    const id = idKey(item.product_id ?? item.productId);
    if ((!fromShopify || shopifyCatalog) && knownIds.has(id)) return wantedIds.has(id);
    const sku = skuKey(item.sku);
    if (knownSkus.has(sku)) return wantedSkus.has(sku);
    const title = item.name || item.title || item.product_name || item.productTitle;
    const variant = item.variantTitle || item.variant_title;
    return titles.has(fold(title)) || (Boolean(variant) && titles.has(fold([title, variant].join(' '))));
  };
}

module.exports = { loadAudienceCatalog, catalogPurchaseMatcher };
