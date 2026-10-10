const db = require('../db/database');

const STOP_WORDS = new Set([
  'huevo', 'huevos', 'campo', 'tamano', 'bandeja', 'bandejas', 'unidad', 'unidades',
  'gallina', 'fresco', 'frescos', 'fresca', 'frescas', 'pasteurizado', 'producto',
  'productos', 'artesanal', 'artesanales', 'gramos', 'para', 'con', 'los', 'las', 'del',
]);

function norm(value) {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function validImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function mimeType(url) {
  const path = String(url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function explicitProductInterest(message) {
  const text = norm(message);
  if (!text || text.length > 500) return false;
  return /\b(quiero|prefiero|encargo|agrega|anade|dame|llevo|foto|imagen|ver|ese|esa|cafe|cafes|blanco|blancos|mixto|mixtos|jumbo|xl|queso|aceituna)\b/.test(text)
    || /^(?:\d+|opcion\s+\d+)$/i.test(text);
}

function scoreProduct(product, context) {
  const title = norm(product.title);
  const tokens = [...new Set(title.split(' ').filter(token => token.length > 1 && !STOP_WORDS.has(token)))];
  let score = tokens.reduce((total, token) => total + (new RegExp(`\\b${token}\\b`, 'i').test(context) ? 2 : 0), 0);
  for (const marker of ['jumbo', 'xl', 'cafe', 'blanco', 'mixto', 'queso', 'aceituna']) {
    if (new RegExp(`\\b${marker}s?\\b`, 'i').test(title) && new RegExp(`\\b${marker}s?\\b`, 'i').test(context)) score += 5;
  }
  const quantities = title.match(/\b(?:20|30|40|60|90|100|180|500|900)\b/g) || [];
  for (const quantity of quantities) if (new RegExp(`\\b${quantity}\\b`).test(context)) score += 4;
  return score;
}

async function catalog(orgId) {
  const source = await db.getSetting(orgId, 'catalog_source');
  if (source === 'local') {
    const local = await db.getProducts(orgId, true);
    if (local.every(product => validImageUrl(product.image_url || product.imageUrl))) return local;
    // El catálogo local conserva precio y stock como fuente autoritativa, pero
    // puede reutilizar la fotografía correspondiente del caché de Shopify.
    const cached = await db.getCachedProducts(orgId).catch(() => []);
    return local.map(product => {
      if (validImageUrl(product.image_url || product.imageUrl)) return product;
      const ranked = (cached || [])
        .filter(candidate => validImageUrl(candidate.image_url || candidate.imageUrl))
        .map(candidate => ({ candidate, score: scoreProduct(candidate, norm(product.title)) }))
        .sort((a, b) => b.score - a.score);
      return ranked[0]?.score >= 7 ? { ...product, image_url: ranked[0].candidate.image_url || ranked[0].candidate.imageUrl } : product;
    });
  }
  const cached = await db.getCachedProducts(orgId);
  if (cached?.length) return cached;
  return db.getProducts(orgId, true);
}

async function suggest({ orgId, conversationId, userMessage, response }) {
  if (!explicitProductInterest(userMessage)) return null;
  const messages = await db.getLastMessages(conversationId, 10);
  const context = norm([...messages.map(message => message.content), userMessage, response].join(' '));
  const currentSelection = norm(userMessage);
  const products = (await catalog(orgId))
    .map(product => ({ ...product, image: validImageUrl(product.image_url || product.imageUrl) }))
    .filter(product => product.image && Number(product.stock ?? product.inventory_quantity ?? 1) !== 0);
  if (!products.length) return null;

  // Lo que el cliente acaba de escoger pesa más que la lista de opciones del
  // mensaje anterior; así "Cafés" no empata con las variantes blancas/mixtas.
  const ranked = products.map(product => ({
    product,
    score: scoreProduct(product, context) + scoreProduct(product, currentSelection) * 3,
  }))
    .sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score < 7 || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  const chosen = ranked[0].product;
  const alreadySent = messages.some(message => message.type === 'image' && message.media_id === chosen.image);
  if (alreadySent) return null;
  return {
    type: 'image',
    mediaUrl: chosen.image,
    mimeType: mimeType(chosen.image),
    fileName: `producto-${chosen.id || 'catalogo'}.jpg`,
    caption: `📷 ${chosen.title}`,
    productId: chosen.id || chosen.external_id || null,
  };
}

module.exports = { suggest, norm, scoreProduct, explicitProductInterest, validImageUrl };
