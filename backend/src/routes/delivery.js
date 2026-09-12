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
               crm_status
        FROM shopify_orders
        WHERE organization_id = $1
          AND (crm_status IS NULL OR crm_status NOT IN ('en_camino', 'entregado', 'cancelled'))
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

    // Si no se optimizó, igual guardar las paradas en orden de selección:
    // la app necesita optimized_route para mostrar algo.
    const stops = Array.isArray(optimizedRoute) && optimizedRoute.length > 0
      ? optimizedRoute
      : orders.map((o, i) => ({ ...o, stopNumber: i + 1 }));

    const { rows: [route] } = await pool.query(`
      INSERT INTO delivery_routes
        (organization_id, name, status, driver_name, driver_phone, driver_user_id,
         orders, optimized_route, total_distance, total_duration, maps_url, sent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      req.orgId, routeName, status, driver.driverName, driver.driverPhone, driver.driverUserId,
      JSON.stringify(orders),
      JSON.stringify(stops),
      totalDistance || null, totalDuration || null, mapsUrl || null,
      send ? new Date() : null,
    ]);

    // Si se envía, marcar los pedidos CRM como 'en_camino'
    if (send) {
      const shopifyIds = orders.filter(o => o.source === 'shopify').map(o => o.id);
      const botIds     = orders.filter(o => o.source === 'bot').map(o => parseInt(o.id));
      await Promise.all([
        shopifyIds.length && pool.query(
          `UPDATE shopify_orders SET crm_status = 'en_camino'
           WHERE organization_id = $1 AND shopify_order_id = ANY($2)`,
          [req.orgId, shopifyIds]
        ),
        botIds.length && pool.query(
          `UPDATE orders SET status = 'en_camino', updated_at = NOW()
           WHERE organization_id = $1 AND id = ANY($2)`,
          [req.orgId, botIds]
        ),
      ].filter(Boolean));
    }

    res.json({ success: true, route });
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
          `UPDATE shopify_orders SET crm_status = 'en_camino' WHERE organization_id = $1 AND shopify_order_id = ANY($2)`,
          [req.orgId, shopifyIds]
        ),
        botIds.length && pool.query(
          `UPDATE orders SET status = 'en_camino', updated_at = NOW() WHERE organization_id = $1 AND id = ANY($2)`,
          [req.orgId, botIds]
        ),
      ].filter(Boolean));
    }

    res.json({ success: true, route });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
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

async function applyStopUpdate(req, res, id, stopKey) {
  const { status, paymentMethod } = req.body;  // status: 'entregado' | 'cancelled' | 'pending'
  const pool = getPool();

  const VALID = ['entregado', 'cancelled', 'pending'];
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
    const { rows: [route] } = await pool.query(
      `UPDATE delivery_routes
          SET stop_statuses = stop_statuses || jsonb_build_object($1::text, $2::text),
              stop_payments = COALESCE(stop_payments, '{}'::jsonb) || $6::jsonb,
              status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END
        WHERE id = $3 AND organization_id = $4
          AND ($5::int IS NULL OR driver_user_id = $5 OR driver_user_id IS NULL)
        RETURNING stop_statuses, stop_payments, orders`,
      [stopKey, status, parseInt(id), req.orgId, driverScope, paymentJson]
    );
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada o no asignada a ti' });

    // Actualizar el estado real del pedido en la tabla correspondiente.
    // El medio de pago solo se guarda al entregar: en 'cancelled' o 'pending'
    // no hubo cobro, así que se deja como estaba.
    const [source, orderId] = splitStopKey(stopKey);
    const newOrderStatus = status === 'entregado' ? 'entregado'
                         : status === 'cancelled' ? 'cancelled'
                         : 'en_camino';
    const savePayment = status === 'entregado' && !!paymentMethod;
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
                financial_status  = CASE WHEN $6::boolean THEN 'paid' ELSE financial_status END
          WHERE shopify_order_id = $2 AND organization_id = $3`,
        [newOrderStatus, orderId, req.orgId, savePayment, paymentMethod || null, paidByCash]
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
                payment_method    = CASE WHEN $4::boolean THEN $5 ELSE payment_method END,
                payment_marked_at = CASE WHEN $4::boolean THEN NOW() ELSE payment_marked_at END
          WHERE id = $2 AND organization_id = $3`,
        [newOrderStatus, parseInt(orderId), req.orgId, savePayment, paymentMethod || null, paidByCash]
      );
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
      return statuses[key] === 'entregado' || statuses[key] === 'cancelled';
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

module.exports = router;
module.exports.setSocketIO = setSocketIO;
