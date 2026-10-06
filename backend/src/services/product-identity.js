'use strict';

// Identidad operacional de producto. Nunca reemplaza el título original del pedido:
// agrega una clave y una etiqueta seguras para agrupar carga, historial y campañas.
function fold(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rawName(item) {
  return String(item?.name || item?.title || item?.product_name || '').trim();
}

function fallbackIdentity(name, item = {}) {
  const normalized = fold(name) || 'sin nombre';
  const stableId = item.variantId || item.variant_id || item.sku || item.productId || item.product_id;
  return {
    product_key: stableId ? `catalog:${String(stableId)}` : `raw:${normalized}`,
    product_label: name || 'Sin nombre',
    product_family: 'other',
    pack_size: null,
    content_units: null,
    normalization_confidence: 'raw',
  };
}

function canonicalizeProductItem(item) {
  const name = rawName(item);
  const text = fold(name);
  const base = fallbackIdentity(name, item);
  if (!text) return { ...item, ...base, raw_name: name };

  // Los packs/combinaciones se mantienen separados: no es seguro inferir cuántas
  // unidades físicas de cada producto contienen.
  if (/\b(combo|pack|promo|promocion|especial|mix|mixto)\b/.test(text) && !/\bcaja\b/.test(text)) {
    return { ...item, ...base, raw_name: name, normalization_confidence: 'protected' };
  }

  if (/\bqueso\b/.test(text) && /\bcabr(?:a|as)\b/.test(text)) {
    const grams = Number(text.match(/\b(\d{3,4})\s*(?:g|gr|gramos?)\b/)?.[1] || 0);
    // En el catálogo histórico de Diez Ríos, 800 g y 900 g son el mismo queso
    // general cuya ficha vigente es 900 g. Otros gramajes permanecen separados.
    const canonicalGrams = grams === 800 || grams === 900 ? 900 : (grams || null);
    const suffix = canonicalGrams ? ` · pieza ${canonicalGrams} g` : '';
    return {
      ...item,
      raw_name: name,
      product_key: `queso_cabra:${canonicalGrams || 'sin_peso'}`,
      product_label: `Queso de cabra${suffix}`,
      product_family: 'cheese_goat',
      pack_size: canonicalGrams,
      pack_unit: canonicalGrams ? 'g' : null,
      content_units: null,
      normalization_confidence: canonicalGrams ? 'high' : 'medium',
    };
  }

  if (/\bhuevos?\b/.test(text)) {
    let size = null;
    if (/\bjumbo\b/.test(text)) size = 'Jumbo';
    else if (/\b(?:tamano\s*)?xl\b/.test(text)) size = 'XL';
    else if (/\b(?:tamano\s*)?l\b/.test(text)) size = 'L';
    else if (/\b(?:tamano\s*)?m\b/.test(text)) size = 'M';

    const candidates = [
      text.match(/\bbandeja\s*(?:de\s*)?(\d{1,3})\b/),
      text.match(/\b(\d{1,3})\s*(?:unidades?|huevos?)\b/),
      text.match(/^\s*(\d{1,3})\s+huevos?\b/),
    ].filter(Boolean);
    const pack = Number(candidates[0]?.[1] || 0) || null;
    const family = size ? `Huevos ${size}` : 'Huevos';
    return {
      ...item,
      raw_name: name,
      product_key: `huevos:${(size || 'sin_calibre').toLowerCase()}:${pack || 'sin_formato'}`,
      product_label: `${family}${pack ? ` · ${pack} unidades` : ''}`,
      product_family: 'eggs',
      product_variant: size,
      pack_size: pack,
      pack_unit: pack ? 'huevos' : null,
      content_units: pack,
      normalization_confidence: size && pack ? 'high' : 'medium',
    };
  }

  return { ...item, ...base, raw_name: name };
}

function productMatchesQuery(item, query) {
  const identity = canonicalizeProductItem(item);
  const wanted = fold(query);
  if (!wanted) return false;
  return [rawName(item), identity.product_label, identity.product_key]
    .some(value => fold(value).includes(wanted));
}

module.exports = { fold, rawName, canonicalizeProductItem, productMatchesQuery };
