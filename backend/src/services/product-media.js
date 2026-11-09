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
  text = text.replace(/^(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches|por favor) )+/, '')
    .replace(/(?: (?:por favor|porfa|porfis|gracias))+$/, '');
  text = text.replace(REQUEST_PREFIX, '');
  if (SHOW_VERB.test(text)) return text.replace(SHOW_VERB, '').replace(PHOTO_NOUN, '');
  text = text.replace(SEND_VERB, '');
  return PHOTO_NOUN.test(text) ? text.replace(PHOTO_NOUN, '') : null;
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

const CHOICE_VERSION = 'product-photo-choice-v1';
const QUESTION = '¿De cuál quieres ver la foto? Responde con el número o el nombre.';
const OPEN_QUESTION = '¿De qué producto quieres ver la foto? Dime el nombre o la variedad.';

function label(product) {
  return product.title.replace(/\s+/g, ' ').trim();
}

function ask(options) {
  const lines = options.map((title, i) => `${i + 1}. ${title}`);
  const menu = [QUESTION, ...lines].join('\n');
  return { response: lines.length && menu.length <= 4000 ? menu : OPEN_QUESTION, promptVersion: CHOICE_VERSION };
}

function pendingOptions(history) {
  const last = history.findLast(message => message.direction === 'outbound');
  if (last?.prompt_version !== CHOICE_VERSION || last.sent_by !== 'ai' || last.status === 'failed') return null;
  if (last.content === OPEN_QUESTION) return [];
  const [question, ...lines] = last.content.split('\n');
  if (question !== QUESTION || !lines.every((line, i) => line.startsWith(`${i + 1}. `))) return null;
  return lines.map(line => line.slice(line.indexOf('. ') + 2));
}

function choiceText(message) {
  return norm(message).replace(/^(?:quiero ver |quiero la foto de |quiero (?=el |la |los |las |opcion )|prefiero |me gustaria )/, '')
    .replace(/(?: (?:por favor|porfa|gracias))+$/, '');
}

function optionNumber(text) {
  const index = text.match(/^(?:(?:la|el) )?(?:(?:opcion|numero|nro) )?(\d+)$/);
  if (index) return Number(index[1]);
  const ordinals = ['primer', 'segund', 'tercer', 'cuart', 'quint', 'sext', 'septim', 'octav', 'noven', 'decim'];
  const ordinal = ordinals.indexOf(text.replace(/^(?:la|el) /, '').replace(/ opcion$/, '').replace(/[ao]$/, ''));
  return ordinal < 0 ? null : ordinal + 1;
}

function matchesTitle(title, words) {
  const tokens = new Set(productWords(title));
  return words.length > 0 && words.every(word => tokens.has(word));
}

async function photoTurn({ orgId, userMessage, history = [], phone }) {
  if (PRICE_QUERY.test(norm(userMessage)) || /\b(no|tampoco)\b/.test(norm(userMessage))) return null;
  const request = requestedProduct(userMessage);
  const pending = pendingOptions(history);
  if (request === null && !pending) return null;
  const selection = choiceText(request ?? userMessage).replace(/^de /, '');
  const number = pending?.length ? optionNumber(selection) : null;
  const words = productWords(request ?? selection);
  let offered = null;
  if (pending?.length && (request === null || number !== null)) {
    if (number !== null) {
      if (!pending[number - 1]) return ask(pending);
      offered = [pending[number - 1]];
    } else {
      offered = pending.filter(title => matchesTitle(title, words));
      if (!offered.length) return /^(?:esa?|ese|si|cual|cuales)$|^(?:el|la|los|las) de\b/.test(selection) ? ask(pending) : null;
    }
  }
  const local = await db.getSetting(orgId, 'catalog_source') === 'local';
  let products = local ? await db.getProducts(orgId, true) : await db.getCachedProducts(orgId);
  if (!local && !products?.length) products = await db.getProducts(orgId, true);
  if (products.some(product => product.is_business)) {
    const contact = phone ? await db.getContact(orgId, phone) : null;
    if (contact?.client_type !== 'empresa') products = products.filter(product => !product.is_business);
  }
  if (!offered && request !== '' && !words.some(word => /^[a-z]+$/.test(word) && !['g', 'kg', 'esa', 'ese', 'este', 'esta'].includes(word))) return null;
  const matches = products.filter(product => offered ? offered.includes(label(product)) : request === '' || matchesTitle(product.title, words));
  if (matches.length > 1) {
    const titles = [...new Set(matches.map(label))];
    if (offered?.length === 1 && titles.length === 1) return { response: 'Hay dos fichas con ese mismo nombre y no puedo distinguir sus fotos.' };
    return ask(titles);
  }
  if (!matches.length) return offered ? { response: 'Esa opción ya no está en el catálogo.' } : null;
  const [chosen] = matches;
  if (Number(chosen.stock ?? chosen.inventory_quantity ?? 1) === 0) return { response: `${label(chosen)} está sin stock.` };
  let image = validImageUrl(chosen.image_url || chosen.imageUrl);
  if (!image && local) {
    const cached = await db.getCachedProducts(orgId).catch(() => []);
    const exact = cached.filter(product => norm(product.title) === norm(chosen.title));
    if (exact.length === 1) image = validImageUrl(exact[0].image_url || exact[0].imageUrl);
  }
  if (!image) return { response: `Por ahora no tengo una foto de ${label(chosen)}.` };
  if (!pending && history.some(message => message.type === 'image' && message.media_id === image)) {
    return { response: `La foto de ${label(chosen)} está más arriba en este chat.` };
  }
  const productMedia = {
    type: 'image', mediaUrl: image, mimeType: mimeType(image),
    fileName: `producto-${chosen.id || 'catalogo'}.jpg`,
    caption: `📷 ${chosen.title}`,
    productId: chosen.id || chosen.external_id || null,
  };
  return { response: `Elegiste ${label(chosen)}.`, productMedia };
}

module.exports = { photoTurn };
