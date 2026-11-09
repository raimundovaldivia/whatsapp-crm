const db = require('../db/database');

function norm(value) {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function validImageUrl(value) {
  try {
    const url = String(value || '').startsWith('/store-assets/')
      ? new URL(value, process.env.FRONTEND_URL?.split(',')[0].trim())
      : new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function mimeType(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

const PRICE_QUERY = /\b(precios?|valor(?:es)?|cuant[oa]s?|cuestan?|costos?|valen?|salen?|cotiz\w*|ofertas?|promocion(?:es)?|tarifas?)\b/;
const REQUEST_PREFIX = /^(?:me gustaria |(?:(?:me|nos) )?(?:(?:puedes?|podrias?|puedo|quisiera|quiero) )?)/;
const SEND_VERB = /^(?:(?:(?:manda|envia|pasa)[rs]?|compartir|compartes?)(?:me|nos)?|tienes?|hay)\s+/;
const SHOW_VERB = /^(?:ver|(?:mostrar|muestra)(?:me|nos)?)\s+/;
const PHOTO_NOUN = /^(?:(?:un[ao]s?|l[ao]s?|alguna) )?(?:fotos?|fotitos?|fotografias?|imagen(?:es)?)\b\s*/;

function requestedProduct(message) {
  let text = norm(message);
  if (PRICE_QUERY.test(text) || /\b(no|tampoco)\b/.test(text)) return '';
  text = text.replace(/^(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches|por favor) )+/, '')
    .replace(/(?: (?:por favor|porfa|porfis|gracias))+$/, '');
  text = text.replace(REQUEST_PREFIX, '');
  if (SHOW_VERB.test(text)) return text.replace(SHOW_VERB, '').replace(PHOTO_NOUN, '');
  text = text.replace(SEND_VERB, '');
  return PHOTO_NOUN.test(text) ? text.replace(PHOTO_NOUN, '') : '';
}

const FILLER = new Set(['el', 'la', 'los', 'las', 'del', 'de', 'un', 'una', 'unos', 'unas', 'en', 'color', 'tamano', 'unidad', 'unidades']);
const VARIANTS = new Map(Object.entries({
  huevos: 'huevo', quesos: 'queso', aceitunas: 'aceituna', bandejas: 'bandeja', cajas: 'caja',
  cafes: 'cafe', blancos: 'blanco', blancas: 'blanco', blanca: 'blanco',
  mixtos: 'mixto', mixtas: 'mixto', mixta: 'mixto', jumbos: 'jumbo',
  gramos: 'g', gr: 'g', kilos: 'kg', kilo: 'kg',
}));

function productWords(value) {
  return norm(value).replace(/(\d)(kg|gr|g)\b/g, '$1 $2').split(' ').filter(word => word && !FILLER.has(word))
    .map(word => VARIANTS.get(word) || word);
}

async function suggest({ orgId, conversationId, userMessage }) {
  const words = productWords(requestedProduct(userMessage));
  // Un peso, una cantidad o una referencia como "esa" no identifican un producto.
  if (!words.some(word => /^[a-z]+$/.test(word) && !['g', 'kg', 'esa', 'ese', 'este', 'esta'].includes(word))) return null;

  const local = await db.getSetting(orgId, 'catalog_source') === 'local';
  let products = local ? await db.getProducts(orgId, true) : await db.getCachedProducts(orgId);
  if (!local && !products?.length) products = await db.getProducts(orgId, true);

  // Comprobar la identidad antes de mirar stock o fotos: una variante sin foto
  // también puede hacer ambigua la petición del cliente.
  const matches = products.filter(product => {
    const title = new Set(productWords(product.title));
    return words.every(word => title.has(word));
  });
  if (matches.length !== 1) return null;
  const [chosen] = matches;
  if (Number(chosen.stock ?? chosen.inventory_quantity ?? 1) === 0) return null;
  let image = validImageUrl(chosen.image_url || chosen.imageUrl);
  if (!image && local) {
    const cached = await db.getCachedProducts(orgId).catch(() => []);
    const exact = cached.filter(product => norm(product.title) === norm(chosen.title));
    if (exact.length === 1) image = validImageUrl(exact[0].image_url || exact[0].imageUrl);
  }
  if (!image) return null;
  const messages = await db.getLastMessages(conversationId, 10);
  if (messages.some(message => message.type === 'image' && message.media_id === image)) return null;
  return {
    type: 'image', mediaUrl: image, mimeType: mimeType(image),
    fileName: `producto-${chosen.id || 'catalogo'}.jpg`,
    caption: `📷 ${chosen.title}`,
    productId: chosen.id || chosen.external_id || null,
  };
}

module.exports = { suggest };
