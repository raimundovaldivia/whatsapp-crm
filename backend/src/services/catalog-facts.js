// Confirmed general-product facts must also apply to imported catalog snapshots.
function applyCheeseWeight(product, weight) {
  const name = String(product.title || '');
  if (product.is_business || !/queso\s+de\s+cabra/i.test(name)
    || /pack|promo|combo|\+|manjar|madurado/i.test(name)) return product;
  const title = `Queso de Cabra Fresco Pasteurizado – ${weight}`;
  const description = `Queso fresco elaborado con leche de cabra pasteurizada. Peso por pieza: ${weight}.`;
  const updated = { ...product, title, description };
  if (product.raw_json) {
    try {
      const raw = JSON.parse(product.raw_json);
      updated.raw_json = JSON.stringify({ ...raw, title, description,
        variants: Array.isArray(raw.variants) ? raw.variants.map(variant => ({ ...variant,
          title: String(variant.title || '').replace(/\b(?:800|900)\s*(?:gramos|gr|g)\b/gi, weight),
        })) : raw.variants });
    } catch { /* The catalog reader already falls back to the row columns. */ }
  }
  return updated;
}
module.exports = { applyCheeseWeight };
