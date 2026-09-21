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
const { requireAuth, requireRole } = require('../middleware/auth');

let io;
function setSocketIO(socketIO) { io = socketIO; }

router.use(requireAuth);

// ─── Geocodificación (dirección → lat/lng) ───────────────────────────────────
// Convierte direcciones en coordenadas para pintar el mapa. Usa la misma
// GOOGLE_MAPS_API_KEY que la optimización (Geocoding API) y cachea el resultado
// en geocode_cache para no pagar la misma dirección dos veces.

function addressKey(addr) {
  return (addr || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
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

// ─── ADMIN: Pedidos pendientes para seleccionar ──────────────────────────────

router.get('/orders', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const pool = getPool();
  try {
    const [shopifyRes, botRes] = await Promise.all([
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
          AND (crm_status IS NULL OR crm_status NOT IN ('en_camino', 'entregado', 'cancelled'))
          AND delivered_at IS NULL   -- ya se repartió: no vuelve a la lista
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
        LEFT JOIN contacts ct
          ON ct.organization_id = o.organization_id
         AND ct.phone = ANY(ARRAY[
               o.customer_phone,
               CASE WHEN o.customer_phone ~ '^569' THEN SUBSTRING(o.customer_phone FROM 3) END,
               CASE WHEN o.customer_phone ~ '^9'   THEN '56' || o.customer_phone END,
               CASE WHEN o.customer_phone ~ '^569' THEN '+' || o.customer_phone END
             ])
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
          AND (o.status IS NULL OR o.status NOT IN ('en_camino', 'entregado', 'cancelled'))
          AND o.delivered_at IS NULL   -- ya se repartió (aunque quede en 'paid'): no vuelve a la lista
        ORDER BY o.created_at ASC
      `, [req.orgId]),
    ]);
    const shopifyOrders = shopifyRes.rows.map(normalizeShopifyOrder);
    const botOrders     = botRes.rows.map(normalizeBotOrder);
    const orders        = [...shopifyOrders, ...botOrders];

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
      _debug: { shopify: shopifyOrders.length, bot: botOrders.length, botDetail: botDebug },
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

  let assign = new Array(n).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    // Asignar cada punto a su centro más cercano
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[i] = best;
    }
    // Recalcular centros
    const sum = Array.from({ length: k }, () => ({ lat: 0, lng: 0, n: 0 }));
    for (let i = 0; i < n; i++) { const c = assign[i]; sum[c].lat += points[i].lat; sum[c].lng += points[i].lng; sum[c].n++; }
    for (let c = 0; c < k; c++) if (sum[c].n > 0) centers[c] = { lat: sum[c].lat / sum[c].n, lng: sum[c].lng / sum[c].n };
  }

  // Balanceo: si un grupo supera el tamaño ideal (ceil(n/k)+1), mover sus puntos
  // más lejanos a grupos con espacio y centro cercano.
  const cap = Math.ceil(n / k) + 1;
  const groups = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) groups[assign[i]].push(i);
  for (let c = 0; c < k; c++) {
    while (groups[c].length > cap) {
      // punto más lejano del centro c
      groups[c].sort((a, b) => dist2(points[b], centers[c]) - dist2(points[a], centers[c]));
      const moved = groups[c].shift();
      // grupo con espacio y centro más cercano a ese punto
      let target = -1, tD = Infinity;
      for (let d = 0; d < k; d++) {
        if (d === c || groups[d].length >= cap) continue;
        const dd = dist2(points[moved], centers[d]);
        if (dd < tD) { tD = dd; target = d; }
      }
      if (target === -1) { groups[c].push(moved); break; } // no hay dónde, dejarlo
      groups[target].push(moved);
    }
  }
  return groups.filter(g => g.length > 0);
}

/** Optimiza UNA ruta round-trip (bodega → paradas → bodega) con Directions. */
async function optimizeOneRoute(stops, warehouse, apiKey) {
  // stops: array de pedidos (con fullAddress y, ojalá, lat/lng)
  const originStr = `${warehouse.lat},${warehouse.lng}`;
  const waypoints = stops.map(s =>
    (typeof s.lat === 'number' && typeof s.lng === 'number') ? `${s.lat},${s.lng}` : s.fullAddress
  );
  const waypointsParam = `optimize:true|${waypoints.join('|')}`;

  const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
    params: {
      origin: originStr, destination: originStr,   // ida y vuelta a la bodega
      waypoints: waypointsParam,
      key: apiKey, language: 'es', region: 'cl', mode: 'driving',
    },
    timeout: 12000,
  });
  if (data.status !== 'OK') throw new Error(`Google Maps: ${data.status} — ${data.error_message || ''}`);

  const routeData = data.routes[0];
  const order     = routeData.waypoint_order;   // orden óptimo de los waypoints
  const legs      = routeData.legs;
  const ordered   = order.map(i => stops[i]);

  const routeStops = ordered.map((stop, idx) => ({
    ...stop,
    stopNumber:   idx + 1,
    distanceText: legs[idx]?.distance?.text || '',
    durationText: legs[idx]?.duration?.text || '',
    lat: (typeof stop.lat === 'number' ? stop.lat : legs[idx]?.end_location?.lat) ?? null,
    lng: (typeof stop.lng === 'number' ? stop.lng : legs[idx]?.end_location?.lng) ?? null,
  }));

  const distM = legs.reduce((s, l) => s + (l.distance?.value || 0), 0);
  const durS  = legs.reduce((s, l) => s + (l.duration?.value  || 0), 0);
  const mapsUrl = `https://www.google.com/maps/dir/${encodeURIComponent(originStr)}/${routeStops.map(s => encodeURIComponent(s.fullAddress)).join('/')}/${encodeURIComponent(originStr)}`;

  return {
    stops:         routeStops,
    totalDistance: `${(distM / 1000).toFixed(1)} km`,
    totalDuration: `${Math.round(durS / 60)} min`,
    mapsUrl,
  };
}

// ─── ADMIN: Optimizar ruta(s) con Google Maps ────────────────────────────────
//
// Origen y destino = bodega (round trip). Con `vehicles` > 1 divide las paradas
// entre vehículos por cercanía y optimiza cada ruta por separado.
// Devuelve `routes: [{ vehicle, stops, totalDistance, totalDuration, mapsUrl }]`.

router.post('/optimize', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { orders, vehicles: vehiclesRaw } = req.body;
  const vehicles = Math.max(1, Math.min(parseInt(vehiclesRaw) || 1, 10));
  if (!orders || orders.length === 0)
    return res.status(400).json({ success: false, error: 'No hay pedidos para optimizar' });

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
      success: true, optimized: false, warehouse, routes,
      route: routes[0]?.stops || [],   // compat con clientes viejos
      warning: !warehouse
        ? 'Configura la dirección de la bodega en Ajustes para optimizar las rutas.'
        : 'Sin GOOGLE_MAPS_API_KEY — orden sin optimizar.',
    });
  }

  try {
    // Agrupar por cercanía. Solo se pueden clusterizar los que tienen coords.
    const located   = orders.filter(o => typeof o.lat === 'number' && typeof o.lng === 'number');
    const unlocated  = orders.filter(o => !(typeof o.lat === 'number' && typeof o.lng === 'number'));
    const k = Math.min(vehicles, Math.max(1, located.length));
    const groups = located.length ? kmeansBalanced(located, k) : [[]];

    // Repartir los sin-coords entre los grupos (round-robin) para no perderlos
    unlocated.forEach((o, i) => { (groups[i % groups.length] || groups[0]).push(orders.indexOf(o)); });
    // Nota: kmeansBalanced devuelve índices sobre `located`; normalizamos a objetos
    const groupsAsObjs = groups.map(g =>
      g.map(idx => (typeof idx === 'number' && idx < located.length ? located[idx] : orders[idx])).filter(Boolean)
    );

    const routes = [];
    for (let v = 0; v < groupsAsObjs.length; v++) {
      const stops = groupsAsObjs[v];
      if (!stops.length) continue;
      if (stops.length === 1) {
        routes.push({ vehicle: v + 1, stops: [{ ...stops[0], stopNumber: 1 }], totalDistance: '', totalDuration: '', mapsUrl: null });
        continue;
      }
      try {
        const r = await optimizeOneRoute(stops, warehouse, apiKey);
        routes.push({ vehicle: v + 1, ...r });
      } catch (e) {
        console.error(`[Delivery/optimize] vehículo ${v + 1}:`, e.message);
        routes.push({ vehicle: v + 1, stops: stops.map((o, i) => ({ ...o, stopNumber: i + 1 })), totalDistance: '', totalDuration: '', mapsUrl: null, error: e.message });
      }
    }

    res.json({
      success: true, optimized: true, warehouse, vehicles: routes.length, routes,
      route: routes[0]?.stops || [],   // compat con clientes viejos
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
                        created_at, sent_at, completed_at,
                        jsonb_array_length(orders) AS order_count,
                        orders, stop_statuses, stop_payments
                 FROM delivery_routes
                 WHERE organization_id = $1`;
    const params = [req.orgId];
    if (status) { query += ` AND status = $${params.length + 1}`; params.push(status); }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const { rows } = await pool.query(query, params);
    res.json({ success: true, routes: rows });
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
    res.json({ success: true, route });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
       WHERE u.organization_id = $1 AND u.role IN ('repartidor', 'coordinador')
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
    const { amount, category, note, routeId, photoBase64, photoMime } = req.body;
    const amt = Math.round(parseFloat(amount) || 0);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Monto inválido' });
    let photoBuf = null;
    if (photoBase64) {
      photoBuf = Buffer.from(String(photoBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (photoBuf.length > 9 * 1024 * 1024) return res.status(400).json({ success: false, error: 'La foto es muy pesada' });
    }
    let driverName = null;
    try { const u = await db.getUserById(req.userId); driverName = u?.name || u?.email || null; } catch {}
    const { rows: [row] } = await pool.query(
      `INSERT INTO delivery_expenses
         (organization_id, route_id, driver_user_id, driver_name, amount, category, note, photo, photo_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [req.orgId, routeId ? parseInt(routeId) : null, req.userId, driverName, amt,
       (category || '').slice(0, 40), (note || '').slice(0, 300),
       photoBuf, photoBuf ? (photoMime || 'image/jpeg') : null]
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
    const own = req.role === 'repartidor';
    const params = [req.orgId];
    let where = 'organization_id = $1';
    if (own) { params.push(req.userId); where += ` AND driver_user_id = $${params.length}`; }
    if (req.query.from) { params.push(req.query.from); where += ` AND created_at >= $${params.length}`; }
    if (req.query.to)   { params.push(req.query.to + ' 23:59:59'); where += ` AND created_at <= $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT id, route_id, driver_user_id, driver_name, amount, category, note,
              (photo IS NOT NULL) AS has_photo, created_at
         FROM delivery_expenses WHERE ${where}
        ORDER BY created_at DESC LIMIT 500`, params);
    const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
    res.json({ success: true, expenses: rows, total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
async function partitionDispatchable(pool, orgId, orders) {
  const list = Array.isArray(orders) ? orders : [];
  const botIds  = list.filter(o => o.source === 'bot').map(o => parseInt(o.id)).filter(Number.isFinite);
  const shopIds = list.filter(o => o.source === 'shopify').map(o => String(o.id));
  const done = new Set();
  if (botIds.length) {
    const { rows } = await pool.query(
      `SELECT id::text AS id FROM orders
        WHERE organization_id = $1 AND id = ANY($2::int[])
          AND (delivered_at IS NOT NULL OR status IN ('entregado', 'cancelled', 'paid'))`,
      [orgId, botIds]
    );
    rows.forEach(r => done.add('bot_' + r.id));
  }
  if (shopIds.length) {
    const { rows } = await pool.query(
      `SELECT shopify_order_id AS id FROM shopify_orders
        WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])
          AND (delivered_at IS NOT NULL OR crm_status IN ('entregado', 'cancelled'))`,
      [orgId, shopIds]
    );
    rows.forEach(r => done.add('shopify_' + r.id));
  }
  const keep = [], skip = [];
  for (const o of list) (done.has(`${o.source}_${o.id}`) ? skip : keep).push(o);
  return { keep, skip };
}

/** Deja solo las paradas cuyos pedidos siguen en `keep`, renumerando el orden. */
function filterStops(stops, keepOrders) {
  const keepSet = new Set(keepOrders.map(o => `${o.source}_${o.id}`));
  return (Array.isArray(stops) ? stops : [])
    .filter(s => keepSet.has(`${s.source}_${s.id}`))
    .map((s, i) => ({ ...s, stopNumber: i + 1 }));
}

/**
 * Resuelve el repartidor asignado: valida que el usuario exista en la org con
 * rol repartidor y completa nombre/teléfono si el admin no los escribió.
 */
async function resolveDriver(pool, orgId, { driverUserId, driverName, driverPhone }) {
  if (!driverUserId) return { driverUserId: null, driverName: driverName || null, driverPhone: driverPhone || null };
  const { rows: [u] } = await pool.query(
    `SELECT id, name, email, whatsapp_phone FROM users
      WHERE id = $1 AND organization_id = $2 AND role IN ('repartidor', 'coordinador')`,
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

  try {
    const driver = await resolveDriver(pool, req.orgId, { driverUserId, driverName, driverPhone });

    // Al ENVIAR, sacar los pedidos que ya no corresponde repartir (entregados,
    // pagados, cancelados). En borrador se guardan todos como se seleccionaron.
    let finalOrders = orders;
    let skipped = [];
    if (send) {
      const part = await partitionDispatchable(pool, req.orgId, orders);
      finalOrders = part.keep;
      skipped = part.skip;
      if (finalOrders.length === 0)
        return res.status(400).json({ success: false, error: 'Todos los pedidos de esta ruta ya fueron entregados o cancelados.', skipped });
    }

    // Si no se optimizó, igual guardar las paradas en orden de selección:
    // la app necesita optimized_route para mostrar algo.
    const stopsBase = Array.isArray(optimizedRoute) && optimizedRoute.length > 0
      ? optimizedRoute
      : finalOrders.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    const stops = send ? filterStops(stopsBase, finalOrders) : stopsBase;

    const { rows: [route] } = await pool.query(`
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
      send ? new Date() : null,
    ]);

    // Si se envía, marcar los pedidos CRM como 'en_camino' (solo los que quedaron)
    if (send) {
      const shopifyIds = finalOrders.filter(o => o.source === 'shopify').map(o => o.id);
      const botIds     = finalOrders.filter(o => o.source === 'bot').map(o => parseInt(o.id));
      await Promise.all([
        shopifyIds.length && pool.query(
          `UPDATE shopify_orders SET crm_status = 'en_camino',
                  dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
           WHERE organization_id = $1 AND shopify_order_id = ANY($2)`,
          [req.orgId, shopifyIds]
        ),
        botIds.length && pool.query(
          `UPDATE orders SET status = 'en_camino', updated_at = NOW(),
                  dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
           WHERE organization_id = $1 AND id = ANY($2)`,
          [req.orgId, botIds]
        ),
      ].filter(Boolean));
    }

    if (skipped.length) console.log(`[Delivery/routes POST] ⏭️ ${skipped.length} pedido(s) ya entregados omitidos al enviar`);
    res.json({ success: true, route, skipped });
  } catch (err) {
    console.error('[Delivery/routes POST]', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Actualizar ruta (enviar, cancelar, cambiar datos) ────────────────

router.patch('/routes/:id', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const { id } = req.params;
  const { status, driverName, driverPhone, driverUserId, name } = req.body;
  const pool = getPool();

  const VALID = ['draft', 'sent', 'in_progress', 'completed', 'cancelled'];
  if (status && !VALID.includes(status))
    return res.status(400).json({ success: false, error: 'Estado inválido' });

  try {
    // Al enviar un borrador: sacar los pedidos que ya no corresponde repartir.
    let skipped = [];
    if (status === 'sent') {
      const { rows: [cur] } = await pool.query(
        `SELECT orders, optimized_route FROM delivery_routes WHERE id = $1 AND organization_id = $2`,
        [parseInt(id), req.orgId]
      );
      if (cur) {
        const curOrders = Array.isArray(cur.orders) ? cur.orders : JSON.parse(cur.orders || '[]');
        const part = await partitionDispatchable(pool, req.orgId, curOrders);
        skipped = part.skip;
        if (part.keep.length === 0)
          return res.status(400).json({ success: false, error: 'Todos los pedidos de esta ruta ya fueron entregados o cancelados.', skipped });
        if (skipped.length) {
          const curStops = Array.isArray(cur.optimized_route) ? cur.optimized_route : JSON.parse(cur.optimized_route || '[]');
          await pool.query(
            `UPDATE delivery_routes SET orders = $3, optimized_route = $4 WHERE id = $1 AND organization_id = $2`,
            [parseInt(id), req.orgId, JSON.stringify(part.keep), JSON.stringify(filterStops(curStops, part.keep))]
          );
          console.log(`[Delivery/routes PATCH] ⏭️ ${skipped.length} pedido(s) ya entregados omitidos al enviar ruta ${id}`);
        }
      }
    }

    const sets = []; const params = [req.orgId, parseInt(id)];
    if (status)      { sets.push(`status = $${params.length + 1}`); params.push(status); }
    if (driverUserId !== undefined) {
      // Reasignar (o desasignar con null). Completa nombre/teléfono desde el usuario.
      const driver = await resolveDriver(pool, req.orgId, { driverUserId, driverName, driverPhone });
      sets.push(`driver_user_id = $${params.length + 1}`); params.push(driver.driverUserId);
      sets.push(`driver_name = $${params.length + 1}`);    params.push(driver.driverName);
      sets.push(`driver_phone = $${params.length + 1}`);   params.push(driver.driverPhone);
    } else {
      if (driverName !== undefined) { sets.push(`driver_name = $${params.length + 1}`); params.push(driverName || null); }
      if (driverPhone !== undefined) { sets.push(`driver_phone = $${params.length + 1}`); params.push(driverPhone || null); }
    }
    if (name)        { sets.push(`name = $${params.length + 1}`); params.push(name); }
    if (status === 'sent') { sets.push(`sent_at = NOW()`); }
    if (status === 'completed') { sets.push(`completed_at = NOW()`); }
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'Nada que actualizar' });

    const { rows: [route] } = await pool.query(
      `UPDATE delivery_routes SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2 RETURNING *`,
      params
    );
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });

    // Al enviar, marcar pedidos como en_camino
    if (status === 'sent' && route.orders) {
      const orders    = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders);
      const shopifyIds = orders.filter(o => o.source === 'shopify').map(o => o.id);
      const botIds     = orders.filter(o => o.source === 'bot').map(o => parseInt(o.id));
      await Promise.all([
        shopifyIds.length && pool.query(
          `UPDATE shopify_orders SET crm_status = 'en_camino',
                  dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
             WHERE organization_id = $1 AND shopify_order_id = ANY($2)`,
          [req.orgId, shopifyIds]
        ),
        botIds.length && pool.query(
          `UPDATE orders SET status = 'en_camino', updated_at = NOW(),
                  dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
             WHERE organization_id = $1 AND id = ANY($2)`,
          [req.orgId, botIds]
        ),
      ].filter(Boolean));
    }

    // Al cancelar la ruta: los pedidos que iban EN CAMINO y no alcanzaron a
    // entregarse vuelven a 'por_despachar' para poder salir en otra ruta. No se
    // tocan los que ya se entregaron/pagaron (delivered_at o estado cerrado).
    if (status === 'cancelled' && route.orders) {
      const cOrders   = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders);
      const shopifyIds = cOrders.filter(o => o.source === 'shopify').map(o => o.id);
      const botIds     = cOrders.filter(o => o.source === 'bot').map(o => parseInt(o.id));
      const restored = await Promise.all([
        shopifyIds.length && pool.query(
          `UPDATE shopify_orders SET crm_status = 'por_despachar'
             WHERE organization_id = $1 AND shopify_order_id = ANY($2)
               AND crm_status = 'en_camino' AND delivered_at IS NULL
           RETURNING shopify_order_id`,
          [req.orgId, shopifyIds]
        ),
        botIds.length && pool.query(
          `UPDATE orders SET status = 'por_despachar', updated_at = NOW()
             WHERE organization_id = $1 AND id = ANY($2)
               AND status = 'en_camino' AND delivered_at IS NULL
           RETURNING id`,
          [req.orgId, botIds]
        ),
      ].filter(Boolean));
      const nBack = restored.reduce((a, r) => a + (r && r.rowCount ? r.rowCount : 0), 0);
      console.log(`[Delivery/routes PATCH] ruta ${id} cancelada, ${nBack} pedido(s) devueltos a por_despachar`);
    }
    res.json({ success: true, route, skipped });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Devolver los pedidos de una ruta cancelada a "por despachar" ───
//
// POST /api/delivery/routes/:id/release
//
// Para rutas ya canceladas cuyos pedidos quedaron atascados en 'en_camino'
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
    const shopifyIds = orders.filter(o => o.source === 'shopify').map(o => o.id);
    const botIds     = orders.filter(o => o.source === 'bot').map(o => parseInt(o.id));
    const restored = await Promise.all([
      shopifyIds.length && pool.query(
        `UPDATE shopify_orders SET crm_status = 'por_despachar'
           WHERE organization_id = $1 AND shopify_order_id = ANY($2)
             AND crm_status = 'en_camino' AND delivered_at IS NULL
         RETURNING shopify_order_id`,
        [req.orgId, shopifyIds]
      ),
      botIds.length && pool.query(
        `UPDATE orders SET status = 'por_despachar', updated_at = NOW()
           WHERE organization_id = $1 AND id = ANY($2)
             AND status = 'en_camino' AND delivered_at IS NULL
         RETURNING id`,
        [req.orgId, botIds]
      ),
    ].filter(Boolean));
    const restored_count = restored.reduce((a, r) => a + (r && r.rowCount ? r.rowCount : 0), 0);
    res.json({ success: true, restored: restored_count });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Agregar pedidos a una ruta ya creada ─────────────────────────────
//
// POST /api/delivery/routes/:id/orders   body: { orders: [ {source,id,...} ] }
//
// Agrega paradas al final de una ruta existente (borrador, enviada o en curso).
// Si la ruta ya salió (sent/in_progress), los pedidos nuevos se marcan
// 'en_camino' al toque. No re-optimiza: van al final del recorrido.
router.post('/routes/:id/orders', requireRole('owner', 'admin', 'supervisor', 'coordinador'), async (req, res) => {
  const pool = getPool();
  const { orders } = req.body;
  if (!Array.isArray(orders) || orders.length === 0)
    return res.status(400).json({ success: false, error: 'No hay pedidos para agregar' });
  try {
    const { rows: [route] } = await pool.query(
      `SELECT * FROM delivery_routes WHERE id = $1 AND organization_id = $2`,
      [parseInt(req.params.id), req.orgId]
    );
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });
    if (['completed', 'cancelled'].includes(route.status))
      return res.status(400).json({ success: false, error: 'No se pueden agregar pedidos a una ruta cerrada. Crea una ruta nueva.' });

    const cur      = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
    const curStops = Array.isArray(route.optimized_route) ? route.optimized_route : JSON.parse(route.optimized_route || '[]');
    const existing = new Set(cur.map(o => `${o.source}_${o.id}`));
    const toAdd    = orders.filter(o => o && o.source && o.id != null && !existing.has(`${o.source}_${o.id}`));
    if (!toAdd.length) return res.json({ success: true, added: 0, route });

    const newOrders = [...cur, ...toAdd];
    const baseStops = curStops.length ? curStops : cur.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    const newStops  = [...baseStops, ...toAdd.map((o, i) => ({ ...o, stopNumber: baseStops.length + i + 1 }))];

    await pool.query(
      `UPDATE delivery_routes SET orders = $3, optimized_route = $4 WHERE id = $1 AND organization_id = $2`,
      [route.id, req.orgId, JSON.stringify(newOrders), JSON.stringify(newStops)]
    );

    // Si la ruta ya está en la calle, los nuevos salen 'en_camino' de inmediato.
    if (['sent', 'in_progress'].includes(route.status)) {
      const shopIds = toAdd.filter(o => o.source === 'shopify').map(o => o.id);
      const botIds  = toAdd.filter(o => o.source === 'bot').map(o => parseInt(o.id));
      await Promise.all([
        shopIds.length && pool.query(
          `UPDATE shopify_orders SET crm_status = 'en_camino',
                  dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
             WHERE organization_id = $1 AND shopify_order_id = ANY($2)`,
          [req.orgId, shopIds]
        ),
        botIds.length && pool.query(
          `UPDATE orders SET status = 'en_camino', updated_at = NOW(),
                  dispatch_count = COALESCE(dispatch_count, 0) + 1, last_attempt_at = NOW()
             WHERE organization_id = $1 AND id = ANY($2)`,
          [req.orgId, botIds]
        ),
      ].filter(Boolean));
    }

    const { rows: [updated] } = await pool.query(
      `SELECT * FROM delivery_routes WHERE id = $1 AND organization_id = $2`,
      [route.id, req.orgId]
    );
    console.log(`[Delivery/routes ADD] ✅ ${toAdd.length} pedido(s) agregados a ruta ${route.id} (${route.status})`);
    res.json({ success: true, added: toAdd.length, route: updated });
  } catch (err) {
    console.error('[Delivery/routes ADD]', err.message);
    res.status(500).json({ success: false, error: err.message });
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

router.patch('/routes/:id/stops', (req, res) => {
  const stopKey = req.body?.stopKey;
  if (!stopKey || typeof stopKey !== 'string')
    return res.status(400).json({ success: false, error: 'Falta stopKey en el body' });
  return applyStopUpdate(req, res, req.params.id, stopKey);
});

router.patch('/routes/:id/stops/:stopKey', (req, res) => {
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

async function applyStopUpdate(req, res, id, stopKey) {
  const { status, paymentMethod, note, extras, deliverAfter } = req.body;  // status: 'entregado' | 'cancelled' | 'pending' | 'postponed'
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
  const pool = getPool();

  const VALID = ['entregado', 'cancelled', 'pending', 'postponed'];
  if (!VALID.includes(status))
    return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${VALID.join(', ')}` });

  const VALID_PAYMENT = ['efectivo', 'transferencia', 'otro'];
  if (paymentMethod && !VALID_PAYMENT.includes(paymentMethod))
    return res.status(400).json({ success: false, error: `Medio de pago inválido. Opciones: ${VALID_PAYMENT.join(', ')}` });

  // Un repartidor solo puede tocar rutas asignadas a él (o sin asignar).
  // Admin/supervisor pueden corregir cualquier ruta desde la web.
  const driverScope = ['repartidor', 'coordinador'].includes(req.role) ? req.userId : null;

  try {
    // Actualizar stop_statuses (y el medio de pago, si se entregó) en la ruta
    const paymentJson = status === 'entregado' && paymentMethod
      ? JSON.stringify({ [stopKey]: paymentMethod })
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
              stop_times    = COALESCE(stop_times, '{}'::jsonb) || jsonb_build_object($1::text, to_jsonb(NOW())),
              status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END
        WHERE id = $3 AND organization_id = $4
          AND ($5::int IS NULL OR driver_user_id = $5 OR driver_user_id IS NULL)
        RETURNING stop_statuses, stop_payments, stop_notes, stop_extras, orders`,
      [stopKey, status, parseInt(id), req.orgId, driverScope, paymentJson, noteJson, extrasJson]
    );
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada o no asignada a ti' });

    // Actualizar el estado real del pedido en la tabla correspondiente.
    // El medio de pago solo se guarda al entregar: en 'cancelled' o 'pending'
    // no hubo cobro, así que se deja como estaba.
    const [source, orderId] = splitStopKey(stopKey);
    // "Fallido" (cancelled) y "Reprogramado" (postponed) NO matan el pedido:
    // vuelve a 'por_despachar' para salir de nuevo. Solo se anota que hubo un
    // intento fallido. Una cancelación real la hace el admin/bot, no el
    // repartidor. 'pending' (desmarcar) lo deja en_camino.
    const isFailedAttempt = status === 'cancelled' || status === 'postponed';
    const newOrderStatus = status === 'entregado' ? 'entregado'
                         : isFailedAttempt         ? 'por_despachar'   // vuelve a la lista para otra ruta
                         : 'en_camino';
    const attemptStatus = status === 'cancelled' ? 'fallido' : status === 'postponed' ? 'reprogramado' : null;
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
                payment_marked_at = CASE WHEN $4::boolean THEN NOW() ELSE payment_marked_at END,
                financial_status  = CASE WHEN $6::boolean THEN 'paid' ELSE financial_status END,
                delivered_at      = CASE WHEN $9::boolean THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                last_attempt_at     = CASE WHEN $10::text IS NOT NULL THEN NOW() ELSE last_attempt_at END,
                last_attempt_status = CASE WHEN $10::text IS NOT NULL THEN $10 ELSE last_attempt_status END,
                delivery_date     = CASE WHEN $7::date IS NOT NULL THEN $7::date ELSE delivery_date END,
                delivery_note     = CASE WHEN $7::date IS NOT NULL THEN $8
                                         WHEN $10::text = 'fallido' AND $11::text <> '' THEN $11
                                         ELSE delivery_note END
          WHERE shopify_order_id = $2 AND organization_id = $3`,
        [newOrderStatus, orderId, req.orgId, savePayment, paymentMethod || null, paidByCash, deliverDate, deliverDate ? cleanNote : null, wasDelivered, attemptStatus, cleanNote]
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
                payment_marked_at = CASE WHEN $4::boolean THEN NOW() ELSE payment_marked_at END,
                delivery_date     = CASE WHEN $7::date IS NOT NULL THEN $7::date ELSE delivery_date END,
                delivery_note     = CASE WHEN $7::date IS NOT NULL THEN $8
                                         WHEN $10::text = 'fallido' AND $11::text <> '' THEN $11
                                         ELSE delivery_note END
          WHERE id = $2 AND organization_id = $3`,
        [newOrderStatus, parseInt(orderId), req.orgId, savePayment, paymentMethod || null, paidByCash, deliverDate, deliverDate ? cleanNote : null, wasDelivered, attemptStatus, cleanNote]
      );
    }

    // ── Venta extra: sumar a la orden y marcarla como modificada en reparto ──
    if (status === 'entregado' && cleanExtras.length) {
      try { await applyExtraToOrder(pool, source, orderId, req.orgId, cleanExtras); }
      catch (e) { console.error('[Delivery/extra]', e.message); }
    }

    // ── Cerrar el pedido agendado al entregar ─────────────────────────────
    // Si la conversación quedó en estado 'scheduled', el bot le sigue diciendo
    // al cliente que su pedido "está apartado" para una fecha que ya pasó.
    // La entrega es el momento en que eso deja de ser cierto.
    if (status === 'entregado') {
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
          const { rowCount } = await pool.query(
            `UPDATE scheduled_orders
                SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
              WHERE conversation_id = $1 AND status = 'pending'`,
            [convId]
          );
          const { rowCount: stateReset } = await pool.query(
            `UPDATE conversations
                SET pipeline_state = 'exploring', updated_at = NOW()
              WHERE id = $1 AND pipeline_state = 'scheduled'`,
            [convId]
          );
          if (rowCount || stateReset) {
            console.log(`[Delivery/stop] 📅 Entrega cierra agendado en conv ${convId} (${rowCount} agendado${rowCount === 1 ? '' : 's'}, estado ${stateReset ? 'reseteado' : 'sin cambio'})`);
          }
        }
      } catch (err) {
        // Cosmético: no debe impedir que la parada quede marcada como entregada
        console.error('[Delivery/stop] No se pudo cerrar el pedido agendado:', err.message);
      }
    }

    // ── Cobro automático por transferencia ────────────────────────────────
    // Solo si la org lo activó (setting charge_settings.autoSendOnTransfer).
    // Apagado por defecto: hasta entonces el cobro se manda a mano desde el
    // tab "Por cobrar" del CRM. No bloquea la respuesta al repartidor — si el
    // envío falla, el pedido queda igual listado en el tab.
    let autoCharge = null;
    if (savePayment && paymentMethod === 'transferencia') {
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

    // Si todos los pedidos están procesados → completar la ruta
    const orders     = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
    const statuses   = route.stop_statuses || {};
    const allDone    = orders.every(o => {
      const key = `${o.source}_${o.id}`;
      return ['entregado', 'cancelled', 'postponed'].includes(statuses[key]);
    });
    if (allDone && orders.length > 0) {
      await pool.query(
        `UPDATE delivery_routes SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [parseInt(id)]
      );
    }

    res.json({
      success:       true,
      stopStatuses:  route.stop_statuses,
      stopPayments:  route.stop_payments || {},
      routeStatus:   allDone && orders.length > 0 ? 'completed' : 'in_progress',
      autoCharge,
    });
  } catch (err) {
    console.error('[Delivery/stop]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
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
             stop_statuses, stop_payments, stop_notes, stop_extras, stop_times,
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
        `SELECT id::text AS id, status, payment_method, charge_requested_at, charge_request_count, total_price, customer_phone,
                delivery_modified, customer_modified
           FROM orders WHERE organization_id = $1 AND id = ANY($2::int[])`,
        [req.orgId, [...botIds].map(Number)]).then(r => r.rows) : [],
      shopIds.size ? pool.query(
        `SELECT shopify_order_id AS id, crm_status AS status, financial_status, payment_method, charge_requested_at,
                charge_request_count, total_price, customer_phone, delivery_modified
           FROM shopify_orders WHERE organization_id = $1 AND shopify_order_id = ANY($2::text[])`,
        [req.orgId, [...shopIds]]).then(r => r.rows) : [],
      collection.getPendingCharges(req.orgId).catch(() => []),
    ]);
    const botMap  = new Map(botRows.map(r => [r.id, r]));
    const shopMap = new Map(shopRows.map(r => [String(r.id), r]));
    const pendingSet = new Set(pending.map(p => `${p.source}_${p.id}`));

    // Rutas canceladas: solo las paradas que alcanzaron a marcarse (entregado/fallido/reprogramado)
    const { rows: cancelledRoutes } = await pool.query(`
      SELECT id, name, status, driver_name, driver_user_id, orders, optimized_route,
             stop_statuses, stop_payments, stop_notes, stop_extras, stop_times,
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
      const statuses = r.stop_statuses || {}, pays = r.stop_payments || {}, notes = r.stop_notes || {};
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

        rows.push({
          day, at,
          route_id: r.id, route_name: r.name, route_status: r.status,
          driver_name: r.driver_name || null, driver_user_id: r.driver_user_id || null,
          stop_key: key, stop_number: st.stopNumber || null,
          source: st.source, order_id: String(st.id), order_label: st.orderName || `#${st.id}`,
          customer_name: st.customerName || null, phone: st.phone || ord?.customer_phone || null,
          address: st.fullAddress || null,
          items: Array.isArray(st.items) ? st.items.map(i => ({ name: i.name || i.title, quantity: i.quantity })) : [],
          total: Number(ord?.total_price ?? st.totalPrice) || 0,
          extras: extraList, extra_total: extraTotal,
          note: notes[key] || null,
          status,                                   // entregado | cancelled | pending
          payment_method: paymentMethod,            // efectivo | transferencia | otro | null
          paid,
          charge: {
            sent_at: ord?.charge_requested_at || null,
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
