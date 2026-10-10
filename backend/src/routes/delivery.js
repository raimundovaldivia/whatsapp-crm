/**
 * delivery.js — API de repartos
 *
 * ADMIN (desde el panel web):
 *   GET  /api/delivery/orders           → Pedidos pendientes de despachar para seleccionar
 *   POST /api/delivery/optimize         → Optimiza una lista de pedidos con Google Maps
 *   GET  /api/delivery/routes           → Lista de rutas creadas (historial)
 *   POST /api/delivery/routes           → Crea y guarda una ruta (con pedidos + ruta optimizada)
 *   PATCH /api/delivery/routes/:id      → Actualiza ruta (enviar, cancelar, cambiar datos)
 *   DELETE /api/delivery/routes/:id     → Elimina ruta en borrador
 *
 *   GET  /api/delivery/drivers          → Usuarios con rol 'repartidor' (selector al asignar)
 *
 * REPARTIDOR (desde la app mobile — rol 'repartidor', ver middleware/auth.js):
 *   GET  /api/delivery/routes/active    → Sus rutas activas (sent o in_progress)
 *   GET  /api/delivery/routes/:id       → Detalle de una ruta (refresco de paradas)
 *   PATCH /api/delivery/routes/:id/stops → Marcar parada. Body: { stopKey, status, paymentMethod? }
 *        paymentMethod ('efectivo'|'transferencia'|'otro') se guarda en el pedido
 *        al entregar y alimenta el tab "Por cobrar".
 *
 * Asignación: una ruta tiene driver_user_id (usuario repartidor). El chofer ve
 * las rutas asignadas a él y las que quedaron sin asignar.
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const db          = require('../db/database');
const { getPool } = require('../db/database');
const collection  = require('../services/payment-collection');
const { paymentBreakdown } = require('../utils/payment-breakdown');
const deliveryNotifications = require('../services/delivery-notifications');
const whatsappProvider = require('../services/whatsapp-provider');
const outboundMedia = require('../services/outbound-media');
const push = require('../services/push');
const productIdentity = require('../services/product-identity');
const canonicalizeProductItem = typeof productIdentity.canonicalizeProductItem === 'function'
  ? productIdentity.canonicalizeProductItem
  : item => item;
const { attachAttemptHistory } = require('../services/delivery-attempts');
const { requireAuth, requireRole } = require('../middleware/auth');

// Un pedido importado sin decisión logística local no vuelve a reparto si
// Shopify ya lo completó/anuló o pertenece al historial ampliado sin gestión
// local. FULFILLED no acredita entrega al cliente:
// esto filtra elegibilidad, sin reescribir crm_status ni delivered_at.
// Los reintentos/reprogramaciones explícitos del CRM siguen siendo válidos.
const importedShopifyClosed = `(COALESCE(crm_status, 'nuevo') IN ('', 'nuevo') AND (
  UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED'
  OR UPPER(COALESCE(financial_status, '')) IN ('VOIDED', 'REFUNDED')
  OR NULLIF(raw_json->>'cancelledAt', '') IS NOT NULL
  OR (
    COALESCE(shopify_created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '60 days', FALSE)
    AND delivery_date IS NULL
    AND COALESCE(dispatch_count, 0) = 0
    AND last_attempt_at IS NULL
    AND last_attempt_status IS NULL
    AND NULLIF(delivery_note, '') IS NULL
  )
))`;

// La bandeja de reparto no es un espejo del historial de Shopify. Las órdenes
// importadas requieren una decisión logística local; los pedidos creados por
// el bot sí entran mientras estén activos, porque representan la cola operativa
// real. Los reintentos permanecen visibles hasta completar la entrega.
const chileTodaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date`;
const shopifyDispatchReady = `(
  COALESCE(crm_status, '') IN ('por_despachar', 'no_entregado')
  OR (delivery_date IS NOT NULL AND delivery_date <= ${chileTodaySql})
  OR COALESCE(dispatch_count, 0) > 0
  OR last_attempt_at IS NOT NULL
  OR last_attempt_status IS NOT NULL
)`;
const botDispatchReady = `(
  COALESCE(status, '') IN ('draft', 'sent', 'nuevo', 'por_despachar', 'payment_received', 'no_entregado')
  OR (delivery_date IS NOT NULL AND delivery_date <= ${chileTodaySql})
  OR COALESCE(dispatch_count, 0) > 0
  OR last_attempt_at IS NOT NULL
  OR last_attempt_status IS NOT NULL
)`;

let io;
function setSocketIO(socketIO) { io = socketIO; }

router.use(requireAuth);
router.use('/returns', require('./order-returns'));
const { routeItems } = require('../services/delivery-items');
router.get('/routes/:id/order-items', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), routeItems);
router.patch('/routes/:id/order-items', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), routeItems);

function notifyAssignedDriver(orgId, route, message = null) {
  if (!route?.driver_user_id || !push.pushUser) return;
  try {
    let orders = route.orders || [];
    if (typeof orders === 'string') {
      try { orders = JSON.parse(orders); } catch { orders = []; }
    }
    const retryCount = orders.filter(isRetryDelivery).length;
    const pending = push.pushUser(orgId, route.driver_user_id, {
      title: '🚚 Nueva ruta asignada',
      body: message || `${route.name || 'Tienes una nueva ruta'} · ${orders.length} paradas${retryCount ? ` · ⚠️ ${retryCount} reintento${retryCount === 1 ? '' : 's'} prioritario${retryCount === 1 ? '' : 's'}` : ''}`,
      data: { kind: 'delivery_route', routeId: String(route.id), routeName: route.name || 'Ruta' },
    });
    pending?.catch?.(() => {});
  } catch {}
}

function routeStops(route) {
  const optimized = Array.isArray(route?.optimized_route)
    ? route.optimized_route
    : JSON.parse(route?.optimized_route || '[]');
  if (optimized.length) return optimized;
  return Array.isArray(route?.orders) ? route.orders : JSON.parse(route?.orders || '[]');
}

function jsonList(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

/**
 * Rutas antiguas (y algunos resultados de optimización) pueden conservar la
 * parada pero no su copia de `items`. La consolidación no debe quedar vacía:
 * recupera los productos desde el pedido original y los incorpora en memoria
 * tanto a `orders` como a `optimized_route`.
 */
async function hydrateRouteItems(pool, route, orgId) {
  if (!route) return route;
  const orders = jsonList(route.orders);
  const optimized = jsonList(route.optimized_route);
  const itemMap = new Map();

  for (const order of orders) {
    if (Array.isArray(order?.items) && order.items.length) itemMap.set(orderKey(order), order.items);
  }

  const all = [...orders, ...optimized];
  const botIds = [...new Set(all.filter(item => item?.source === 'bot').map(item => Number(item.id)).filter(Number.isFinite))];
  const shopifyIds = [...new Set(all.filter(item => item?.source === 'shopify').map(item => String(item.id)).filter(Boolean))];
  const [botResult, shopifyResult] = await Promise.all([
    botIds.length
      ? pool.query('SELECT id::text AS id, items FROM orders WHERE organization_id = $1 AND id = ANY($2::int[])', [orgId, botIds])
      : { rows: [] },
    shopifyIds.length
      ? pool.query('SELECT shopify_order_id AS id, items FROM shopify_orders WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])', [orgId, shopifyIds])
      : { rows: [] },
  ]);

  for (const row of botResult.rows) {
    const items = jsonList(row.items);
    if (items.length && !itemMap.has(`bot_${row.id}`)) itemMap.set(`bot_${row.id}`, items);
  }
  for (const row of shopifyResult.rows) {
    const items = jsonList(row.items);
    if (items.length && !itemMap.has(`shopify_${row.id}`)) itemMap.set(`shopify_${row.id}`, items);
  }

  const addItems = stop => {
    if (Array.isArray(stop?.items) && stop.items.length) return stop;
    const items = itemMap.get(orderKey(stop));
    return items?.length ? { ...stop, items } : stop;
  };
  return {
    ...route,
    orders: orders.map(addItems),
    optimized_route: optimized.map(addItems),
  };
}

function buildLoadManifest(route) {
  const totals = new Map();
  for (const stop of routeStops(route)) {
    const status = (route.stop_statuses || {})[orderKey(stop)] || 'pending';
    if (status !== 'pending') continue;
    for (const item of (stop.items || [])) {
      if (item?.loadItem === false) continue;
      const name = String(item.name || item.title || item.product_name || '').trim();
      const quantity = Number(item.quantity) || 0;
      if (!name || quantity <= 0) continue;
      totals.set(name, (totals.get(name) || 0) + quantity);
    }
  }
  return [...totals.entries()].map(([name, quantity]) => ({ name, quantity }));
}

async function markOrdersEnRoute(client, orgId, orders) {
  const list = Array.isArray(orders) ? orders : JSON.parse(orders || '[]');
  const shopifyIds = list.filter(o => o.source === 'shopify').map(o => o.id);
  const botIds = list.filter(o => o.source === 'bot').map(o => parseInt(o.id)).filter(Number.isFinite);
  const returnIds = list.filter(o => o.source === 'return').map(o => parseInt(o.id)).filter(Number.isFinite);
  await Promise.all([
    shopifyIds.length && client.query(
      `UPDATE shopify_orders SET crm_status = 'en_camino',
              dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
         WHERE organization_id = $1 AND shopify_order_id = ANY($2)
           AND delivered_at IS NULL AND COALESCE(crm_status, '') NOT IN ('en_camino', 'entregado', 'cancelled')`,
      [orgId, shopifyIds]
    ),
    botIds.length && client.query(
      `UPDATE orders SET status = 'en_camino', updated_at = NOW(),
              dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
         WHERE organization_id = $1 AND id = ANY($2)
           AND delivered_at IS NULL AND status NOT IN ('en_camino', 'entregado', 'paid', 'cancelled')`,
      [orgId, botIds]
    ),
    returnIds.length && client.query(
      `UPDATE order_returns SET status = 'in_progress', updated_at = NOW()
         WHERE organization_id = $1 AND id = ANY($2::int[])
           AND status = 'scheduled'`,
      [orgId, returnIds]
    ),
  ].filter(Boolean));
}

/**
 * Reserva pedidos al enviar una ruta. El estado intermedio evita que vuelvan
 * a aparecer en el selector mientras el chofer consolida la carga.
 * Si otra solicitud alcanzó a reservar uno, se aborta para evitar duplicados.
 */
async function reserveOrdersForRoute(client, orgId, orders, routeId = null, driverUserId = null) {
  const list = dedupeOrders(Array.isArray(orders) ? orders : JSON.parse(orders || '[]'));
  const shopifyIds = list.filter(o => o.source === 'shopify').map(o => String(o.id));
  const botIds = list.filter(o => o.source === 'bot').map(o => parseInt(o.id)).filter(Number.isFinite);
  const returnIds = list.filter(o => o.source === 'return').map(o => parseInt(o.id)).filter(Number.isFinite);
  const [shopifyResult, botResult, returnResult] = await Promise.all([
    shopifyIds.length ? client.query(
      `UPDATE shopify_orders SET crm_status = 'asignado_ruta'
         WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])
           AND delivered_at IS NULL
           AND COALESCE(crm_status, '') NOT IN ('asignado_ruta','en_camino','entregado','cancelled')
           AND NOT ${importedShopifyClosed}
           AND ${shopifyDispatchReady}
       RETURNING shopify_order_id`,
      [orgId, shopifyIds]
    ) : null,
    botIds.length ? client.query(
      `UPDATE orders SET status = 'asignado_ruta', updated_at = NOW()
         WHERE organization_id = $1 AND id = ANY($2::int[])
           AND delivered_at IS NULL
           AND status NOT IN ('asignado_ruta','en_camino','entregado','paid','cancelled')
           AND ${botDispatchReady}
       RETURNING id`,
      [orgId, botIds]
    ) : null,
    returnIds.length ? client.query(
      `UPDATE order_returns
          SET route_id = $3,
              driver_user_id = COALESCE($4::int, driver_user_id),
              scheduled_date = COALESCE(scheduled_date, ${chileTodaySql}),
              status = 'scheduled', updated_at = NOW()
        WHERE organization_id = $1 AND id = ANY($2::int[])
          AND route_id IS NULL AND status IN ('approved','scheduled')
          AND (scheduled_date IS NULL OR scheduled_date <= ${chileTodaySql})
      RETURNING id`,
      [orgId, returnIds, routeId, driverUserId]
    ) : null,
  ]);
  const reserved = (shopifyResult?.rowCount || 0) + (botResult?.rowCount || 0) + (returnResult?.rowCount || 0);
  if (reserved !== shopifyIds.length + botIds.length + returnIds.length) {
    throw Object.assign(new Error('Uno o más pedidos o devoluciones ya están asignados a otra ruta. Actualiza la lista e intenta nuevamente.'), { status: 409 });
  }
}

/** Libera pedidos de una ruta cancelada para que vuelvan al selector. */
async function releaseOrdersFromRoute(client, orgId, orders) {
  const list = dedupeOrders(Array.isArray(orders) ? orders : JSON.parse(orders || '[]'));
  const shopifyIds = list.filter(o => o.source === 'shopify').map(o => String(o.id));
  const botIds = list.filter(o => o.source === 'bot').map(o => parseInt(o.id)).filter(Number.isFinite);
  const returnIds = list.filter(o => o.source === 'return').map(o => parseInt(o.id)).filter(Number.isFinite);
  const results = await Promise.all([
    shopifyIds.length && client.query(
      `UPDATE shopify_orders SET crm_status = 'por_despachar'
         WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])
           AND crm_status IN ('asignado_ruta','en_camino') AND delivered_at IS NULL
       RETURNING shopify_order_id`,
      [orgId, shopifyIds]
    ),
    botIds.length && client.query(
      `UPDATE orders SET status = 'por_despachar', updated_at = NOW()
         WHERE organization_id = $1 AND id = ANY($2::int[])
           AND status IN ('asignado_ruta','en_camino') AND delivered_at IS NULL
       RETURNING id`,
      [orgId, botIds]
    ),
    returnIds.length && client.query(
      `UPDATE order_returns
          SET route_id = NULL,
              status = CASE WHEN status = 'in_progress' THEN 'scheduled' ELSE status END,
              updated_at = NOW()
        WHERE organization_id = $1 AND id = ANY($2::int[])
          AND route_id IS NOT NULL AND status IN ('scheduled','in_progress')
      RETURNING id`,
      [orgId, returnIds]
    ),
  ].filter(Boolean));
  return results.reduce((total, result) => total + (result?.rowCount || 0), 0);
}

// ─── Geocodificación (dirección → lat/lng) ───────────────────────────────────
// Convierte direcciones en coordenadas para pintar el mapa. Usa la misma
// GOOGLE_MAPS_API_KEY que la optimización (Geocoding API) y cachea el resultado
// en geocode_cache para no pagar la misma dirección dos veces.

function addressKey(addr) {
  return (addr || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
}

function validGeoPoint(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return point?.lat !== null && point?.lat !== '' && point?.lng !== null && point?.lng !== ''
    && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

async function geocodeMany(orgId, addresses) {
  const pool   = getPool();
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const unique = [...new Set(addresses.map(addressKey).filter(Boolean))];
  const result = {}; // addressKey → { lat, lng } | null

  if (unique.length === 0) return result;

  // 1. Lo que ya está en caché
  const { rows: cached } = await pool.query(
    `SELECT address_key, lat, lng, found FROM geocode_cache
      WHERE organization_id = $1 AND address_key = ANY($2)`,
    [orgId, unique]
  );
  const cachedKeys = new Set();
  for (const r of cached) {
    cachedKeys.add(r.address_key);
    result[r.address_key] = r.found && r.lat != null ? { lat: r.lat, lng: r.lng } : null;
  }

  // 2. Lo que falta, geocodificar (si hay API key)
  const pending = unique.filter(k => !cachedKeys.has(k));
  if (pending.length === 0 || !apiKey) return result;

  // Concurrencia limitada para no disparar 50 llamadas de golpe
  const CHUNK = 5;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    await Promise.all(slice.map(async (key) => {
      try {
        const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: { address: key, key: apiKey, region: 'cl', language: 'es' },
          timeout: 8000,
        });
        const loc = data?.results?.[0]?.geometry?.location;
        if (loc && data.status === 'OK') {
          result[key] = { lat: loc.lat, lng: loc.lng };
          await pool.query(
            `INSERT INTO geocode_cache (organization_id, address_key, lat, lng, found)
             VALUES ($1, $2, $3, $4, TRUE)
             ON CONFLICT (organization_id, address_key)
             DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, found = TRUE, created_at = NOW()`,
            [orgId, key, loc.lat, loc.lng]
          );
        } else {
          result[key] = null;
          // Cachear el "no encontrado" para no reintentar en cada carga
          await pool.query(
            `INSERT INTO geocode_cache (organization_id, address_key, found)
             VALUES ($1, $2, FALSE)
             ON CONFLICT (organization_id, address_key)
             DO UPDATE SET found = FALSE, created_at = NOW()`,
            [orgId, key]
          );
        }
      } catch (err) {
        result[key] = null; // no cachear errores de red: se reintenta luego
        console.warn(`[Geocode] "${key.slice(0, 40)}" falló:`, err.message);
      }
    }));
  }

  return result;
}

/** Agrega lat/lng a cada pedido según su fullAddress. Muta y devuelve la lista. */
async function attachCoords(orgId, orders) {
  const geo = await geocodeMany(orgId, orders.map(o => o.fullAddress));
  for (const o of orders) {
    const c = geo[addressKey(o.fullAddress)];
    o.lat = c?.lat ?? null;
    o.lng = c?.lng ?? null;
  }
  return orders;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// pg entrega DATE como Date (medianoche local del servidor); devolver YYYY-MM-DD sin corrimientos
function dateOnly(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

function orderKey(order) {
  if (!order || !order.source || order.id == null) return null;
  return `${order.source}_${String(order.id)}`;
}

/** Conserva una sola aparición de cada pedido, respetando el primer orden. */
function dedupeOrders(orders) {
  const seen = new Set();
  return (Array.isArray(orders) ? orders : []).filter(order => {
    const key = orderKey(order);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Un pedido pendiente con intentos anteriores debe atenderse antes que uno
 * nuevo. `dispatch_count` aumenta al iniciar una ruta, por lo que al volver a
 * la bandeja identifica de forma confiable una entrega pendiente de reintento.
 */
function isRetryDelivery(order) {
  const attempts = Number(order?.dispatchCount ?? order?.dispatch_count ?? 0) || 0;
  const previousStatus = String(order?.lastAttemptStatus ?? order?.last_attempt_status ?? '').toLowerCase();
  return attempts > 0 || ['no_entregado', 'sin_resolver', 'reprogramado'].includes(previousStatus);
}

function retryReason(order) {
  if (order?.priorityReason) return order.priorityReason;
  if (order?.deliveryNote || order?.delivery_note) return order.deliveryNote || order.delivery_note;
  const status = String(order?.lastAttemptStatus ?? order?.last_attempt_status ?? '').toLowerCase();
  if (status === 'reprogramado') return 'Entrega reprogramada por el cliente';
  if (status === 'sin_resolver') return 'La ruta anterior terminó sin registrar la entrega';
  if (status === 'no_entregado') return 'No se pudo completar la entrega anterior';
  return 'Pedido pendiente de una ruta anterior';
}

function decorateDeliveryPriority(order) {
  const retry = isRetryDelivery(order);
  const attempts = Number(order?.dispatchCount ?? order?.dispatch_count ?? 0) || 0;
  return {
    ...order,
    dispatchCount: attempts,
    isRetry: retry,
    deliveryPriority: retry ? 'retry' : 'normal',
    priorityLabel: retry ? 'PRIORIDAD · REINTENTO DE ENTREGA' : null,
    priorityReason: retry ? retryReason(order) : null,
    previousAttempts: retry ? attempts : 0,
  };
}

/** Partición estable: conserva el orden relativo, pero pone reintentos primero. */
function prioritizeOrders(orders) {
  const decorated = dedupeOrders(orders).map(decorateDeliveryPriority);
  return [
    ...decorated.filter(isRetryDelivery),
    ...decorated.filter(order => !isRetryDelivery(order)),
  ];
}

function normalizeShopifyOrder(row) {
  // shipping_address viene de raw_json JSONB (puede ser objeto o null)
  let addr = {};
  try {
    const raw = row.shipping_address;
    addr = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(raw) : {});
  } catch (_) {}
  const street = addr.address1 || addr.address || '';
  const city   = addr.city || row.shipping_city || '';
  let items = [];
  try { items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []); } catch (_) {}
  items = items.map(canonicalizeProductItem);
  return {
    id: row.id, source: 'shopify',
    orderName: row.order_name || `#${row.id}`,      // shopify_name aliaseado como order_name
    customerName: row.customer_name || 'Sin nombre',
    phone: row.phone || addr.phone || '',             // customer_phone aliaseado como phone
    address: street, city, fullAddress: [street, city].filter(Boolean).join(', '),
    items, totalPrice: parseFloat(row.total_price) || 0, status: row.crm_status,
    deliveryDate: dateOnly(row.delivery_date),
    deliveryNote: row.delivery_note || null,
    dispatchCount: parseInt(row.dispatch_count) || 0,
    lastAttemptStatus: row.last_attempt_status || null,
  };
}

function normalizeBotOrder(row) {
  let addr = {};
  try { addr = typeof row.shipping_address === 'string' ? JSON.parse(row.shipping_address) : (row.shipping_address || {}); } catch (_) {}
  // Fallback 1: contacts table (local DB)
  // Fallback 2: shopify_orders shipping address (más completo)
  let shopifyAddr = {};
  try { shopifyAddr = typeof row.shopify_shipping === 'string' ? JSON.parse(row.shopify_shipping) : (row.shopify_shipping || {}); } catch (_) {}

  const street = addr.address || addr.address1
    || row.contact_address
    || shopifyAddr.address1 || shopifyAddr.address
    || '';
  const city = addr.city
    || row.contact_city
    || row.shopify_city
    || shopifyAddr.city
    || '';
  const isGeneric = n => !n || ['cliente', 'sin nombre', 'cliente sin nombre'].includes(n.trim().toLowerCase());
  const customerName = isGeneric(row.customer_name)
    ? (row.contact_name || row.customer_name || 'Sin nombre')
    : row.customer_name;
  let items = [];
  try { items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []); } catch (_) {}
  items = items.map(canonicalizeProductItem);
  return {
    id: String(row.id), source: 'bot',
    orderName: `#BOT-${row.id}`,
    customerName,
    phone: row.phone || '',
    address: street, city, fullAddress: [street, city].filter(Boolean).join(', '),
    items, totalPrice: parseFloat(row.total_price) || 0, status: row.crm_status,
    deliveryDate: dateOnly(row.delivery_date),
    deliveryNote: row.delivery_note || null,
    dispatchCount: parseInt(row.dispatch_count) || 0,
    lastAttemptStatus: row.last_attempt_status || null,
  };
}

function normalizeReturnTask(row) {
  const customer = row.customer && typeof row.customer === 'object' ? row.customer : {};
  const rawAddress = customer.address;
  const fullAddress = typeof rawAddress === 'string'
    ? rawAddress
    : Object.values(rawAddress || {}).filter(value => typeof value === 'string' && value.trim()).join(', ');
  const affected = jsonList(row.items).map(item => ({
    ...item,
    name: `Retirar: ${item.name || item.title || 'Producto'}`,
    title: `Retirar: ${item.name || item.title || 'Producto'}`,
    price: 0,
    loadItem: false,
  }));
  const routeItems = [...affected];
  if (row.replacement_description) routeItems.push({
    name: `Entregar: ${row.replacement_description}`,
    title: `Entregar: ${row.replacement_description}`,
    quantity: 1,
    price: 0,
    loadItem: true,
  });
  if (row.money_direction !== 'none' && Number(row.money_amount) > 0) routeItems.push({
    name: `${row.money_direction === 'refund' ? 'Devolver' : 'Cobrar'} $${Number(row.money_amount).toLocaleString('es-CL')} · ${row.money_method}`,
    title: `${row.money_direction === 'refund' ? 'Devolver' : 'Cobrar'} $${Number(row.money_amount).toLocaleString('es-CL')} · ${row.money_method}`,
    quantity: 1,
    price: 0,
    loadItem: false,
  });
  const kindLabel = row.kind === 'exchange' ? 'CAMBIO' : row.kind === 'issue' ? 'PROBLEMA' : 'DEVOLUCIÓN';
  return {
    id: String(row.id), source: 'return', isReturn: true,
    orderName: `↩ ${kindLabel} #${row.id} · Pedido ${row.order_id}`,
    customerName: `↩ ${kindLabel} · ${customer.name || 'Cliente'}`,
    phone: customer.phone || '', address: fullAddress, city: '', fullAddress,
    items: routeItems, totalPrice: 0, status: row.status,
    deliveryDate: dateOnly(row.scheduled_date), deliveryNote: row.reason || null,
    returnTask: {
      kind: row.kind,
      reason: row.reason,
      pickupRequired: row.pickup_required,
      replacementDescription: row.replacement_description,
      moneyDirection: row.money_direction,
      moneyMethod: row.money_method,
      moneyAmount: Number(row.money_amount) || 0,
    },
  };
}

// ─── ADMIN: Pedidos pendientes para seleccionar ──────────────────────────────

router.get('/orders', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const pool = getPool();
  try {
    const [shopifyRes, botRes, returnRes] = await Promise.all([
      pool.query(`
        SELECT shopify_order_id      AS id,
               shopify_name          AS order_name,
               customer_name,
               customer_phone        AS phone,
               shipping_city,
               raw_json->'shippingAddress'   AS shipping_address,
               items,
               total_price,
               crm_status,
               delivery_date,
               delivery_note,
               dispatch_count,
               last_attempt_status
        FROM shopify_orders
        WHERE organization_id = $1
          AND (crm_status IS NULL OR crm_status NOT IN ('asignado_ruta', 'en_camino', 'entregado', 'cancelled'))
          AND (delivery_date IS NULL OR delivery_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date)
          AND delivered_at IS NULL   -- ya se repartió: no vuelve a la lista
          AND NOT ${importedShopifyClosed}
          AND ${shopifyDispatchReady}
        ORDER BY synced_at ASC
      `, [req.orgId]),
      pool.query(`
        SELECT o.id,
               o.customer_name,
               o.shipping_address,
               o.customer_phone        AS phone,
               o.items,
               o.total_price,
               o.status                AS crm_status,
               o.delivery_date,
               o.delivery_note,
               o.dispatch_count,
               o.last_attempt_status,
               ct.name                 AS contact_name,
               ct.address              AS contact_address,
               ct.city                 AS contact_city,
               so.raw_json->'shippingAddress'  AS shopify_shipping,
               so.shipping_city                AS shopify_city
        FROM orders o
        LEFT JOIN LATERAL (
          SELECT name, address, city
          FROM contacts
          WHERE organization_id = o.organization_id
            AND phone = ANY(ARRAY[
                  o.customer_phone,
                  CASE WHEN o.customer_phone ~ '^569' THEN SUBSTRING(o.customer_phone FROM 3) END,
                  CASE WHEN o.customer_phone ~ '^9'   THEN '56' || o.customer_phone END,
                  CASE WHEN o.customer_phone ~ '^569' THEN '+' || o.customer_phone END
                ])
          ORDER BY CASE WHEN phone = o.customer_phone THEN 0 ELSE 1 END,
                   updated_at DESC NULLS LAST,
                   id DESC
          LIMIT 1
        ) ct ON true
        LEFT JOIN LATERAL (
          SELECT raw_json, shipping_city
          FROM shopify_orders
          WHERE organization_id = o.organization_id
            AND customer_phone = ANY(ARRAY[
                  o.customer_phone,
                  CASE WHEN o.customer_phone ~ '^569' THEN SUBSTRING(o.customer_phone FROM 3) END,
                  CASE WHEN o.customer_phone ~ '^9'   THEN '56' || o.customer_phone END,
                  CASE WHEN o.customer_phone ~ '^569' THEN '+' || o.customer_phone END
                ])
          ORDER BY shopify_created_at DESC
          LIMIT 1
        ) so ON true
        WHERE o.organization_id = $1
          AND (o.status IS NULL OR o.status NOT IN ('asignado_ruta', 'en_camino', 'entregado', 'cancelled'))
          AND (
            o.delivery_date IS NULL
            OR o.delivery_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date
            OR o.status = 'no_entregado'
          )
          AND o.delivered_at IS NULL   -- ya se repartió (aunque quede en 'paid'): no vuelve a la lista
          AND ${botDispatchReady}
        ORDER BY o.created_at ASC
      `, [req.orgId]),
      pool.query(`
        SELECT id, order_id, kind, status, items, customer, reason,
               replacement_description, pickup_required, money_direction,
               money_method, money_amount, scheduled_date
          FROM order_returns
         WHERE organization_id = $1
           AND route_id IS NULL
           AND status IN ('approved','scheduled')
           AND (scheduled_date IS NULL OR scheduled_date <= ${chileTodaySql})
         ORDER BY scheduled_date NULLS FIRST, created_at ASC
      `, [req.orgId]),
    ]);
    const shopifyOrders = shopifyRes.rows.map(normalizeShopifyOrder);
    const botOrders     = botRes.rows.map(normalizeBotOrder);
    const returnTasks   = returnRes.rows.map(normalizeReturnTask);
    const orders        = prioritizeOrders([...returnTasks, ...shopifyOrders, ...botOrders]);

    // Geocodificar direcciones para el mapa del panel (cacheado).
    // Si no hay GOOGLE_MAPS_API_KEY, cada pedido queda con lat/lng en null y el
    // frontend muestra el aviso correspondiente en vez del mapa.
    await attachCoords(req.orgId, orders).catch(err =>
      console.warn('[Delivery/orders] geocode falló:', err.message));

    // Debug temporal: qué encontró para los pedidos bot sin dirección
    const botDebug = botRes.rows.map(r => ({
      id: r.id, phone: r.phone, hasShipping: !!r.shipping_address,
      contactAddr: r.contact_address, contactCity: r.contact_city,
      shopifyCity: r.shopify_city, hasShopifyShipping: !!r.shopify_shipping,
    }));
    console.log('[Delivery] Bot orders debug:', JSON.stringify(botDebug));

    res.json({
      success: true,
      orders,
      total: orders.length,
      _debug: { shopify: shopifyOrders.length, bot: botOrders.length, returns: returnTasks.length, botDetail: botDebug },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Multi-vehículo: agrupar paradas por cercanía (k-means balanceado) ────────
//
// Divide las paradas en `k` grupos geográficos para repartir entre k vehículos.
// k-means clásico sobre lat/lng, con un paso de balanceo para que ningún
// vehículo quede muy cargado y otro casi vacío. Determinista (misma entrada →
// mismo resultado) para que "Optimizar" no dé grupos distintos cada vez.

function kmeansBalanced(points, k) {
  const n = points.length;
  if (k <= 1 || n <= k) {
    // Un grupo por punto, o todo en uno
    if (k <= 1) return [points.map((_, i) => i)];
    return points.map((_, i) => [i]);
  }

  const dist2 = (a, b) => (a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2;

  // Inicialización determinista tipo k-means++ (semilla fija: el punto más al
  // noroeste), eligiendo luego los más lejanos entre sí.
  const seeds = [];
  let first = 0;
  for (let i = 1; i < n; i++) {
    if (points[i].lat > points[first].lat || (points[i].lat === points[first].lat && points[i].lng < points[first].lng)) first = i;
  }
  seeds.push(first);
  while (seeds.length < k) {
    let best = -1, bestD = -1;
    for (let i = 0; i < n; i++) {
      if (seeds.includes(i)) continue;
      const d = Math.min(...seeds.map(s => dist2(points[i], points[s])));
      if (d > bestD) { bestD = d; best = i; }
    }
    seeds.push(best);
  }
  let centers = seeds.map(i => ({ lat: points[i].lat, lng: points[i].lng }));

  // Cada centro recibe una capacidad exacta. Esto evita grupos vacíos cuando
  // varias direcciones tienen las mismas coordenadas y garantiza que cada
  // punto quede asignado exactamente una vez.
  const targetSizes = Array.from({ length: k }, (_, index) =>
    Math.floor(n / k) + (index < (n % k) ? 1 : 0));
  let groups = Array.from({ length: k }, () => []);
  for (let iter = 0; iter < 20; iter++) {
    groups = Array.from({ length: k }, () => []);
    const assigned = new Set();
    const pairs = [];
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) {
      pairs.push({ i, c, distance: dist2(points[i], centers[c]) });
    }
    pairs.sort((a, b) => a.distance - b.distance || a.i - b.i || a.c - b.c);
    for (const pair of pairs) {
      if (assigned.has(pair.i) || groups[pair.c].length >= targetSizes[pair.c]) continue;
      groups[pair.c].push(pair.i);
      assigned.add(pair.i);
    }
    // Recalcular centros
    for (let c = 0; c < k; c++) {
      const group = groups[c];
      centers[c] = {
        lat: group.reduce((sum, index) => sum + points[index].lat, 0) / group.length,
        lng: group.reduce((sum, index) => sum + points[index].lng, 0) / group.length,
      };
    }
  }
  return groups;
}

async function fetchDirections(stops, warehouse, apiKey, optimize) {
  const originStr = `${warehouse.lat},${warehouse.lng}`;
  const waypoints = stops.map(s =>
    validGeoPoint(s) ? `${Number(s.lat)},${Number(s.lng)}` : s.fullAddress
  );
  const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: {
      origin: originStr, destination: originStr,   // ida y vuelta a la bodega
      waypoints: `${optimize ? 'optimize:true|' : ''}${waypoints.join('|')}`,
      key: apiKey, language: 'es', region: 'cl', mode: 'driving',
    },
    timeout: 12000,
  });
  if (data.status !== 'OK') throw new Error(`Google Maps: ${data.status} — ${data.error_message || ''}`);
  return data.routes[0];
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  const path = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= encoded.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= encoded.length);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    path.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return path.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function buildOptimizedRoute(ordered, directions, warehouse) {
  const legs = directions?.legs || [];
  const originStr = `${warehouse.lat},${warehouse.lng}`;
  const routeStops = ordered.map((stop, idx) => ({
    ...decorateDeliveryPriority(stop),
    stopNumber: idx + 1,
    distanceText: legs[idx]?.distance?.text || '',
    durationText: legs[idx]?.duration?.text || '',
    lat: (validGeoPoint(stop) ? Number(stop.lat) : legs[idx]?.end_location?.lat) ?? null,
    lng: (validGeoPoint(stop) ? Number(stop.lng) : legs[idx]?.end_location?.lng) ?? null,
  }));
  const distM = legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
  const durS = legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
  return {
    stops: routeStops,
    totalDistance: `${(distM / 1000).toFixed(1)} km`,
    totalDuration: `${Math.round(durS / 60)} min`,
    mapsUrl: `https://www.google.com/maps/dir/${encodeURIComponent(originStr)}/${routeStops.map(s => encodeURIComponent(s.fullAddress || `${s.lat},${s.lng}`)).join('/')}/${encodeURIComponent(originStr)}`,
    path: decodePolyline(directions?.overview_polyline?.points),
  };
}

/** Optimiza una ruta, sin permitir que Maps deje un reintento tras pedidos nuevos. */
async function optimizeOneRoute(stops, warehouse, apiKey) {
  const first = await fetchDirections(stops, warehouse, apiKey, true);
  const googleOrder = first.waypoint_order?.length ? first.waypoint_order : stops.map((_, index) => index);
  const googleOptimized = googleOrder.map(index => stops[index]);
  const prioritized = prioritizeOrders(googleOptimized);
  const changed = prioritized.some((stop, index) => orderKey(stop) !== orderKey(googleOptimized[index]));

  // Si Google mezcló pedidos nuevos delante de reintentos, recalcular la ruta
  // en el orden prioritario exacto para que tiempos, tramos y mapa sean reales.
  if (changed) {
    const exact = await fetchDirections(prioritized, warehouse, apiKey, false);
    return buildOptimizedRoute(prioritized, exact, warehouse);
  }
  return buildOptimizedRoute(prioritized, first, warehouse);
}

// ─── ADMIN: Optimizar ruta(s) con Google Maps ────────────────────────────────
//
// Origen y destino = bodega (round trip). Con `vehicles` > 1 divide las paradas
// entre vehículos por cercanía y optimiza cada ruta por separado.
// Devuelve `routes: [{ vehicle, stops, totalDistance, totalDuration, mapsUrl }]`.

router.post('/optimize', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { orders: rawOrders, vehicles: vehiclesRaw } = req.body;
  let availability;
  try {
    availability = await partitionDispatchable(getPool(), req.orgId, rawOrders || []);
  } catch (err) {
    console.error('[Delivery/optimize availability]', err.message);
    return res.status(500).json({ success: false, error: 'No se pudo validar la lista de pedidos' });
  }
  const orders = availability.keep;
  const skipped = availability.skip;
  const vehicles = Math.max(1, Math.min(parseInt(vehiclesRaw) || 1, 10));
  if (!orders || orders.length === 0)
    return res.status(400).json({
      success: false,
      error: 'No hay pedidos pendientes de despacho para optimizar. Actualiza la lista.',
      skipped,
    });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  // Bodega: origen y destino de todas las rutas
  const whAddress = await db.getSetting(req.orgId, 'warehouse_address').catch(() => null);
  const whLat = parseFloat(await db.getSetting(req.orgId, 'warehouse_lat').catch(() => null));
  const whLng = parseFloat(await db.getSetting(req.orgId, 'warehouse_lng').catch(() => null));
  const warehouse = (whAddress && Number.isFinite(whLat) && Number.isFinite(whLng))
    ? { address: whAddress, lat: whLat, lng: whLng } : null;

  // Sin API key o sin bodega: no se puede optimizar. Devolver orden simple,
  // dividido en tandas iguales si hay varios vehículos, para no bloquear el flujo.
  if (!apiKey || !warehouse) {
    const per = Math.ceil(orders.length / vehicles);
    const routes = [];
    for (let v = 0; v < vehicles; v++) {
      const slice = orders.slice(v * per, (v + 1) * per);
      if (slice.length) routes.push({
        vehicle: v + 1,
        stops: slice.map((o, i) => ({ ...o, stopNumber: i + 1 })),
        totalDistance: '', totalDuration: '', mapsUrl: null,
      });
    }
    return res.json({
      success: true, optimized: false, warehouse, routes, skipped,
      route: routes[0]?.stops || [],   // compat con clientes viejos
      warning: `${skipped.length ? `${skipped.length} pedido${skipped.length === 1 ? '' : 's'} antiguo${skipped.length === 1 ? '' : 's'} o no disponible${skipped.length === 1 ? '' : 's'} se omitieron. ` : ''}${!warehouse
        ? 'Configura la dirección de la bodega en Ajustes para optimizar las rutas.'
        : 'Sin GOOGLE_MAPS_API_KEY - orden sin optimizar.'}`,
    });
  }

  try {
    // Agrupar por cercanía. Solo se pueden clusterizar los que tienen coords.
    const located   = orders.filter(validGeoPoint).map(order => ({ ...order, lat: Number(order.lat), lng: Number(order.lng) }));
    const locatedKeys = new Set(located.map(orderKey));
    const unlocated  = orders.filter(order => !locatedKeys.has(orderKey(order)));
    const wantedGroups = Math.min(vehicles, orders.length);
    const locatedGroupCount = Math.min(wantedGroups, located.length);
    // kmeansBalanced devuelve índices EXCLUSIVAMENTE sobre `located`. Convertir
    // primero a objetos evita mezclar esos índices con posiciones de `orders`.
    const groupsAsObjs = locatedGroupCount
      ? kmeansBalanced(located, locatedGroupCount).map(group => group.map(index => located[index]))
      : [];
    while (groupsAsObjs.length < wantedGroups) groupsAsObjs.push([]);
    // Las direcciones aún sin coordenadas también deben aparecer una sola vez.
    // Se incorporan siempre al grupo menos cargado, sin reutilizar índices.
    for (const order of unlocated) {
      let target = 0;
      for (let i = 1; i < groupsAsObjs.length; i++) {
        if (groupsAsObjs[i].length < groupsAsObjs[target].length) target = i;
      }
      groupsAsObjs[target].push(order);
    }

    const routes = [];
    for (let v = 0; v < groupsAsObjs.length; v++) {
      const stops = groupsAsObjs[v];
      if (!stops.length) continue;
      try {
        const r = await optimizeOneRoute(stops, warehouse, apiKey);
        routes.push({ vehicle: v + 1, ...r });
      } catch (e) {
        console.error(`[Delivery/optimize] vehículo ${v + 1}:`, e.message);
        routes.push({ vehicle: v + 1, stops: stops.map((o, i) => ({ ...o, stopNumber: i + 1 })), totalDistance: '', totalDuration: '', mapsUrl: null, error: e.message });
      }
    }

    const failedRoutes = routes.filter(route => route.error).length;
    const warnings = [];
    if (skipped.length) {
      warnings.push(`${skipped.length} pedido${skipped.length === 1 ? '' : 's'} antiguo${skipped.length === 1 ? '' : 's'} o no disponible${skipped.length === 1 ? '' : 's'} se omitieron.`);
    }
    if (failedRoutes) {
      warnings.push(`${failedRoutes} ruta(s) conservaron todas sus paradas, pero Google no pudo optimizar su orden.`);
    }
    res.json({
      success: true, optimized: failedRoutes === 0, warehouse, vehicles: routes.length, routes, skipped,
      route: routes[0]?.stops || [],   // compat con clientes viejos
      warning: warnings.join(' ') || null,
    });
  } catch (err) {
    console.error('[Delivery/optimize]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Listar rutas ─────────────────────────────────────────────────────

router.get('/routes', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  // IMPORTANTE: Esta ruta debe estar antes de /routes/active para no ser interceptada
  const pool = getPool();
  const { status, limit = 20, page = 1 } = req.query;
  try {
    let query = `SELECT id, name, status, driver_name, driver_phone, driver_user_id,
                        total_distance, total_duration, maps_url,
                        created_at, sent_at, started_at, completed_at,
                        jsonb_array_length(orders) AS order_count,
                        orders, optimized_route, load_checklist,
                        stop_statuses, stop_payments, stop_payment_amounts
                 FROM delivery_routes
                 WHERE organization_id = $1`;
    const params = [req.orgId];
    if (status) { query += ` AND status = $${params.length + 1}`; params.push(status); }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const { rows } = await pool.query(query, params);
    // Rutas antiguas podían guardar la parada sin copiar sus productos. El
    // panel de auditoría necesita el mismo manifiesto completo que recibe la
    // app del repartidor, incluso para esas rutas ya existentes.
    const routes = await Promise.all(rows.map(route => hydrateRouteItems(pool, route, req.orgId)));
    res.json({ success: true, routes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── REPARTIDOR: Ruta activa asignada ────────────────────────────────────────
// DEBE estar después de GET /routes para no colisionar (express lo resuelve por orden)

/**
 * Rutas activas para el que consulta.
 *
 * - Repartidor: sus rutas ('driver_user_id' = él) más las que quedaron sin
 *   asignar (para orgs con un solo chofer que no crearon usuario aparte).
 * - Admin/supervisor: todas las activas de la org (para monitoreo).
 *
 * Devuelve `routes` (todas) y `route` (la más reciente) — la app anterior
 * solo leía `route`, así se mantiene compatible.
 */
router.get('/routes/active', async (req, res) => {
  const pool = getPool();
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  try {
    const { rows } = await pool.query(`
      SELECT r.*, u.name AS driver_user_name
        FROM delivery_routes r
        LEFT JOIN users u ON u.id = r.driver_user_id
       WHERE r.organization_id = $1
         AND r.status IN ('sent', 'in_progress')
         AND ($2::int IS NULL OR r.driver_user_id = $2 OR r.driver_user_id IS NULL)
       ORDER BY r.sent_at DESC NULLS LAST, r.created_at DESC
    `, [req.orgId, driverScope]);

    res.json({ success: true, routes: rows, route: rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Historial de rutas del repartidor: las que ya terminó o se cancelaron.
 * El repartidor ve solo las suyas; admin/supervisor ven todas (monitoreo).
 * Se usa para que el chofer revise rutas pasadas y corrija una parada si se
 * equivocó (la correccion usa el mismo PATCH /routes/:id/stops).
 * IMPORTANTE: va antes de /routes/:id para que "history" no se tome como id.
 */
router.get('/routes/history', async (req, res) => {
  const pool = getPool();
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  const limit = Math.min(parseInt(req.query.limit) || 40, 100);
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.name, r.status, r.driver_name, r.driver_user_id,
             r.orders, r.optimized_route, r.stop_statuses,
             r.stop_payments, r.stop_payment_amounts, r.stop_notes, r.stop_extras, r.stop_times,
             r.total_distance, r.total_duration, r.created_at, r.sent_at, r.started_at, r.completed_at,
             u.name AS driver_user_name
        FROM delivery_routes r
        LEFT JOIN users u ON u.id = r.driver_user_id
       WHERE r.organization_id = $1
         AND r.status IN ('completed', 'cancelled')
         AND ($2::int IS NULL OR r.driver_user_id = $2)
       ORDER BY COALESCE(r.completed_at, r.sent_at, r.created_at) DESC
       LIMIT $3
    `, [req.orgId, driverScope, limit]);
    res.json({ success: true, routes: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function routeFinancialSummary(pool, route, orgId) {
  const orders = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
  const stops = Array.isArray(route.optimized_route) && route.optimized_route.length
    ? route.optimized_route
    : orders;
  const botIds = orders.filter(order => order.source === 'bot').map(order => Number(order.id)).filter(Number.isFinite);
  const shopIds = orders.filter(order => order.source === 'shopify').map(order => String(order.id));
  const [botResult, shopResult, expenseResult] = await Promise.all([
    botIds.length
      ? pool.query('SELECT id::text AS id, total_price, payment_method, payment_cash_amount, payment_transfer_amount FROM orders WHERE organization_id = $1 AND id = ANY($2::int[])', [orgId, botIds])
      : { rows: [] },
    shopIds.length
      ? pool.query('SELECT shopify_order_id AS id, total_price, payment_method, payment_cash_amount, payment_transfer_amount FROM shopify_orders WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])', [orgId, shopIds])
      : { rows: [] },
    pool.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::int AS total FROM delivery_expenses WHERE organization_id = $1 AND route_id = $2',
      [orgId, route.id]
    ),
  ]);
  const totals = new Map();
  const orderPayments = new Map();
  botResult.rows.forEach(row => { totals.set(`bot_${row.id}`, Number(row.total_price) || 0); orderPayments.set(`bot_${row.id}`, row); });
  shopResult.rows.forEach(row => { totals.set(`shopify_${row.id}`, Number(row.total_price) || 0); orderPayments.set(`shopify_${row.id}`, row); });
  const statuses = route.stop_statuses || {};
  const payments = route.stop_payments || {};
  const paymentAmounts = route.stop_payment_amounts || {};
  let routeValue = 0, deliveredValue = 0, cashCollected = 0, transferCollected = 0, otherCollected = 0;
  for (const stop of stops) {
    const key = `${stop.source}_${stop.id}`;
    const amount = totals.get(key) ?? (Number(stop.totalPrice || stop.total_price) || 0);
    routeValue += amount;
    if (statuses[key] !== 'entregado') continue;
    deliveredValue += amount;
    const method = payments[key] || orderPayments.get(key)?.payment_method;
    const saved = paymentAmounts[key] || orderPayments.get(key) || {};
    const cash = Number(saved.cash ?? saved.payment_cash_amount);
    const transfer = Number(saved.transfer ?? saved.payment_transfer_amount);
    if (method === 'mixto') {
      cashCollected += Number.isFinite(cash) ? cash : 0;
      transferCollected += Number.isFinite(transfer) ? transfer : 0;
    } else if (method === 'efectivo') cashCollected += Number.isFinite(cash) && cash > 0 ? cash : amount;
    else if (method === 'transferencia') transferCollected += Number.isFinite(transfer) && transfer > 0 ? transfer : amount;
    else otherCollected += amount;
  }
  const expense = expenseResult.rows[0] || { count: 0, total: 0 };
  return {
    routeValue: Math.round(routeValue),
    deliveredValue: Math.round(deliveredValue),
    cashCollected: Math.round(cashCollected),
    transferCollected: Math.round(transferCollected),
    otherCollected: Math.round(otherCollected),
    expenseCount: Number(expense.count) || 0,
    expensesTotal: Number(expense.total) || 0,
    netCash: Math.round(cashCollected - (Number(expense.total) || 0)),
  };
}

/**
 * Detalle de una ruta. La app lo usa para refrescar el estado de las paradas
 * al volver a la pantalla (en vez de pasar callbacks por navegación).
 */
router.get('/routes/:id', async (req, res) => {
  const pool = getPool();
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  try {
    const { rows: [route] } = await pool.query(`
      SELECT r.*, u.name AS driver_user_name
        FROM delivery_routes r
        LEFT JOIN users u ON u.id = r.driver_user_id
       WHERE r.id = $1 AND r.organization_id = $2
         AND ($3::int IS NULL OR r.driver_user_id = $3 OR r.driver_user_id IS NULL)
    `, [parseInt(req.params.id), req.orgId, driverScope]);
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
    let hydratedRoute = await hydrateRouteItems(pool, route, req.orgId);
    hydratedRoute = await attachAttemptHistory(pool, hydratedRoute, req.orgId);
    hydratedRoute.financial_summary = await routeFinancialSummary(pool, hydratedRoute, req.orgId);
    res.json({ success: true, route: hydratedRoute });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Guarda el orden manual definido por el repartidor en la app móvil.
 * Se exige una permutación exacta de las paradas actuales para impedir que
 * una actualización atrasada agregue o quite pedidos de la ruta.
 */
router.patch('/routes/:id/reorder', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  const stopKeys = req.body?.stopKeys;
  if (!Array.isArray(stopKeys) || stopKeys.length > 500 || stopKeys.some(key => typeof key !== 'string' || !key.trim())) {
    return res.status(400).json({ success: false, error: 'El orden de paradas no es válido' });
  }
  if (new Set(stopKeys).size !== stopKeys.length) {
    return res.status(400).json({ success: false, error: 'El orden contiene paradas repetidas' });
  }

  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  let client;
  try {
    client = await getPool().connect();
    await client.query('BEGIN');
    const { rows: [storedRoute] } = await client.query(
      `SELECT id, status, orders, optimized_route
         FROM delivery_routes
        WHERE id = $1 AND organization_id = $2
          AND ($3::int IS NULL OR driver_user_id = $3 OR driver_user_id IS NULL)
        FOR UPDATE`,
      [Number(req.params.id), req.orgId, driverScope]
    );
    if (!storedRoute) throw Object.assign(new Error('Ruta no encontrada o no asignada a ti'), { status: 404 });
    if (!['sent', 'in_progress'].includes(storedRoute.status)) {
      throw Object.assign(new Error('Solo se puede cambiar el orden de una ruta activa'), { status: 409 });
    }

    const currentStops = routeStops(storedRoute);
    const currentKeys = currentStops.map(orderKey);
    const requested = new Set(stopKeys);
    const exactSameStops = currentKeys.length === stopKeys.length
      && currentKeys.every(key => key && requested.has(key));
    if (!exactSameStops) {
      throw Object.assign(new Error('La ruta cambió mientras la estabas ordenando. Recárgala e intenta nuevamente.'), { status: 409 });
    }

    const stopsByKey = new Map(currentStops.map(stop => [orderKey(stop), stop]));
    const ordersByKey = new Map(jsonList(storedRoute.orders).map(order => [orderKey(order), order]));
    const optimizedRoute = stopKeys.map((key, index) => ({ ...stopsByKey.get(key), stopNumber: index + 1 }));
    const orders = stopKeys.map((key, index) => ({ ...(ordersByKey.get(key) || stopsByKey.get(key)), stopNumber: index + 1 }));

    const { rows: [updated] } = await client.query(
      `UPDATE delivery_routes
          SET orders = $3::jsonb, optimized_route = $4::jsonb
        WHERE id = $1 AND organization_id = $2
        RETURNING orders, optimized_route`,
      [storedRoute.id, req.orgId, JSON.stringify(orders), JSON.stringify(optimizedRoute)]
    );
    await client.query('COMMIT');
    res.json({ success: true, orders: updated.orders || [], optimizedRoute: updated.optimized_route || [] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ success: false, error: err.message });
  } finally {
    client?.release();
  }
});

router.patch('/routes/:id/load-checklist', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  const itemName = typeof req.body?.itemName === 'string' ? req.body.itemName.trim().slice(0, 160) : '';
  const checked = req.body?.checked;
  if (!itemName || typeof checked !== 'boolean') return res.status(400).json({ success: false, error: 'Falta producto o estado de carga' });
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  const pool = getPool();
  try {
    const { rows: [storedRoute] } = await pool.query(
      `SELECT id, status, orders, optimized_route, load_checklist
         FROM delivery_routes
        WHERE id = $1 AND organization_id = $2
          AND ($3::int IS NULL OR driver_user_id = $3 OR driver_user_id IS NULL)`,
      [Number(req.params.id), req.orgId, driverScope]
    );
    if (!storedRoute) return res.status(404).json({ success: false, error: 'Ruta no encontrada o no asignada a ti' });
    const route = await hydrateRouteItems(pool, storedRoute, req.orgId);
    if (route.status !== 'sent') return res.status(409).json({ success: false, error: 'La carga solo se puede modificar antes de iniciar el reparto' });
    const stops = routeStops(route);
    const names = new Set(stops.flatMap(stop => (stop.items || []).map(item => String(item.name || item.title || item.product_name || '').trim())).filter(Boolean));
    if (!names.has(itemName)) return res.status(400).json({ success: false, error: 'Ese producto no pertenece a la carga de esta ruta' });
    const { rows: [updated] } = await pool.query(
      `UPDATE delivery_routes
          SET load_checklist = COALESCE(load_checklist, '{}'::jsonb) || jsonb_build_object($1::text, $2::boolean)
        WHERE id = $3 AND organization_id = $4
        RETURNING load_checklist`,
      [itemName, checked, route.id, req.orgId]
    );
    res.json({ success: true, loadChecklist: updated.load_checklist || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/routes/:id/start', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  let client;
  try {
    client = await getPool().connect();
    await client.query('BEGIN');
    const { rows: [storedRoute] } = await client.query(
      `SELECT * FROM delivery_routes
        WHERE id = $1 AND organization_id = $2
          AND ($3::int IS NULL OR driver_user_id = $3 OR driver_user_id IS NULL)
        FOR UPDATE`,
      [Number(req.params.id), req.orgId, driverScope]
    );
    if (!storedRoute) throw Object.assign(new Error('Ruta no encontrada o no asignada a ti'), { status: 404 });
    const route = await hydrateRouteItems(client, storedRoute, req.orgId);
    if (route.status === 'in_progress') {
      await client.query('COMMIT');
      return res.json({ success: true, route });
    }
    if (route.status !== 'sent') throw Object.assign(new Error('La ruta no está lista para comenzar'), { status: 409 });

    const statuses = route.stop_statuses || {};
    const pendingOrders = jsonList(route.orders).filter(order => !['entregado', 'cancelled', 'postponed', 'not_delivered'].includes(statuses[orderKey(order)]));
    const eligible = await partitionDispatchable(client, req.orgId, pendingOrders, { allowAssigned: true });
    if (eligible.skip.length) {
      throw Object.assign(new Error('La ruta cambió: contiene pedidos entregados, cancelados, pagados o programados para otro día. Pide al administrador que la actualice.'), { status: 409, skipped: eligible.skip });
    }

    const checklist = route.load_checklist && typeof route.load_checklist === 'object' ? route.load_checklist : {};
    const missingItems = buildLoadManifest(route).filter(item => checklist[item.name] !== true);
    if (missingItems.length) {
      throw Object.assign(new Error('Completa todo el checklist de carga antes de iniciar el reparto'), { status: 409, missingItems });
    }

    const { rows: [started] } = await client.query(
      `UPDATE delivery_routes
          SET status = 'in_progress', started_at = COALESCE(started_at, NOW())
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      [route.id, req.orgId]
    );
    await markOrdersEnRoute(client, req.orgId, pendingOrders);
    await client.query('COMMIT');
    res.json({ success: true, route: started });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      ...(err.missingItems ? { missingItems: err.missingItems } : {}),
      ...(err.skipped ? { skipped: err.skipped } : {}),
    });
  } finally {
    client?.release();
  }
});

async function getOwnedActiveStop(req, routeId, stopKey) {
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;
  const { rows: [route] } = await getPool().query(`
    SELECT id, status, orders, driver_user_id
      FROM delivery_routes
     WHERE id = $1 AND organization_id = $2
       AND ($3::int IS NULL OR driver_user_id = $3 OR driver_user_id IS NULL)
     LIMIT 1`, [Number(routeId), req.orgId, driverScope]);
  if (!route) throw Object.assign(new Error('Ruta no encontrada o no asignada a ti'), { status: 404 });
  if (route.status !== 'in_progress') throw Object.assign(new Error('Completa la consolidación de carga e inicia la ruta antes de atender pedidos'), { status: 409 });
  const orders = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
  const stop = orders.find(item => `${item.source}_${item.id}` === stopKey);
  if (!stop) throw Object.assign(new Error('El pedido no pertenece a la ruta'), { status: 404 });
  return { ...stop, driver_user_id: route.driver_user_id || driverScope };
}

async function conversationForStop(orgId, stop, { create = false } = {}) {
  const window = await deliveryNotifications.getCustomerServiceWindow(orgId, stop.phone);
  let conversation = window.conversationId
    ? await db.getConversationById(window.conversationId, orgId)
    : null;

  if (!conversation && create) {
    const config = await whatsappProvider.configForConversation(orgId, null);
    conversation = await db.upsertConversation(
      orgId,
      stop.phone,
      stop.customerName || stop.customer_name || 'Cliente',
      config?.id || null
    );
  }

  return { window, conversation };
}

async function evolutionChatRoute(orgId, stop, { create = false, window = null } = {}) {
  const config = typeof db.getEvolutionWhatsappChannel === 'function'
    ? await db.getEvolutionWhatsappChannel(orgId)
    : null;
  if (!config) return null;
  const conversation = create
    ? await db.upsertConversation(
        orgId,
        stop.phone,
        stop.customerName || stop.customer_name || 'Cliente',
        config.id
      )
    : null;
  return { window, conversation, config, available: true, channel: 'evolution', fallback: true };
}

async function deliveryChatRoute(orgId, stop, { create = false } = {}) {
  const personal = await require('../services/driver-whatsapp').route(orgId, stop, create);
  if (personal) return personal;

  const resolved = await conversationForStop(orgId, stop);
  const primaryConversation = resolved.conversation;
  const primaryConfig = await whatsappProvider.configForConversation(orgId, primaryConversation);

  if (primaryConfig && !primaryConfig.assigned_user_id && (resolved.window.available || primaryConfig.provider === 'evolution')) {
    let conversation = primaryConversation;
    if (!conversation && create && primaryConfig) {
      conversation = await db.upsertConversation(
        orgId,
        stop.phone,
        stop.customerName || stop.customer_name || 'Cliente',
        primaryConfig.provider === 'evolution' ? primaryConfig.id || null : null
      );
    }
    return {
      window: resolved.window,
      conversation,
      config: primaryConfig,
      available: !!primaryConfig,
      channel: primaryConfig?.provider || null,
      fallback: false,
    };
  }

  const evolutionRoute = await evolutionChatRoute(orgId, stop, { create, window: resolved.window });
  if (!evolutionRoute) {
    return {
      window: resolved.window,
      conversation: primaryConversation,
      config: primaryConfig,
      available: false,
      channel: primaryConfig?.provider || null,
      fallback: false,
    };
  }

  return { ...evolutionRoute, conversation: evolutionRoute.conversation || primaryConversation };
}

// Chat acotado a una parada de la ruta. El teléfono y la conversación siempre
// se resuelven en el servidor para impedir que un repartidor consulte clientes
// ajenos enviando un número o conversationId arbitrario.
router.get('/routes/:id/stops/chat', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  try {
    const stopKey = String(req.query.stopKey || '');
    if (!stopKey) return res.status(400).json({ success: false, error: 'Falta stopKey' });
    const stop = await getOwnedActiveStop(req, req.params.id, stopKey);
    if (!String(stop.phone || '').replace(/\D/g, '')) return res.status(400).json({ success: false, error: 'Este pedido no tiene teléfono registrado' });
    const routing = await deliveryChatRoute(req.orgId, stop);
    const messages = routing.personal
      ? routing.conversation ? await db.getMessagesByConversation(routing.conversation.id, 60) : []
      : typeof db.getMessagesByCustomerPhone === 'function'
      ? await db.getMessagesByCustomerPhone(req.orgId, stop.phone, 60, true)
      : routing.conversation ? await db.getMessagesByConversation(routing.conversation.id, 60) : [];
    res.json({
      success: true,
      data: {
        conversation: routing.conversation,
        messages,
        window: {
          ...routing.window,
          available: routing.available,
          channel: routing.channel,
          fallback: routing.fallback,
          sender: routing.sender || null,
          personal: !!routing.personal,
          message: routing.message || (routing.available
            ? routing.fallback
              ? 'La ventana de Kapso está cerrada. Los mensajes se enviarán automáticamente por Evolution.'
              : 'El canal de WhatsApp está disponible.'
            : 'La ventana de Kapso está cerrada y Evolution no está disponible.'),
        },
        customer: { name: stop.customerName || stop.customer_name || 'Cliente', phone: stop.phone },
      },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

router.post('/routes/:id/stops/chat', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  try {
    const stopKey = String(req.body?.stopKey || '');
    const text = String(req.body?.text || '').trim();
    if (!stopKey) return res.status(400).json({ success: false, error: 'Falta stopKey' });
    if (!text) return res.status(400).json({ success: false, error: 'Escribe un mensaje' });
    if (text.length > 1000) return res.status(400).json({ success: false, error: 'El mensaje no puede superar 1.000 caracteres' });

    const stop = await getOwnedActiveStop(req, req.params.id, stopKey);
    if (!String(stop.phone || '').replace(/\D/g, '')) return res.status(400).json({ success: false, error: 'Este pedido no tiene teléfono registrado' });
    let routing = await deliveryChatRoute(req.orgId, stop, { create: true });
    let { conversation, config } = routing;
    if (!config) return res.status(400).json({ success: false, error: 'WhatsApp no está configurado para esta cuenta' });
    if (!routing.available) {
      return res.status(409).json({
        success: false,
        error: 'WINDOW_EXPIRED',
        message: routing.message || 'La ventana de Kapso está cerrada y no hay un canal Evolution disponible.',
        window: routing.window,
      });
    }

    let sent;
    try {
      sent = await whatsappProvider.sendTextMessage(conversation.phone_number, text, config);
    } catch (sendError) {
      if (sendError.is24hWindow && config.provider !== 'evolution') {
        const fallback = await evolutionChatRoute(req.orgId, stop, { create: true, window: routing.window });
        if (fallback) {
          routing = fallback;
          conversation = fallback.conversation;
          config = fallback.config;
          sent = await whatsappProvider.sendTextMessage(conversation.phone_number, text, config);
        } else {
          return res.status(409).json({
            success: false,
            error: 'WINDOW_EXPIRED',
            message: 'La ventana de Kapso se cerró y no hay un canal Evolution disponible.',
          });
        }
      } else if (sendError.is24hWindow) {
        return res.status(409).json({
          success: false,
          error: 'WINDOW_EXPIRED',
          message: 'No se pudo enviar el mensaje por WhatsApp.',
        });
      } else {
        throw sendError;
      }
    }

    const driver = await db.getUserById(req.userId).catch(() => null);
    const driverName = String(driver?.name || driver?.email || 'Repartidor').replace(/:/g, ' ').slice(0, 80);
    const message = await db.saveMessage({
      conversationId: conversation.id,
      whatsappMessageId: whatsappProvider.messageId(sent),
      direction: 'outbound',
      content: text,
      type: 'text',
      status: 'sent',
      sentBy: 'human',
      agentType: `driver:${driverName}`,
    });
    await db.updateConversationLastMessage(conversation.id, text);
    await db.setAgentMode(conversation.id, 'human');

    const updatedConversation = await db.getConversationById(conversation.id, req.orgId);
    io?.to(`org_${req.orgId}`).emit(`agent_mode_changed_${req.orgId}`, { conversationId: conversation.id, mode: 'human' });
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message, conversation: updatedConversation });
    res.json({ success: true, data: { message, conversation: updatedConversation, channel: routing.channel, fallback: routing.fallback } });
  } catch (error) {
    console.error('[Delivery chat] Error enviando:', error);
    res.status(error.status || 500).json({ success: false, error: error.code || error.message, message: error.message });
  }
});

router.post('/routes/:id/stops/chat/media', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  try {
    const stopKey = String(req.body?.stopKey || '');
    if (!stopKey) return res.status(400).json({ success: false, error: 'Falta stopKey' });
    const stop = await getOwnedActiveStop(req, req.params.id, stopKey);
    if (!String(stop.phone || '').replace(/\D/g, '')) return res.status(400).json({ success: false, error: 'Este pedido no tiene teléfono registrado' });

    let routing = await deliveryChatRoute(req.orgId, stop, { create: true });
    let { conversation, config } = routing;
    if (!config) return res.status(400).json({ success: false, error: 'WhatsApp no está configurado para esta cuenta' });
    if (!routing.available) {
      return res.status(409).json({
        success: false,
        error: 'WINDOW_EXPIRED',
        message: routing.message || 'La ventana de Kapso está cerrada y no hay un canal Evolution disponible para enviar archivos.',
      });
    }

    const driver = await db.getUserById(req.userId).catch(() => null);
    const driverName = String(driver?.name || driver?.email || 'Repartidor').replace(/:/g, ' ').slice(0, 80);
    let sent;
    try {
      sent = await outboundMedia.send({
        orgId: req.orgId,
        conversation,
        payload: req.body,
        config,
        agentType: `driver:${driverName}`,
      });
    } catch (sendErr) {
      if (sendErr.is24hWindow && config.provider !== 'evolution') {
        const fallback = await evolutionChatRoute(req.orgId, stop, { create: true, window: routing.window });
        if (!fallback) {
          return res.status(409).json({ success: false, error: 'WINDOW_EXPIRED', message: 'La ventana de Kapso se cerró y no hay un canal Evolution disponible para enviar archivos.' });
        }
        routing = fallback;
        conversation = fallback.conversation;
        config = fallback.config;
        sent = await outboundMedia.send({
          orgId: req.orgId,
          conversation,
          payload: req.body,
          config,
          agentType: `driver:${driverName}`,
        });
      } else if (sendErr.is24hWindow) {
        return res.status(409).json({ success: false, error: 'WINDOW_EXPIRED', message: 'No se pudo enviar el archivo por WhatsApp.' });
      } else {
        throw sendErr;
      }
    }
    await db.setAgentMode(conversation.id, 'human');
    const updated = await db.getConversationById(conversation.id, req.orgId);
    io?.to(`org_${req.orgId}`).emit(`agent_mode_changed_${req.orgId}`, { conversationId: conversation.id, mode: 'human' });
    io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message: sent.message, conversation: updated });
    res.json({ success: true, data: { message: sent.message, conversation: updated, channel: routing.channel, fallback: routing.fallback } });
  } catch (error) {
    console.error('[Delivery chat] Error enviando archivo:', error.message);
    res.status(error.status || 500).json({ success: false, error: error.code || error.message, message: error.message });
  }
});

// La app consulta esta ruta al abrir una parada para habilitar el botón solo
// cuando el cliente escribió durante las últimas 24 horas.
router.get('/routes/:id/en-route-status', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  try {
    const stopKey = String(req.query.stopKey || '');
    if (!stopKey) return res.status(400).json({ success: false, error: 'Falta stopKey' });
    const stop = await getOwnedActiveStop(req, req.params.id, stopKey);
    const window = await deliveryNotifications.getCustomerServiceWindow(req.orgId, stop.phone);
    const template = window.available
      ? null
      : await require('../services/template-automation').getAssignment(req.orgId, 'delivery_en_route');
    const canNotify = window.available || !!template;
    res.json({
      success: true,
      ...window,
      available: canNotify,
      mode: window.available ? 'text' : template ? 'template' : 'unavailable',
      templateName: template?.name || null,
      message: window.available
        ? 'Puedes avisarle desde Diva sin usar un template.'
        : template
          ? `La ventana está cerrada. Se usará el template ${template.name}.`
          : 'La ventana de 24 horas está cerrada y falta asignar un template en Configuración → Templates.',
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// Envía un texto operativo desde el número del negocio. Se vuelve a validar la
// ventana justo antes de enviar para cubrir el caso en que haya expirado desde
// que el repartidor abrió la parada.
router.post('/routes/:id/notify-en-route', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), async (req, res) => {
  try {
    const stopKey = String(req.body?.stopKey || '');
    if (!stopKey) return res.status(400).json({ success: false, error: 'Falta stopKey' });
    const stop = await getOwnedActiveStop(req, req.params.id, stopKey);
    const result = await deliveryNotifications.sendEnRouteNotification(req.orgId, stop);
    if (result.message) {
      const conversation = await db.getConversationById(result.conversationId, req.orgId).catch(() => null);
      io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message: result.message, conversation });
    }
    res.json({ success: true, sent: true, text: result.text, via: result.via, templateName: result.templateName });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.code || error.message,
      message: error.message,
      window: error.window || null,
    });
  }
});

/**
 * Repartidores de la org (usuarios con rol 'repartidor'), para el selector
 * al crear una ruta. Accesible para cualquier rol que vea Repartos.
 */
router.get('/drivers', async (req, res) => {
  const pool = getPool();
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.email, u.whatsapp_phone,
             (SELECT COUNT(*) FROM delivery_routes r
               WHERE r.driver_user_id = u.id AND r.status IN ('sent','in_progress'))::int AS active_routes
        FROM users u
       WHERE u.organization_id = $1 AND u.merged_into_user_id IS NULL AND u.role IN ('repartidor', 'coordinador')
       ORDER BY u.name ASC NULLS LAST, u.email ASC
    `, [req.orgId]);
    res.json({ success: true, drivers: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Catálogo para venta en ruta ("bandejas extras"). Solo devuelve productos si la
 * tienda activó driver_sell_enabled. Accesible por el repartidor (rutas /delivery).
 */
router.get('/catalog', async (req, res) => {
  try {
    const enabled = (await db.getSetting(req.orgId, 'driver_sell_enabled').catch(() => null)) === 'true';
    if (!enabled) return res.json({ success: true, enabled: false, products: [] });

    let rows = [];
    try { rows = await db.getProducts(req.orgId, true); } catch { rows = []; }
    if (!rows || rows.length === 0) {
      try { rows = await db.getCachedProducts(req.orgId); } catch { rows = []; }
    }
    const products = (rows || [])
      .map(p => ({
        id:    String(p.id ?? p.external_id ?? ''),
        title: p.title || p.name || 'Producto',
        price: Math.round(parseFloat(p.price) || 0),
      }))
      .filter(p => p.title && p.id);
    res.json({ success: true, enabled: true, products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Gastos del repartidor (rendición: petróleo, peaje, comida, etc.) ────────
// El repartidor crea gastos con foto opcional; el admin los ve en Repartos.

router.post('/expenses', async (req, res) => {
  const pool = getPool();
  try {
    const { amount, category, note, routeId, photoBase64, photoMime, clientRequestId } = req.body;
    if (clientRequestId != null && !/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)) return res.status(400).json({ error: 'Identificador inválido' });
    const amt = Math.round(parseFloat(amount) || 0);
    if (!Number.isSafeInteger(amt) || amt <= 0 || amt > 2147483647) return res.status(400).json({ success: false, error: 'Monto inválido' });
    if (routeId) {
      const { rows } = await pool.query('SELECT id FROM delivery_routes WHERE id = $1 AND organization_id = $2 AND ($3::integer IS NULL OR driver_user_id = $3)', [Number(routeId), req.orgId, req.role === 'repartidor' ? req.userId : null]);
      if (!rows.length) return res.status(404).json({ error: 'Ruta no encontrada' });
    }
    let photoBuf = null;
    if (photoBase64) {
      photoBuf = Buffer.from(String(photoBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (photoBuf.length > 9 * 1024 * 1024) return res.status(400).json({ success: false, error: 'La foto es muy pesada' });
    }
    let driverName = null;
    try { const u = await db.getUserById(req.userId); driverName = u?.name || u?.email || null; } catch {}
    const { rows: [row] } = await pool.query(
      `INSERT INTO delivery_expenses
         (organization_id, route_id, driver_user_id, driver_name, amount, category, note, photo, photo_mime, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (organization_id, driver_user_id, client_request_id)
       DO UPDATE SET client_request_id = EXCLUDED.client_request_id RETURNING id, created_at`,
      [req.orgId, routeId ? parseInt(routeId) : null, req.userId, driverName, amt,
       (category || '').slice(0, 40), (note || '').slice(0, 300),
       photoBuf, photoBuf ? (photoMime || 'image/jpeg') : null, clientRequestId || null]
    );
    console.log(`[Delivery/expenses POST] ✅ id=${row.id} org=${req.orgId} driver=${driverName || req.userId} $${amt} ${category || ''} foto=${photoBuf ? Math.round(photoBuf.length / 1024) + 'KB' : 'no'}`);
    res.status(201).json({ success: true, id: row.id, created_at: row.created_at });
  } catch (err) {
    console.error('[Delivery/expenses POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/expenses', async (req, res) => {
  const pool = getPool();
  try {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if ((req.query.from && !datePattern.test(req.query.from)) || (req.query.to && !datePattern.test(req.query.to))) {
      return res.status(400).json({ success: false, error: 'Fechas inválidas. Usa YYYY-MM-DD' });
    }
    const own = req.role === 'repartidor';
    const params = [req.orgId];
    let where = 'organization_id = $1';
    if (own) { params.push(req.userId); where += ` AND driver_user_id = $${params.length}`; }
    if (req.query.from) { params.push(req.query.from); where += ` AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date >= $${params.length}::date`; }
    if (req.query.to)   { params.push(req.query.to); where += ` AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date <= $${params.length}::date`; }
    const [expensesResult, summaryResult, dailyResult] = await Promise.all([
      pool.query(
        `SELECT id, route_id, driver_user_id, driver_name, amount, category, note,
                (photo IS NOT NULL) AS has_photo, created_at
           FROM delivery_expenses WHERE ${where}
          ORDER BY created_at DESC LIMIT 500`, params),
      pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::int AS total
           FROM delivery_expenses WHERE ${where}`, params),
      pool.query(
        `SELECT TO_CHAR(((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date, 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::int AS total
           FROM delivery_expenses WHERE ${where}
          GROUP BY 1 ORDER BY 1`, params),
    ]);
    const summary = summaryResult.rows[0] || { count: 0, total: 0 };
    res.json({
      success: true,
      expenses: expensesResult.rows,
      total: summary.total,
      count: summary.count,
      byDay: dailyResult.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/cash-register', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const cashRegister = require('../services/cash-register');
  const { from, to } = req.query;
  if (!cashRegister.validDate(from) || !cashRegister.validDate(to) || from > to) {
    return res.status(400).json({ error: 'Indica un período de fechas válido.' });
  }
  try {
    res.json({ success: true, ...await cashRegister.report(getPool(), req.orgId, from, to) });
  } catch (err) {
    console.error('[Delivery/cash-register]', err.message);
    res.status(500).json({ error: 'No se pudo calcular la caja. Intenta nuevamente.' });
  }
});

router.get('/expenses/:id/photo', async (req, res) => {
  const pool = getPool();
  try {
    const own = req.role === 'repartidor';
    const params = [parseInt(req.params.id), req.orgId];
    let q = 'SELECT photo, photo_mime FROM delivery_expenses WHERE id = $1 AND organization_id = $2';
    if (own) { params.push(req.userId); q += ` AND driver_user_id = $3`; }
    const { rows: [row] } = await pool.query(q, params);
    if (!row || !row.photo) return res.status(404).send('Sin foto');
    res.set('Content-Type', row.photo_mime || 'image/jpeg');
    res.send(row.photo);
  } catch (err) {
    res.status(500).send('error');
  }
});

router.delete('/expenses/:id', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  try {
    await getPool().query('DELETE FROM delivery_expenses WHERE id = $1 AND organization_id = $2',
      [parseInt(req.params.id), req.orgId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Separa una lista de pedidos entre los que TODAVÍA hay que repartir y los que
 * ya no corresponde despachar (entregados, pagados, cancelados). Evita que un
 * borrador viejo mande al repartidor pedidos que ya se entregaron (doble
 * entrega). Devuelve { keep, skip }.
 */
async function partitionDispatchable(pool, orgId, orders, { allowAssigned = false } = {}) {
  const list = dedupeOrders(orders);
  const botIds  = list.filter(o => o.source === 'bot').map(o => parseInt(o.id)).filter(Number.isFinite);
  const shopIds = list.filter(o => o.source === 'shopify').map(o => String(o.id));
  const returnIds = list.filter(o => o.source === 'return').map(o => parseInt(o.id)).filter(Number.isFinite);
  const done = new Set();
  const fresh = new Map();
  if (botIds.length) {
    const { rows } = await pool.query(
      `SELECT id::text AS id, status, dispatch_count, last_attempt_status, delivery_note,
              (delivered_at IS NOT NULL OR status IN ('en_camino', 'entregado', 'cancelled', 'paid')
                OR (status = 'asignado_ruta' AND NOT $3::boolean)
                 OR (delivery_date > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date
                     AND status <> 'no_entregado')
                 OR (NOT $3::boolean AND NOT ${botDispatchReady})) AS blocked
         FROM orders
        WHERE organization_id = $1 AND id = ANY($2::int[])`,
      [orgId, botIds, allowAssigned]
    );
    rows.forEach(row => {
      const key = 'bot_' + row.id;
      if (row.blocked) done.add(key);
      fresh.set(key, {
        status: row.status,
        dispatchCount: parseInt(row.dispatch_count) || 0,
        lastAttemptStatus: row.last_attempt_status || null,
        deliveryNote: row.delivery_note || null,
      });
    });
  }
  if (shopIds.length) {
    const { rows } = await pool.query(
      `SELECT shopify_order_id AS id, crm_status AS status, dispatch_count,
              last_attempt_status, delivery_note,
              (delivered_at IS NOT NULL OR ${importedShopifyClosed}
                OR crm_status IN ('en_camino', 'entregado', 'cancelled')
                OR (crm_status = 'asignado_ruta' AND NOT $3::boolean)
                OR delivery_date > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Santiago')::date
                OR (NOT $3::boolean AND NOT ${shopifyDispatchReady})) AS blocked
         FROM shopify_orders
        WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])`,
      [orgId, shopIds, allowAssigned]
    );
    rows.forEach(row => {
      const key = 'shopify_' + row.id;
      if (row.blocked) done.add(key);
      fresh.set(key, {
        status: row.status,
        dispatchCount: parseInt(row.dispatch_count) || 0,
        lastAttemptStatus: row.last_attempt_status || null,
        deliveryNote: row.delivery_note || null,
      });
    });
  }
  if (returnIds.length) {
    const { rows } = await pool.query(
      `SELECT id, order_id, kind, status, items, customer, reason,
              replacement_description, pickup_required, money_direction,
              money_method, money_amount, scheduled_date,
              (status NOT IN ('approved','scheduled')
                OR (route_id IS NOT NULL AND NOT $3::boolean)
                OR scheduled_date > ${chileTodaySql}) AS blocked
         FROM order_returns
        WHERE organization_id = $1 AND id = ANY($2::int[])`,
      [orgId, returnIds, allowAssigned]
    );
    rows.forEach(row => {
      const key = 'return_' + row.id;
      if (row.blocked) done.add(key);
      fresh.set(key, normalizeReturnTask(row));
    });
  }
  // Un id inexistente o perteneciente a otra organización nunca debe viajar
  // confiando solo en la copia que conserva el navegador.
  for (const order of list) {
    const key = orderKey(order);
    if (!key || !fresh.has(key)) done.add(key);
  }
  const keep = [], skip = [];
  for (const order of list) {
    const key = `${order.source}_${order.id}`;
    const hydrated = decorateDeliveryPriority({ ...order, ...(fresh.get(key) || {}) });
    (done.has(key) ? skip : keep).push(hydrated);
  }
  return { keep: prioritizeOrders(keep), skip };
}

/** Deja solo las paradas cuyos pedidos siguen en `keep`, renumerando el orden. */
function filterStops(stops, keepOrders) {
  const keepMap = new Map(keepOrders.map(order => [orderKey(order), order]));
  const seen = new Set();
  const filtered = (Array.isArray(stops) ? stops : [])
    .filter(s => {
      const key = orderKey(s);
      if (!key || !keepMap.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(stop => {
      const fresh = keepMap.get(orderKey(stop));
      // Los datos operacionales se refrescan desde BD, pero la geometría fue
      // calculada por Directions y no debe perderse si el pedido original aún
      // tenía lat/lng nulos.
      return {
        ...stop,
        ...fresh,
        lat: validGeoPoint(stop) ? Number(stop.lat) : (fresh.lat ?? null),
        lng: validGeoPoint(stop) ? Number(stop.lng) : (fresh.lng ?? null),
        distanceText: stop.distanceText || fresh.distanceText || '',
        durationText: stop.durationText || fresh.durationText || '',
      };
    });
  return prioritizeOrders(filtered).map((stop, index) => ({ ...stop, stopNumber: index + 1 }));
}

/**
 * Resuelve el repartidor asignado: valida que el usuario exista en la org con
 * rol repartidor y completa nombre/teléfono si el admin no los escribió.
 */
async function resolveDriver(pool, orgId, { driverUserId, driverName, driverPhone }) {
  if (!driverUserId) return { driverUserId: null, driverName: driverName || null, driverPhone: driverPhone || null };
  const { rows: [u] } = await pool.query(
    `SELECT id, name, email, whatsapp_phone FROM users
      WHERE id = $1 AND organization_id = $2 AND merged_into_user_id IS NULL AND role IN ('repartidor', 'coordinador')`,
    [parseInt(driverUserId), orgId]
  );
  if (!u) throw Object.assign(new Error('El usuario seleccionado no existe o no puede repartir'), { status: 400 });
  return {
    driverUserId: u.id,
    driverName:   driverName || u.name || u.email,
    driverPhone:  driverPhone || u.whatsapp_phone || null,
  };
}

// ─── ADMIN: Crear ruta ───────────────────────────────────────────────────────

router.post('/routes', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { name, orders, optimizedRoute, totalDistance, totalDuration, mapsUrl, driverName, driverPhone, driverUserId, send } = req.body;
  if (!orders || orders.length === 0)
    return res.status(400).json({ success: false, error: 'La ruta debe tener pedidos' });

  const pool   = getPool();
  const status = send ? 'sent' : 'draft';
  const routeName = name || `Reparto ${new Date().toLocaleDateString('es-CL')}`;
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const driver = await resolveDriver(client, req.orgId, { driverUserId, driverName, driverPhone });

    // Al ENVIAR, sacar los pedidos que ya no corresponde repartir (entregados,
    // pagados, cancelados). En borrador se guardan todos como se seleccionaron.
    let finalOrders = prioritizeOrders(orders);
    let skipped = [];
    if (send) {
      const part = await partitionDispatchable(client, req.orgId, orders);
      finalOrders = part.keep;
      skipped = part.skip;
      if (finalOrders.length === 0)
        throw Object.assign(new Error('No hay pedidos para despachar hoy: ya fueron entregados, cancelados o están programados para otro día.'), { status: 400, skipped });
    }

    // Si no se optimizó, igual guardar las paradas en orden de selección:
    // la app necesita optimized_route para mostrar algo.
    const stopsBase = Array.isArray(optimizedRoute) && optimizedRoute.length > 0
      ? optimizedRoute
      : finalOrders.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    const stops = filterStops(stopsBase, finalOrders);

    const { rows: [route] } = await client.query(`
      INSERT INTO delivery_routes
        (organization_id, name, status, driver_name, driver_phone, driver_user_id,
         orders, optimized_route, total_distance, total_duration, maps_url, sent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      req.orgId, routeName, status, driver.driverName, driver.driverPhone, driver.driverUserId,
      JSON.stringify(finalOrders),
      JSON.stringify(stops),
      totalDistance || null, totalDuration || null, mapsUrl || null,
      send ? new Date().toISOString() : null,
    ]);

    if (send) await reserveOrdersForRoute(client, req.orgId, finalOrders, route.id, driver.driverUserId);
    await client.query('COMMIT');

    if (skipped.length) console.log(`[Delivery/routes POST] ⏭️ ${skipped.length} pedido(s) ya entregados omitidos al enviar`);
    if (send) notifyAssignedDriver(req.orgId, route);
    res.json({ success: true, route, skipped });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[Delivery/routes POST]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message, ...(err.skipped ? { skipped: err.skipped } : {}) });
  } finally {
    client?.release();
  }
});

// ─── ADMIN: Actualizar ruta (enviar, cancelar, cambiar datos) ────────────────

router.patch('/routes/:id', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { id } = req.params;
  const { status, driverName, driverPhone, driverUserId, name } = req.body;
  const pool = getPool();
  let client;

  const VALID = ['draft', 'sent', 'in_progress', 'completed', 'cancelled'];
  if (status && !VALID.includes(status))
    return res.status(400).json({ success: false, error: 'Estado inválido' });
  if (status === 'in_progress')
    return res.status(409).json({ success: false, error: 'El reparto debe iniciarse desde la app después de completar el checklist de carga' });

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Al enviar un borrador: sacar los pedidos que ya no corresponde repartir.
    let skipped = [];
    if (status === 'sent') {
      const { rows: [cur] } = await client.query(
        `SELECT orders, optimized_route FROM delivery_routes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [parseInt(id), req.orgId]
      );
      if (cur) {
        const curOrders = Array.isArray(cur.orders) ? cur.orders : JSON.parse(cur.orders || '[]');
        const part = await partitionDispatchable(client, req.orgId, curOrders);
        skipped = part.skip;
        if (part.keep.length === 0)
          throw Object.assign(new Error('No hay pedidos para despachar hoy: ya fueron entregados, cancelados o están programados para otro día.'), { status: 400, skipped });
        {
          const curStops = Array.isArray(cur.optimized_route) ? cur.optimized_route : JSON.parse(cur.optimized_route || '[]');
          await client.query(
            `UPDATE delivery_routes SET orders = $3, optimized_route = $4 WHERE id = $1 AND organization_id = $2`,
            [parseInt(id), req.orgId, JSON.stringify(part.keep), JSON.stringify(filterStops(curStops, part.keep))]
          );
          if (skipped.length) console.log(`[Delivery/routes PATCH] ⏭️ ${skipped.length} pedido(s) ya entregados omitidos al enviar ruta ${id}`);
        }
      }
    }

    const sets = []; const params = [req.orgId, parseInt(id)];
    if (status)      { sets.push(`status = $${params.length + 1}`); params.push(status); }
    if (driverUserId !== undefined) {
      // Reasignar (o desasignar con null). Completa nombre/teléfono desde el usuario.
      const driver = await resolveDriver(client, req.orgId, { driverUserId, driverName, driverPhone });
      sets.push(`driver_user_id = $${params.length + 1}`); params.push(driver.driverUserId);
      sets.push(`driver_name = $${params.length + 1}`);    params.push(driver.driverName);
      sets.push(`driver_phone = $${params.length + 1}`);   params.push(driver.driverPhone);
    } else {
      if (driverName !== undefined) { sets.push(`driver_name = $${params.length + 1}`); params.push(driverName || null); }
      if (driverPhone !== undefined) { sets.push(`driver_phone = $${params.length + 1}`); params.push(driverPhone || null); }
    }
    if (name)        { sets.push(`name = $${params.length + 1}`); params.push(name); }
    if (status === 'sent') {
      sets.push(`sent_at = NOW()`);
      sets.push(`started_at = NULL`);
      sets.push(`load_checklist = '{}'::jsonb`);
    }
    if (status === 'completed') { sets.push(`completed_at = NOW()`); }
    if (sets.length === 0) throw Object.assign(new Error('Nada que actualizar'), { status: 400 });

    const { rows: [route] } = await client.query(
      `UPDATE delivery_routes SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2 RETURNING *`,
      params
    );
    if (!route) throw Object.assign(new Error('Ruta no encontrada'), { status: 404 });

    if (status === 'sent') await reserveOrdersForRoute(client, req.orgId, route.orders, route.id, route.driver_user_id);

    // Al cancelar la ruta: los pedidos que iban EN CAMINO y no alcanzaron a
    // entregarse vuelven a 'por_despachar' para poder salir en otra ruta. No se
    // tocan los que ya se entregaron/pagaron (delivered_at o estado cerrado).
    if (status === 'cancelled' && route.orders) {
      const nBack = await releaseOrdersFromRoute(client, req.orgId, route.orders);
      console.log(`[Delivery/routes PATCH] ruta ${id} cancelada, ${nBack} pedido(s) devueltos a por_despachar`);
    }
    await client.query('COMMIT');
    if (status === 'sent' || (driverUserId !== undefined && ['sent', 'in_progress'].includes(route.status))) {
      notifyAssignedDriver(req.orgId, route);
    }
    res.json({ success: true, route, skipped });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ success: false, error: err.message, ...(err.skipped ? { skipped: err.skipped } : {}) });
  } finally {
    client?.release();
  }
});

// ─── ADMIN: Devolver los pedidos de una ruta cancelada a "por despachar" ───
//
// POST /api/delivery/routes/:id/release
//
// Para rutas ya canceladas cuyos pedidos quedaron atascados en preparación o 'en_camino'
// (antes de que el cancelar los devolviera solo). Los devuelve a
// 'por_despachar' para que reaparezcan en Despachos. No toca los entregados.
router.post('/routes/:id/release', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { id } = req.params;
  const pool = getPool();
  try {
    const { rows: [route] } = await pool.query(
      `SELECT orders FROM delivery_routes WHERE id = $1 AND organization_id = $2`,
      [parseInt(id), req.orgId]
    );
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
    const orders = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
    const restored_count = await releaseOrdersFromRoute(pool, req.orgId, orders);
    res.json({ success: true, restored: restored_count });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Agregar pedidos a una ruta ya creada ─────────────────────────────
//
// POST /api/delivery/routes/:id/orders   body: { orders: [ {source,id,...} ] }
//
// Agrega paradas al final de una ruta abierta. Si ya fue enviada, reinicia el
// checklist para consolidar nuevamente toda la carga. Si el reparto ya comenzó,
// conserva el orden actual, deja la nueva parada al final e invalida el
// checklist: ya no representa la carga con la que salió el vehículo.
router.post('/routes/:id/orders', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const pool = getPool();
  let client;
  const { orders } = req.body;
  if (!Array.isArray(orders) || orders.length === 0)
    return res.status(400).json({ success: false, error: 'No hay pedidos para agregar' });
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: [route] } = await client.query(
      `SELECT * FROM delivery_routes WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [parseInt(req.params.id), req.orgId]
    );
    if (!route) throw Object.assign(new Error('Ruta no encontrada'), { status: 404 });
    if (['completed', 'cancelled'].includes(route.status))
      throw Object.assign(new Error('No se pueden agregar pedidos a una ruta cerrada. Crea una ruta nueva.'), { status: 400 });

    const cur      = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
    const curStops = Array.isArray(route.optimized_route) ? route.optimized_route : JSON.parse(route.optimized_route || '[]');
    const existing = new Set(cur.map(o => `${o.source}_${o.id}`));
    const toAdd    = dedupeOrders(orders).filter(o => !existing.has(`${o.source}_${o.id}`));
    if (!toAdd.length) {
      await client.query('COMMIT');
      return res.json({ success: true, added: 0, route });
    }

    const eligible = await partitionDispatchable(client, req.orgId, toAdd);
    if (eligible.skip.length) {
      throw Object.assign(new Error('Hay pedidos que no se pueden despachar hoy. Actualiza la lista de pedidos.'), { status: 400, skipped: eligible.skip });
    }

    const hydratedToAdd = eligible.keep;
    const routeStarted = route.status === 'in_progress';
    const newOrders = routeStarted ? [...cur, ...hydratedToAdd] : prioritizeOrders([...cur, ...hydratedToAdd]);
    const baseStops = curStops.length ? curStops : cur.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    const orderedStops = routeStarted ? [...baseStops, ...hydratedToAdd] : prioritizeOrders([...baseStops, ...hydratedToAdd]);
    const newStops = orderedStops
      .map((order, index) => ({ ...order, stopNumber: index + 1 }));
    const nextChecklist = routeStarted
      ? { __invalidated: true, __invalidatedAt: new Date().toISOString() }
      : {};

    await client.query(
      `UPDATE delivery_routes
          SET orders = $3, optimized_route = $4, load_checklist = $5::jsonb
        WHERE id = $1 AND organization_id = $2`,
      [route.id, req.orgId, JSON.stringify(newOrders), JSON.stringify(newStops), JSON.stringify(nextChecklist)]
    );

    if (route.status === 'sent') await reserveOrdersForRoute(client, req.orgId, hydratedToAdd, route.id, route.driver_user_id);
    if (routeStarted) await markOrdersEnRoute(client, req.orgId, hydratedToAdd);

    const { rows: [updated] } = await client.query(
      `SELECT * FROM delivery_routes WHERE id = $1 AND organization_id = $2`,
      [route.id, req.orgId]
    );
    await client.query('COMMIT');
    console.log(`[Delivery/routes ADD] ✅ ${toAdd.length} pedido(s) agregados a ruta ${route.id} (${route.status})`);
    if (['sent', 'in_progress'].includes(route.status)) {
      const suffix = routeStarted ? '. El checklist de carga quedó desactivado' : '';
      notifyAssignedDriver(req.orgId, updated, `${updated.name || 'Tu ruta'} fue actualizada con ${toAdd.length} parada${toAdd.length === 1 ? '' : 's'} nueva${toAdd.length === 1 ? '' : 's'}${suffix}`);
    }
    res.json({ success: true, added: toAdd.length, checklistInvalidated: routeStarted, route: updated });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[Delivery/routes ADD]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message, ...(err.skipped ? { skipped: err.skipped } : {}) });
  } finally {
    client?.release();
  }
});

// ─── ADMIN: Eliminar ruta borrador ───────────────────────────────────────────

router.delete('/routes/:id', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const pool = getPool();
  try {
    const { rows: [r] } = await pool.query(
      `SELECT status FROM delivery_routes WHERE id = $1 AND organization_id = $2`,
      [parseInt(req.params.id), req.orgId]
    );
    if (!r) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
    if (r.status !== 'draft')
      return res.status(400).json({ success: false, error: 'Solo se pueden eliminar rutas en borrador' });
    await pool.query(`DELETE FROM delivery_routes WHERE id = $1`, [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── REPARTIDOR: Actualizar estado de una parada ─────────────────────────────
//
// Dos formas de llamarlo:
//   PATCH /routes/:id/stops            body: { stopKey, status, paymentMethod? }  ← usar esta
//   PATCH /routes/:id/stops/:stopKey   body: { status, paymentMethod? }           ← legacy
//
// La variante con el stopKey en la URL no sirve para pedidos Shopify: sus IDs
// son GIDs con barras ("gid://shopify/Order/123"), y Express no matchea
// ":stopKey" cuando el valor contiene "/". Por eso la app manda el stopKey en
// el body. La ruta legacy queda para los pedidos del bot ("bot_12").

router.patch('/routes/:id/stops', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), (req, res) => {
  const stopKey = req.body?.stopKey;
  if (!stopKey || typeof stopKey !== 'string')
    return res.status(400).json({ success: false, error: 'Falta stopKey en el body' });
  return applyStopUpdate(req, res, req.params.id, stopKey);
});

router.patch('/routes/:id/stops/:stopKey', requireRole('owner', 'admin', 'supervisor', 'coordinador', 'repartidor'), (req, res) => {
  return applyStopUpdate(req, res, req.params.id, req.params.stopKey);
});

/** Separa "shopify_gid://shopify/Order/1" en ['shopify', 'gid://shopify/Order/1']. */
function splitStopKey(stopKey) {
  const i = stopKey.indexOf('_');
  if (i === -1) return [stopKey, ''];
  return [stopKey.slice(0, i), stopKey.slice(i + 1)];
}

/**
 * Suma la venta extra del repartidor al pedido: agrega los ítems, recalcula el
 * total y marca delivery_modified. Es idempotente: los ítems agregados se marcan
 * con _deliveryExtra, así que reenviar la parada reemplaza los extras anteriores
 * en vez de duplicarlos. No sincroniza con Shopify (es la copia local del CRM).
 */
async function applyExtraToOrder(pool, source, orderId, orgId, extras) {
  if (!extras || !extras.length) return;
  const isShopify = source === 'shopify';
  const table = isShopify ? 'shopify_orders' : 'orders';
  const idCol = isShopify ? 'shopify_order_id' : 'id';
  const idVal = isShopify ? orderId : parseInt(orderId);

  const { rows: [row] } = await pool.query(
    `SELECT items, total_price FROM ${table} WHERE ${idCol} = $1 AND organization_id = $2`,
    [idVal, orgId]
  );
  if (!row) return;

  let items = [];
  try {
    items = Array.isArray(row.items) ? row.items
          : (typeof row.items === 'string' ? JSON.parse(row.items || '[]') : (row.items || []));
  } catch { items = []; }
  if (!Array.isArray(items)) items = [];

  const sum = arr => arr.reduce((s, e) => s + (Number(e.price) || 0) * (Number(e.quantity) || 0), 0);
  const priorExtras = items.filter(it => it && it._deliveryExtra);
  const baseItems   = items.filter(it => !(it && it._deliveryExtra));
  const baseTotal   = (parseFloat(row.total_price) || 0) - sum(priorExtras);

  const newExtraItems = extras.map(e => ({
    name: e.name, title: e.name, quantity: e.quantity, price: e.price, _deliveryExtra: true,
  }));
  const newItems = [...baseItems, ...newExtraItems];
  const newTotal = baseTotal + sum(newExtraItems);
  const itemsParam = JSON.stringify(newItems);

  if (isShopify) {
    await pool.query(
      `UPDATE shopify_orders SET items = $1::jsonb, total_price = $2, delivery_modified = TRUE
        WHERE shopify_order_id = $3 AND organization_id = $4`,
      [itemsParam, newTotal, idVal, orgId]
    );
  } else {
    await pool.query(
      `UPDATE orders SET items = $1, total_price = $2, delivery_modified = TRUE, updated_at = NOW()
        WHERE id = $3 AND organization_id = $4`,
      [itemsParam, String(Math.round(newTotal)), idVal, orgId]
    );
  }
}

async function applyReturnRouteStop(client, { owned, routeId, stopKey, returnId, orgId, userId, status, paymentMethod, note, deliverDate }) {
  const { rows: [row] } = await client.query(
    'SELECT * FROM order_returns WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [Number(returnId), orgId]
  );
  if (!row || Number(row.route_id) !== Number(routeId)) {
    throw Object.assign(new Error('La devolución ya no pertenece a esta ruta'), { status: 409 });
  }

  let returnStatus = row.status;
  let inventoryStatus = row.inventory_status;
  let assigned = row.driver_user_id;
  let scheduledDate = row.scheduled_date;
  let linkedRouteId = row.route_id;
  let confirmMoney = false;
  let action = 'route_update';

  if (status === 'entregado') {
    if (!['scheduled', 'in_progress'].includes(row.status)) {
      throw Object.assign(new Error('La devolución cambió de estado. Actualiza la ruta.'), { status: 409 });
    }
    if (row.money_method === 'efectivo' && paymentMethod !== 'efectivo') {
      const verb = row.money_direction === 'refund' ? 'devolución' : 'cobro';
      throw Object.assign(new Error(`Confirma el ${verb} en efectivo seleccionando Efectivo.`), { status: 400 });
    }
    confirmMoney = row.money_method === 'efectivo';
    inventoryStatus = row.pickup_required ? 'pending_review' : 'not_received';
    returnStatus = row.money_amount > 0 && !confirmMoney ? 'review' : 'resolved';
    action = 'complete';
  } else if (status === 'postponed') {
    if (!deliverDate) throw Object.assign(new Error('Indica la nueva fecha del cambio o devolución.'), { status: 400 });
    returnStatus = 'scheduled';
    scheduledDate = deliverDate;
    linkedRouteId = null;
    action = 'postpone';
  } else if (status === 'cancelled') {
    returnStatus = 'cancelled';
    linkedRouteId = null;
    action = 'cancel';
  } else if (status === 'not_delivered') {
    returnStatus = 'approved';
    assigned = null;
    scheduledDate = null;
    linkedRouteId = null;
    action = 'incident';
  }

  if (confirmMoney && row.money_amount > 0) {
    await client.query(
      `INSERT INTO return_money_movements(return_id,organization_id,method,amount,recorded_by)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(return_id) DO NOTHING`,
      [row.id, orgId, row.money_method, row.money_direction === 'refund' ? -row.money_amount : row.money_amount, userId]
    );
  }

  const event = {
    action, status: returnStatus, userId, at: new Date().toISOString(), note,
    driverId: assigned, scheduledDate, inventoryStatus,
    pickedUp: status === 'entregado' && row.pickup_required,
    replaced: status === 'entregado' && !!row.replacement_description,
    moneyConfirmed: confirmMoney,
    routeId: Number(routeId),
  };
  await client.query(
    `UPDATE order_returns
        SET status=$3, inventory_status=$4, driver_user_id=$5, scheduled_date=$6,
            route_id=$7, money_confirmed=money_confirmed OR $8,
            events=events || $9::jsonb, updated_at=NOW()
      WHERE id=$1 AND organization_id=$2`,
    [row.id, orgId, returnStatus, inventoryStatus, assigned, scheduledDate, linkedRouteId, confirmMoney, JSON.stringify([event])]
  );

  const noteJson = note ? JSON.stringify({ [stopKey]: note }) : '{}';
  const { rows: [route] } = await client.query(
    `UPDATE delivery_routes
        SET stop_statuses = stop_statuses || jsonb_build_object($1::text, $2::text),
            stop_notes = COALESCE(stop_notes, '{}'::jsonb) || $3::jsonb,
            stop_times = COALESCE(stop_times, '{}'::jsonb) || jsonb_build_object($1::text, to_jsonb(NOW()))
      WHERE id=$4 AND organization_id=$5
      RETURNING stop_statuses, orders`,
    [stopKey, status, noteJson, Number(routeId), orgId]
  );
  if (!route) throw new Error('Ruta no encontrada');
  const statuses = route.stop_statuses || {};
  const terminal = ['entregado', 'cancelled', 'postponed', 'not_delivered'];
  const members = jsonList(route.orders);
  const allDone = members.length > 0 && members.every(stop => terminal.includes(statuses[orderKey(stop)]));
  if (allDone) {
    await client.query('UPDATE delivery_routes SET status = $2, completed_at = NOW() WHERE id = $1', [Number(routeId), 'completed']);
  }
  return { route, allDone };
}

async function applyStopUpdate(req, res, id, stopKey) {
  const { status, paymentMethod, paymentCashAmount, paymentTransferAmount, note, extras, deliverAfter } = req.body;  // status: 'entregado' | 'cancelled' | 'pending' | 'postponed' | 'not_delivered'
  let cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  // Reprogramado: el cliente pidió que se le entregue otro día.
  const deliverDate = status === 'postponed' && /^\d{4}-\d{2}-\d{2}$/.test(String(deliverAfter || '')) ? deliverAfter : null;
  if (status === 'postponed' && !deliverDate)
    return res.status(400).json({ success: false, error: 'Para reprogramar hay que indicar la fecha (deliverAfter = YYYY-MM-DD)' });
  if (deliverDate) {
    const [y, m, d] = deliverDate.split('-');
    cleanNote = `📅 Reprogramado para el ${d}/${m}${cleanNote ? ` — ${cleanNote}` : ''}`.slice(0, 500);
  }
  // Venta extra del repartidor (bandejas extras). No toca el pedido original:
  // se guarda en stop_extras y suma al total a cobrar de esa entrega.
  const cleanExtras = Array.isArray(extras)
    ? extras.map(e => ({
        name:     String(e?.name || '').slice(0, 120),
        quantity: Math.max(0, parseInt(e?.quantity) || 0),
        price:    Math.max(0, Math.round(parseFloat(e?.price) || 0)),
      })).filter(e => e.name && e.quantity > 0).slice(0, 30)
    : [];
  let pool;
  let committed = false;

  const VALID = ['entregado', 'cancelled', 'pending', 'postponed', 'not_delivered'];
  if (!VALID.includes(status))
    return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${VALID.join(', ')}` });
  if (['cancelled', 'not_delivered'].includes(status) && !cleanNote)
    return res.status(400).json({ success: false, error: 'Indica el motivo para cerrar esta parada' });

  const VALID_PAYMENT = ['efectivo', 'transferencia', 'mixto', 'otro'];
  if (paymentMethod && !VALID_PAYMENT.includes(paymentMethod))
    return res.status(400).json({ success: false, error: `Medio de pago inválido. Opciones: ${VALID_PAYMENT.join(', ')}` });

  // Un repartidor solo puede tocar rutas asignadas a él (o sin asignar).
  // Admin/supervisor pueden corregir cualquier ruta desde la web.
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;

  try {
    pool = await getPool().connect();
    await pool.query('BEGIN');
    const { rows: [owned] } = await pool.query(
      "SELECT * FROM delivery_routes WHERE id = $1 AND organization_id = $2 AND ($3::int IS NULL OR driver_user_id = $3 OR driver_user_id IS NULL) FOR UPDATE",
      [Number(id), req.orgId, driverScope]);
    if (!owned) throw Object.assign(new Error('Ruta no encontrada o no asignada a ti'), { status: 404 });
    if (owned.status !== 'in_progress') throw Object.assign(new Error('Completa la consolidación de carga e inicia la ruta antes de atender pedidos'), { status: 409 });
    const members = Array.isArray(owned.orders) ? owned.orders : JSON.parse(owned.orders || '[]');
    if (!members.some(o => String(o.source) + '_' + String(o.id) === stopKey)) throw Object.assign(new Error('El pedido no pertenece a la ruta'), { status: 404 });
    const [kind, orderKey] = splitStopKey(stopKey);
    if (kind === 'return') {
      const outcome = await applyReturnRouteStop(pool, {
        owned, routeId: id, stopKey, returnId: orderKey, orgId: req.orgId, userId: req.userId,
        status, paymentMethod, note: cleanNote, deliverDate,
      });
      await pool.query('COMMIT');
      committed = true;
      pool.release();
      pool = null;
      return res.json({
        success: true,
        stopStatuses: outcome.route.stop_statuses,
        stopPayments: {},
        stopPaymentAmounts: {},
        routeStatus: outcome.allDone ? 'completed' : 'in_progress',
        autoCharge: null,
      });
    }
    if (!['bot', 'shopify'].includes(kind)) throw Object.assign(new Error('Pedido inválido'), { status: 400 });
    const table = kind === 'bot' ? 'orders' : 'shopify_orders';
    const column = kind === 'bot' ? 'id' : 'shopify_order_id';
    const order = await pool.query('SELECT total_price FROM ' + table + ' WHERE ' + column + ' = $1 AND organization_id = $2 FOR UPDATE', [kind === 'bot' ? Number(orderKey) : orderKey, req.orgId]);
    if (!order.rows.length) throw Object.assign(new Error('Pedido no encontrado'), { status: 404 });
    const deliveryTotal = Math.round((Number(order.rows[0].total_price) || 0) + cleanExtras.reduce((sum, e) => sum + e.price * e.quantity, 0));
    const breakdown = status === 'entregado'
      ? paymentBreakdown(paymentMethod, deliveryTotal, paymentCashAmount, paymentTransferAmount)
      : { cash: 0, transfer: 0 };
    const cashAmount = breakdown.cash || 0;
    const transferAmount = breakdown.transfer || 0;
    // Actualizar stop_statuses (y el medio de pago, si se entregó) en la ruta
    const paymentJson = status === 'entregado' && paymentMethod
      ? JSON.stringify({ [stopKey]: paymentMethod })
      : '{}';
    const paymentAmountsJson = status === 'entregado' && paymentMethod
      ? JSON.stringify({ [stopKey]: { cash: cashAmount, transfer: transferAmount } })
      : '{}';
    // Nota del repartidor por parada (se guarda si viene; si va vacía no borra la anterior)
    const noteJson = cleanNote ? JSON.stringify({ [stopKey]: cleanNote }) : '{}';
    // Venta extra por parada (solo se escribe si viene alguna)
    const extrasJson = cleanExtras.length ? JSON.stringify({ [stopKey]: cleanExtras }) : '{}';
    const { rows: [route] } = await pool.query(
      `UPDATE delivery_routes
          SET stop_statuses = stop_statuses || jsonb_build_object($1::text, $2::text),
              stop_payments = COALESCE(stop_payments, '{}'::jsonb) || $6::jsonb,
              stop_notes    = COALESCE(stop_notes, '{}'::jsonb) || $7::jsonb,
              stop_extras   = COALESCE(stop_extras, '{}'::jsonb) || $8::jsonb,
              stop_payment_amounts = COALESCE(stop_payment_amounts, '{}'::jsonb) || $9::jsonb,
              stop_times    = COALESCE(stop_times, '{}'::jsonb) || jsonb_build_object($1::text, to_jsonb(NOW()))
        WHERE id = $3 AND organization_id = $4
          AND ($5::int IS NULL OR driver_user_id = $5 OR driver_user_id IS NULL)
        RETURNING stop_statuses, stop_payments, stop_payment_amounts, stop_notes, stop_extras, orders`,
      [stopKey, status, parseInt(id), req.orgId, driverScope, paymentJson, noteJson, extrasJson, paymentAmountsJson]
    );
    if (!route) throw new Error('Ruta no encontrada');

    // Actualizar el estado real del pedido en la tabla correspondiente.
    // cancelled es una cancelación definitiva. postponed vuelve a por despachar.
    // not_delivered conserva el pedido, pero lo saca de "en camino" y deja una
    // incidencia visible para que el equipo pueda avisar y reprogramar.
    const [source, orderId] = splitStopKey(stopKey);
    const newOrderStatus = status === 'entregado' ? 'entregado'
                         : status === 'cancelled'  ? 'cancelled'
                         : status === 'postponed'  ? 'por_despachar'
                         : status === 'not_delivered' ? 'no_entregado'
                         : 'en_camino';
    const attemptStatus = status === 'cancelled' ? 'cancelado_definitivo'
                        : status === 'postponed' ? 'reprogramado'
                        : status === 'not_delivered' ? 'no_entregado'
                        : null;
    const savePayment = status === 'entregado' && !!paymentMethod;
    const wasDelivered = status === 'entregado';   // señal de entrega, independiente del pago
    // Pago en efectivo al entregar = el pedido queda pagado de inmediato.
    // (Transferencia queda "por cobrar" hasta que llegue el comprobante.)
    const paidByCash = status === 'entregado' && paymentMethod === 'efectivo';

    if (source === 'shopify') {
      // Shopify marca "pagado" con financial_status = 'paid'.
      await pool.query(
        `UPDATE shopify_orders
            SET crm_status = $1,
                payment_method    = CASE WHEN $4::boolean THEN $5 ELSE payment_method END,
                payment_cash_amount = CASE WHEN $4::boolean THEN $12 ELSE payment_cash_amount END,
                payment_transfer_amount = CASE WHEN $4::boolean THEN $13 ELSE payment_transfer_amount END,
                payment_marked_at = CASE WHEN $4::boolean THEN NOW() ELSE payment_marked_at END,
                financial_status  = CASE WHEN $6::boolean THEN 'paid' ELSE financial_status END,
                delivered_at      = CASE WHEN $9::boolean THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                last_attempt_at     = CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE last_attempt_at END,
                last_attempt_status = CASE WHEN $10::text IS NOT NULL THEN $10 ELSE last_attempt_status END,
                delivery_date     = CASE WHEN $7::date IS NOT NULL THEN $7::date ELSE delivery_date END,
                delivery_note     = CASE WHEN $7::date IS NOT NULL THEN $8
                                         WHEN $10::text IN ('cancelado_definitivo','no_entregado') AND $11::text <> '' THEN $11
                                         ELSE delivery_note END
          WHERE shopify_order_id = $2 AND organization_id = $3`,
        [newOrderStatus, orderId, req.orgId, savePayment, paymentMethod || null, paidByCash, deliverDate, deliverDate ? cleanNote : null, wasDelivered, attemptStatus, cleanNote, cashAmount, transferAmount]
      );
    } else if (source === 'bot') {
      // Pedidos del bot marcan "pagado" con status = 'paid' (igual que al
      // verificar un comprobante de transferencia). El pago manda sobre la
      // entrega: si ya estaba pagado (transferencia verificada antes), entregarlo
      // NO lo baja a 'entregado'. Efectivo al entregar = queda 'paid'.
      await pool.query(
        `UPDATE orders
            SET status = CASE
                           WHEN status = 'paid' AND $1 = 'entregado' THEN 'paid'
                           WHEN $6::boolean THEN 'paid'
                           ELSE $1
                         END,
                updated_at = NOW(),
                delivered_at      = CASE WHEN $9::boolean THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                last_attempt_at     = CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE last_attempt_at END,
                last_attempt_status = CASE WHEN $10::text IS NOT NULL THEN $10 ELSE last_attempt_status END,
                payment_method    = CASE WHEN $4::boolean THEN $5 ELSE payment_method END,
                payment_cash_amount = CASE WHEN $4::boolean THEN $12 ELSE payment_cash_amount END,
                payment_transfer_amount = CASE WHEN $4::boolean THEN $13 ELSE payment_transfer_amount END,
                payment_marked_at = CASE WHEN $4::boolean THEN NOW() ELSE payment_marked_at END,
                delivery_date     = CASE WHEN $7::date IS NOT NULL THEN $7::date ELSE delivery_date END,
                delivery_note     = CASE WHEN $7::date IS NOT NULL THEN $8
                                         WHEN $10::text IN ('cancelado_definitivo','no_entregado') AND $11::text <> '' THEN $11
                                         ELSE delivery_note END
          WHERE id = $2 AND organization_id = $3`,
        [newOrderStatus, parseInt(orderId), req.orgId, savePayment, paymentMethod || null, paidByCash, deliverDate, deliverDate ? cleanNote : null, wasDelivered, attemptStatus, cleanNote, cashAmount, transferAmount]
      );
    }

    // ── Venta extra: sumar a la orden y marcarla como modificada en reparto ──
    if (status === 'entregado' && cleanExtras.length) {
      await applyExtraToOrder(pool, source, orderId, req.orgId, cleanExtras);
    }

    // ── Cerrar el pedido agendado al entregar ─────────────────────────────
    // Si la conversación quedó en estado 'scheduled', el bot le sigue diciendo
    // al cliente que su pedido "está apartado" para una fecha que ya pasó.
    // La entrega o cancelación definitiva son el momento en que eso deja de ser cierto.
    if (status === 'entregado' || status === 'cancelled') {
      try {
        let convId = null;
        if (source === 'bot') {
          const { rows } = await pool.query(
            `SELECT conversation_id FROM orders WHERE id = $1 AND organization_id = $2`,
            [parseInt(orderId), req.orgId]
          );
          convId = rows[0]?.conversation_id || null;
        } else {
          // Shopify no guarda conversation_id: se cruza por teléfono normalizado
          // (conversations.phone_number ya viene sin '+' ni separadores).
          const { rows } = await pool.query(
            `SELECT c.id
               FROM shopify_orders s
               JOIN conversations c
                 ON c.organization_id = s.organization_id
                AND c.phone_number = regexp_replace(COALESCE(s.customer_phone, ''), '[^0-9]', '', 'g')
              WHERE s.shopify_order_id = $1 AND s.organization_id = $2
              LIMIT 1`,
            [orderId, req.orgId]
          );
          convId = rows[0]?.id || null;
        }

        if (convId) {
          const scheduledStatus = status === 'cancelled' ? 'cancelled' : 'sent';
          const { rowCount } = await pool.query(
            `UPDATE scheduled_orders
                SET status = $2,
                    sent_at = CASE WHEN $2 = 'sent' THEN COALESCE(sent_at, NOW()) ELSE sent_at END
              WHERE conversation_id = $1 AND status = 'pending'`,
            [convId, scheduledStatus]
          );
          const { rowCount: stateReset } = await pool.query(
            `UPDATE conversations
                SET pipeline_state = 'exploring', updated_at = NOW()
              WHERE id = $1 AND pipeline_state = 'scheduled'`,
            [convId]
          );
          if (rowCount || stateReset) {
            console.log(`[Delivery/stop] 📅 ${status === 'cancelled' ? 'Cancelación' : 'Entrega'} cierra agendado en conv ${convId} (${rowCount} agendado${rowCount === 1 ? '' : 's'}, estado ${stateReset ? 'reseteado' : 'sin cambio'})`);
          }
        }
      } catch (err) {
        throw err;
      }
    }

    // Si todos los pedidos están procesados → completar la ruta
    const orders     = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
    const statuses   = route.stop_statuses || {};
    const allDone    = orders.every(o => {
      const key = `${o.source}_${o.id}`;
      return ['entregado', 'cancelled', 'postponed', 'not_delivered'].includes(statuses[key]);
    });
    if (allDone && orders.length > 0) {
      await pool.query(
        `UPDATE delivery_routes SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [parseInt(id)]
      );
    }

    await pool.query('COMMIT');
    committed = true;
    pool.release();
    pool = null;

    // ── Cobro automático por transferencia ────────────────────────────────
    // Solo si la org lo activó (setting charge_settings.autoSendOnTransfer).
    // Apagado por defecto: hasta entonces el cobro se manda a mano desde el
    // tab "Por cobrar" del CRM. No bloquea la respuesta al repartidor — si el
    // envío falla, el pedido queda igual listado en el tab.
    let autoCharge = null;
    if (savePayment && ['transferencia', 'mixto'].includes(paymentMethod)) {
      try {
        const settings = await collection.getChargeSettings(req.orgId);
        if (settings.autoSendOnTransfer) {
          const order = await collection.getOrderForCharge(req.orgId, source, orderId);
          if (order) {
            const r = await collection.sendChargeRequest(req.orgId, order, { io });
            autoCharge = { attempted: true, ...r };
          } else {
            autoCharge = { attempted: false, reason: 'pedido_no_por_cobrar' };
          }
        }
      } catch (err) {
        console.error('[Delivery/stop] Cobro automático falló:', err.message);
        autoCharge = { attempted: true, ok: false, reason: 'error', error: err.message };
      }
    }

    res.json({
      success:       true,
      stopStatuses:  route.stop_statuses,
      stopPayments:  route.stop_payments || {},
      stopPaymentAmounts: route.stop_payment_amounts || {},
      routeStatus:   allDone && orders.length > 0 ? 'completed' : 'in_progress',
      autoCharge,
    });
  } catch (err) {
    if (pool && !committed) await pool.query('ROLLBACK');
    console.error('[Delivery/stop]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  } finally { pool?.release(); }
}

// ─── Resumen del día ─────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
  const pool = getPool();
  try {
    const { rows } = await pool.query(`
      SELECT status, COUNT(*) AS count
      FROM delivery_routes
      WHERE organization_id = $1 AND created_at::date = CURRENT_DATE
      GROUP BY status
    `, [req.orgId]);
    const counts = Object.fromEntries(rows.map(r => [r.status, parseInt(r.count)]));
    res.json({ success: true, summary: counts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Despachos realizados (por parada, para agrupar por día) ──────────
//
// PATCH /api/delivery/routes/:id/stop-payment
// Corrige a mano el medio de pago de una parada desde Despachos. En Despachos
// el pago mostrado sale de stop_payments de la RUTA (lo que marcó el repartidor),
// no de la tabla orders; por eso hay que escribirlo aquí para que el cambio se
// vea. La reconciliación de pago/cobranza del pedido la hace /orders/payment-method.
router.patch('/routes/:id/stop-payment', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { stopKey, paymentMethod, paymentCashAmount, paymentTransferAmount } = req.body;
  const VALID = ['efectivo', 'transferencia', 'mixto', 'otro', null];
  if (!stopKey || typeof stopKey !== 'string') {
    return res.status(400).json({ success: false, error: 'stopKey requerido' });
  }
  if (!VALID.includes(paymentMethod ?? null)) {
    return res.status(400).json({ success: false, error: 'Medio de pago inválido' });
  }
  try {
    const pool = getPool();
    const method = paymentMethod ?? null;
    const amounts = method ? { cash: Math.max(0, Math.round(Number(paymentCashAmount) || 0)), transfer: Math.max(0, Math.round(Number(paymentTransferAmount) || 0)) } : null;
    const { rowCount } = await pool.query(
      `UPDATE delivery_routes
          SET stop_payments = COALESCE(stop_payments, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb),
              stop_payment_amounts = COALESCE(stop_payment_amounts, '{}'::jsonb) || jsonb_build_object($1::text, $5::jsonb)
        WHERE id = $3 AND organization_id = $4`,
      [stopKey, JSON.stringify(method), parseInt(req.params.id), req.orgId, JSON.stringify(amounts)]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Delivery/stop-payment]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/delivery/dispatches?from=YYYY-MM-DD&to=YYYY-MM-DD&driver=<userId>
//
// Devuelve una fila por parada de las rutas del período, con el estado que
// dejó el repartidor, la hora (stop_times; si la ruta es anterior a esa
// columna, la hora de cierre/creación de la ruta), el medio de pago y la
// situación de cobranza del pedido (enviado / pendiente / pagado).
router.get('/dispatches', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const pool = getPool();
  const TZ = 'America/Santiago';
  const dayOf = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
  const today = dayOf(new Date());
  const from  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : dayOf(Date.now() - 6 * 86400000);
  const to    = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : today;
  const driverId = req.query.driver ? parseInt(req.query.driver) : null;

  try {
    // Rutas que pueden tener paradas en el rango (margen de 3 días por rutas largas)
    const { rows: routes } = await pool.query(`
      SELECT id, name, status, driver_name, driver_user_id, orders, optimized_route,
             stop_statuses, stop_payments, stop_payment_amounts, stop_notes, stop_extras, stop_times,
             created_at, sent_at, completed_at
        FROM delivery_routes
       WHERE organization_id = $1
         AND status NOT IN ('draft', 'cancelled')   -- una ruta cancelada no se repartió: sus paradas no cuentan
         AND created_at >= ($2::date - INTERVAL '3 days')
         AND created_at <  ($3::date + INTERVAL '1 day')
         AND ($4::int IS NULL OR driver_user_id = $4)
       ORDER BY created_at DESC`,
      [req.orgId, from, to, driverId]
    );

    // Pedidos referenciados → estado de pago/cobranza
    const botIds = new Set(), shopIds = new Set();
    for (const r of routes) for (const o of (r.orders || [])) (o.source === 'shopify' ? shopIds : botIds).add(String(o.id));
    const [botRows, shopRows, pending] = await Promise.all([
      botIds.size ? pool.query(
        `SELECT id::text AS id, status, payment_method, payment_cash_amount, payment_transfer_amount, charge_requested_at, charge_request_count, total_price, customer_phone,
                delivery_modified, customer_modified,
                 (SELECT pp.status FROM payment_proofs pp
                   WHERE pp.order_id = orders.id AND pp.organization_id = orders.organization_id
                   ORDER BY pp.created_at DESC LIMIT 1) AS proof_status,
                (SELECT m.status FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.whatsapp_message_id=orders.charge_message_id AND c.organization_id=orders.organization_id) AS charge_status,
                (SELECT m.delivery_error FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.whatsapp_message_id=orders.charge_message_id AND c.organization_id=orders.organization_id) AS charge_error
           FROM orders WHERE organization_id = $1 AND id = ANY($2::int[])`,
        [req.orgId, [...botIds].map(Number)]).then(r => r.rows) : [],
      shopIds.size ? pool.query(
        `SELECT shopify_order_id AS id, crm_status AS status, financial_status, payment_method, payment_cash_amount, payment_transfer_amount, charge_requested_at,
                charge_request_count, total_price, customer_phone, delivery_modified,
                 NULL::text AS proof_status,
                (SELECT m.status FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.whatsapp_message_id=shopify_orders.charge_message_id AND c.organization_id=shopify_orders.organization_id) AS charge_status,
                (SELECT m.delivery_error FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.whatsapp_message_id=shopify_orders.charge_message_id AND c.organization_id=shopify_orders.organization_id) AS charge_error
           FROM shopify_orders WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])`,
        [req.orgId, [...shopIds]]).then(r => r.rows) : [],
      collection.getPendingCharges(req.orgId).catch(() => []),
    ]);
    const botMap  = new Map(botRows.map(r => [r.id, r]));
    const shopMap = new Map(shopRows.map(r => [String(r.id), r]));
    const pendingSet = new Set(pending.map(p => `${p.source}_${p.id}`));
    const normalizePhone = value => String(value || '').replace(/\D/g, '');
    const phones = [...new Set([...botRows, ...shopRows].map(row => normalizePhone(row.customer_phone)).filter(Boolean))];
    const contactRows = phones.length
      ? (await pool.query(
          `SELECT regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') AS phone, client_type
             FROM contacts
            WHERE organization_id = $1
              AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])`,
          [req.orgId, phones]
        )).rows
      : [];
    const clientTypeByPhone = new Map(contactRows.map(row => [row.phone, row.client_type === 'empresa' ? 'empresa' : 'personal']));

    // Rutas canceladas: solo las paradas que alcanzaron a marcarse.
    const { rows: cancelledRoutes } = await pool.query(`
      SELECT id, name, status, driver_name, driver_user_id, orders, optimized_route,
             stop_statuses, stop_payments, stop_payment_amounts, stop_notes, stop_extras, stop_times,
             created_at, sent_at, completed_at
        FROM delivery_routes
       WHERE organization_id = $1 AND status = 'cancelled'
         AND stop_statuses IS NOT NULL AND stop_statuses::text <> '{}'
         AND created_at >= ($2::date - INTERVAL '3 days')
         AND created_at <  ($3::date + INTERVAL '1 day')
         AND ($4::int IS NULL OR driver_user_id = $4)`,
      [req.orgId, from, to, driverId]
    );
    for (const r of cancelledRoutes) r._onlyMarked = true;
    routes.push(...cancelledRoutes);

    const rows = [];
    for (const r of routes) {
      const stops = Array.isArray(r.optimized_route) && r.optimized_route.length ? r.optimized_route : (r.orders || []);
      const statuses = r.stop_statuses || {}, pays = r.stop_payments || {}, payAmounts = r.stop_payment_amounts || {}, notes = r.stop_notes || {};
      const extras = r.stop_extras || {}, times = r.stop_times || {};
      const routeFallbackTime = r.completed_at || r.sent_at || r.created_at;

      for (const st of stops) {
        const key    = `${st.source}_${st.id}`;
        const status = statuses[key] || 'pending';
        if (r._onlyMarked && status === 'pending') continue;   // ruta cancelada: lo no marcado no ocurrió
        const at     = times[key] || (status !== 'pending' ? routeFallbackTime : (r.sent_at || r.created_at));
        const day    = dayOf(at);
        if (day < from || day > to) continue;

        const ord = st.source === 'shopify' ? shopMap.get(String(st.id)) : botMap.get(String(st.id));
        const paid = st.source === 'shopify'
          ? String(ord?.financial_status || '').toLowerCase() === 'paid'
          : ord?.status === 'paid';
        const paymentMethod = pays[key] || ord?.payment_method || null;
        const extraList = Array.isArray(extras[key]) ? extras[key] : [];
        const extraTotal = extraList.reduce((s, e) => s + (Number(e.price) || 0) * (Number(e.quantity) || 0), 0);
        const deliveredTotal = ord
          ? (Number(ord.total_price) || 0)
          : (Number(st.totalPrice) || 0) + extraTotal;
        const savedAmounts = payAmounts[key] || {};
        const paymentCash = Number(savedAmounts.cash ?? ord?.payment_cash_amount) || (paymentMethod === 'efectivo' ? deliveredTotal : 0);
        const paymentTransfer = Number(savedAmounts.transfer ?? ord?.payment_transfer_amount) || (paymentMethod === 'transferencia' ? deliveredTotal : 0);

        rows.push({
          day, at,
          route_id: r.id, route_name: r.name, route_status: r.status,
          driver_name: r.driver_name || null, driver_user_id: r.driver_user_id || null,
          stop_key: key, stop_number: st.stopNumber || null,
          source: st.source, order_id: String(st.id), order_label: st.orderName || `#${st.id}`,
          customer_name: st.customerName || null, phone: st.phone || ord?.customer_phone || null,
          client_type: clientTypeByPhone.get(normalizePhone(st.phone || ord?.customer_phone)) || 'personal',
          address: st.fullAddress || null,
          items: Array.isArray(st.items) ? st.items.map(i => ({ name: i.name || i.title, quantity: i.quantity })) : [],
          total: Number(ord?.total_price ?? st.totalPrice) || 0,
          extras: extraList, extra_total: extraTotal,
          note: notes[key] || null,
          status,                                   // entregado | cancelled | postponed | not_delivered | pending
          payment_method: paymentMethod,            // efectivo | transferencia | otro | null
          payment_cash_amount: paymentCash,
          payment_transfer_amount: paymentTransfer,
          paid,
          proof_status: ord?.proof_status || null,  // pending | pre_verified | verified | rejected
          charge: {
            sent_at: ['sent','delivered','read'].includes(ord?.charge_status) ? ord?.charge_requested_at : null,
            requested_at: ord?.charge_requested_at || null,
            status: ord?.charge_status || (ord?.charge_requested_at ? 'unknown' : null),
            error: ord?.charge_error || null,
            retryable: pendingSet.has(key) && (!ord?.charge_requested_at || ord?.charge_status === 'failed'),
            // Además de los nunca avisados/fallidos, permite recordar el pago
            // a quien recibió un aviso hace al menos 6 h y todavía no figura
            // pagado. Los envíos pending/sent/unknown deben verificarse antes.
            actionable: pendingSet.has(key) && (
              !ord?.charge_requested_at || ord?.charge_status === 'failed' ||
              (['delivered','read'].includes(ord?.charge_status) &&
                (Date.now() - new Date(ord.charge_requested_at).getTime()) >= collection.MIN_HOURS_BETWEEN_CHARGES * 3600000)
            ),
            count:   Number(ord?.charge_request_count) || 0,
            pending: pendingSet.has(key),           // sigue en "Por cobrar"
          },
          time_is_exact: !!times[key],
        });
      }
    }
    rows.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ success: true, from, to, rows });
  } catch (err) {
    console.error('[Delivery/dispatches]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;
