/**
 * raigentic.js — Cliente para la Shopify App (raigentic en Render)
 *
 * El CRM usa este servicio para:
 *  1. Obtener el catálogo de productos (para que el bot sepa qué vende la tienda)
 *  2. Crear pedidos en Shopify cuando el bot cierra una venta
 *
 * La app raigentic es la que tiene el token de Shopify y hace las llamadas reales.
 * El CRM nunca llama a Shopify directamente — todo pasa por raigentic.
 *
 * Variables de entorno requeridas:
 *   RAIGENTIC_URL       = https://raigentic.onrender.com
 *   BOT_API_SECRET      = (mismo valor que BOT_API_SECRET en raigentic)
 */

const axios = require('axios');

const BASE_URL   = process.env.RAIGENTIC_URL   || 'https://raigentic.onrender.com';
const BOT_SECRET = process.env.BOT_API_SECRET  || '';

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 45000,   // 45s para aguantar el cold start de Render (free tier)
  headers: {
    'X-Bot-Secret': BOT_SECRET,
    'Content-Type': 'application/json',
  },
});

/* ─────────────────────────────────────────────
   PRODUCTOS
   El bot los usa para saber qué vende la tienda
───────────────────────────────────────────── */

// Caché en memoria para no llamar raigentic en cada mensaje
const productCache = new Map(); // shop → { data, ts }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Obtiene el catálogo de productos desde raigentic (DB local, rápido).
 * Usa caché de 5 minutos para evitar timeouts en cada mensaje.
 * @param {string} shop - dominio myshopify ej: szc7zd-ip.myshopify.com
 * @param {object} opts - { search, status, limit, offset }
 */
async function getProductos(shop, opts = {}) {
  // Verificar caché (solo para la llamada estándar sin opts extra)
  const cacheKey = shop;
  const cached = productCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS && !opts.search) {
    return cached.data;
  }

  const params = { shop, status: 'active', limit: 200, ...opts };
  const { data } = await client.get('/api/productos', { params });

  // Guardar en caché si hay productos
  if (!opts.search && data?.products) {
    productCache.set(cacheKey, { data, ts: Date.now() });
  }

  return data;
}

/** Invalida el caché de productos (llamar tras sincronización) */
function invalidarCacheProductos(shop) {
  if (shop) productCache.delete(shop);
  else productCache.clear();
}

/**
 * Formatea el catálogo para enviarlo al contexto del agente IA.
 * @param {Array} products
 * @param {string} shop - dominio myshopify para construir links de producto
 * @returns {string} Texto listo para pegar en el prompt del agente
 */
function formatProductosParaIA(products, shop = null) {
  if (!products?.length) return 'No hay productos disponibles en este momento.';

  return products.map(p => {
    // Soporte para camelCase (priceMin) y snake_case (price_min)
    const minPrice = p.priceMin ?? p.price_min ?? 0;
    const maxPrice = p.priceMax ?? p.price_max ?? 0;
    const precio = minPrice === maxPrice
      ? `$${Number(minPrice).toLocaleString('es-CL')}`
      : `$${Number(minPrice).toLocaleString('es-CL')} – $${Number(maxPrice).toLocaleString('es-CL')}`;

    // Link directo al producto en la tienda
    const storeUrl = shop
      ? `https://${shop.replace('myshopify.com', 'myshopify.com')}`
      : null;
    const productLink = storeUrl && p.handle
      ? `  🔗 ${storeUrl}/products/${p.handle}`
      : '';

    // Variantes con precio y stock
    const variantes = p.variants?.length > 0
      ? p.variants.map(v => {
          const stockInfo = v.stock != null ? ` (stock: ${v.stock})` : '';
          const available = v.available === false ? ' ❌ agotado' : '';
          return `  · ${v.title}: $${Number(v.price).toLocaleString('es-CL')}${stockInfo}${available}`;
        }).join('\n')
      : '';

    return [
      `• ${p.title} | ${precio}`,
      p.vendor      ? `  Marca: ${p.vendor}` : '',
      p.productType ? `  Categoría: ${p.productType}` : '',
      p.description ? `  ${p.description.slice(0, 250)}` : '',
      variantes,
      productLink,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

/**
 * Sincroniza todos los productos de Shopify a la DB de raigentic.
 * Llamar solo una vez al conectar la tienda, o manualmente desde ajustes.
 * @param {string} shop
 */
async function sincronizarProductos(shop) {
  const { data } = await client.post('/api/sync', null, {
    headers: { 'X-Shop-Domain': shop },
  });
  return data;
}

/* ─────────────────────────────────────────────
   PEDIDOS
   El bot crea el pedido cuando el cliente acepta
───────────────────────────────────────────── */

/**
 * Crea un Draft Order en Shopify y retorna el link de pago.
 *
 * @param {string} shop - dominio myshopify
 * @param {object} customer - { name, phone, email? }
 * @param {Array}  items    - [{ variantId, quantity, title, price }]
 * @param {string} notes    - mensaje extra (ej: dirección de envío del chat)
 *
 * @returns {{ success, orderId, orderNumber, invoiceUrl, totalPrice }}
 *   invoiceUrl → link de pago para enviar al cliente por WhatsApp
 */
async function crearPedido(shop, customer, items, notes = '') {
  const { data } = await client.post('/api/pedidos', { shop, customer, items, notes });
  return data;
}

/* ─────────────────────────────────────────────
   ÓRDENES DE SHOPIFY
   El frontend las usa para mostrar historial real
───────────────────────────────────────────── */

/**
 * Obtiene órdenes reales de Shopify desde raigentic (una página).
 * @param {string} shop - dominio myshopify
 * @param {object} opts - { limit, cursor, status }
 */
async function getOrdenes(shop, opts = {}) {
  const params = { shop, limit: 50, status: 'any', ...opts };
  const { data } = await client.get('/api/ordenes', { params });
  return data;
}

/**
 * Descarga TODAS las órdenes de Shopify paginando internamente (servidor a servidor).
 * Incluye todas las órdenes sin importar el estado de pago.
 * @param {string} shop
 * @returns {Array} Array completo de todas las órdenes
 */
async function getAllOrdenesPagadas(shop) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let all    = [];
  let cursor = undefined;
  let page   = 0;

  while (true) {
    page++;
    let result;
    // Retry en caso de 503/429
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await getOrdenes(shop, { limit: 100, cursor, status: 'any' });
        break;
      } catch (err) {
        const status = err.response?.status;
        if ((status === 503 || status === 429) && attempt < 3) {
          await sleep(attempt * 1500);
        } else throw err;
      }
    }

    // Excluir solo órdenes canceladas y reembolsadas
    const validas = (result.orders || []).filter(o => {
      const fs = (o.financialStatus || '').toUpperCase();
      return fs !== 'VOIDED' && fs !== 'REFUNDED';
    });
    all = all.concat(validas);

    if (!result.hasNextPage || !result.endCursor) break;
    cursor = result.endCursor;
    await sleep(300);

    if (page >= 50) break;
  }

  return all;
}

/**
 * Obtiene clientes reales de Shopify desde raigentic.
 * @param {string} shop - dominio myshopify
 * @param {object} opts - { limit, cursor, query }
 */
async function getClientes(shop, opts = {}) {
  const params = { shop, limit: 50, ...opts };
  const { data } = await client.get('/api/clientes', { params });
  return data;
}

/* ─────────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────────── */

async function ping() {
  try {
    const { data } = await client.get('/');
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getProductos,
  formatProductosParaIA,
  sincronizarProductos,
  invalidarCacheProductos,
  getOrdenes,
  getAllOrdenesPagadas,
  getClientes,
  crearPedido,
  ping,
};
