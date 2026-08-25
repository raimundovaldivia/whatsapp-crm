/**
 * delivery.js — API para la app mobile del repartidor
 *
 * GET  /api/delivery/orders          → Pedidos pendientes de despachar (por_despachar + nuevo con dirección)
 * POST /api/delivery/optimize        → Optimiza la ruta usando Google Maps Directions API
 * PATCH /api/delivery/orders/:id/status → Marca un pedido como entregado, fallido, etc.
 * GET  /api/delivery/summary         → Resumen del día (entregados, pendientes, fallidos)
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { getPool } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ── Normalizar pedidos de Shopify ──────────────────────────────────────
function normalizeShopifyOrder(row) {
  let addr = {};
  try {
    addr = typeof row.shipping_address === 'string'
      ? JSON.parse(row.shipping_address)
      : (row.shipping_address || {});
  } catch (_) {}

  const street   = addr.address1 || addr.address || '';
  const city     = addr.city     || '';
  const fullAddr = [street, city].filter(Boolean).join(', ');

  let items = [];
  try {
    items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []);
  } catch (_) {}

  return {
    id:           row.id,
    source:       'shopify',
    orderName:    row.order_name || `#${row.id}`,
    customerName: row.customer_name || 'Sin nombre',
    phone:        row.phone || addr.phone || '',
    address:      street,
    city,
    fullAddress:  fullAddr,
    items,
    totalPrice:   parseFloat(row.total_price) || 0,
    status:       row.crm_status,
    lat:          null,
    lng:          null,
  };
}

// ── Normalizar pedidos del bot ─────────────────────────────────────────
function normalizeBotOrder(row) {
  let addr = {};
  try {
    addr = typeof row.shipping_address === 'string'
      ? JSON.parse(row.shipping_address)
      : (row.shipping_address || {});
  } catch (_) {}

  const street   = addr.address || addr.address1 || '';
  const city     = addr.city    || '';
  const fullAddr = [street, city].filter(Boolean).join(', ');

  let items = [];
  try {
    items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []);
  } catch (_) {}

  return {
    id:           String(row.id),
    source:       'bot',
    orderName:    `#BOT-${row.id}`,
    customerName: row.customer_name || 'Sin nombre',
    phone:        row.phone || '',
    address:      street,
    city,
    fullAddress:  fullAddr,
    items,
    totalPrice:   parseFloat(row.total_price) || 0,
    status:       row.crm_status,
    lat:          null,
    lng:          null,
  };
}

// ── GET /api/delivery/orders ───────────────────────────────────────────
router.get('/orders', async (req, res) => {
  const pool = getPool();
  try {
    const [shopifyRes, botRes] = await Promise.all([
      pool.query(`
        SELECT shopify_order_id AS id, order_name, customer_name,
               shipping_address, phone, items, total_price, crm_status
        FROM shopify_orders
        WHERE organization_id = $1 AND crm_status IN ('nuevo', 'por_despachar')
        ORDER BY synced_at ASC
      `, [req.orgId]),

      pool.query(`
        SELECT id, customer_name, shipping_address,
               customer_phone AS phone, items, total_price, status AS crm_status
        FROM orders
        WHERE organization_id = $1 AND status IN ('nuevo', 'por_despachar')
        ORDER BY created_at ASC
      `, [req.orgId]),
    ]);

    const orders = [
      ...shopifyRes.rows.map(normalizeShopifyOrder),
      ...botRes.rows.map(normalizeBotOrder),
    ].filter(o => o.fullAddress.trim().length > 3);   // solo pedidos con dirección

    res.json({ success: true, orders, total: orders.length });
  } catch (err) {
    console.error('[Delivery/orders]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/delivery/optimize ────────────────────────────────────────
// Body: { orders: [...], origin: "dirección" | { lat, lng } }
router.post('/optimize', async (req, res) => {
  const { orders, origin } = req.body;

  if (!orders || orders.length === 0) {
    return res.status(400).json({ success: false, error: 'No hay pedidos para optimizar' });
  }

  // Si solo hay 1 parada, no hace falta optimizar
  if (orders.length === 1) {
    return res.json({
      success:   true,
      optimized: false,
      route:     [{ ...orders[0], stopNumber: 1 }],
      totalDistance: '',
      totalDuration: '',
    });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn('[Delivery] GOOGLE_MAPS_API_KEY no configurada — ruta sin optimizar');
    const route = orders.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    return res.json({ success: true, optimized: false, route, warning: 'Sin clave de Google Maps — orden no optimizada' });
  }

  try {
    const originStr = origin && typeof origin === 'object' && origin.lat
      ? `${origin.lat},${origin.lng}`
      : (origin || orders[0].fullAddress);

    const addresses = orders.map(o => o.fullAddress);

    // Google Maps Directions API con optimize:true en waypoints
    const waypointAddresses = addresses.slice(0, -1);   // todos menos el último
    const destination       = addresses[addresses.length - 1];
    const waypointsParam    = `optimize:true|${waypointAddresses.join('|')}`;

    const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin:      originStr,
        destination,
        waypoints:   waypointsParam,
        key:         apiKey,
        language:    'es',
        region:      'cl',
        mode:        'driving',
      },
      timeout: 10000,
    });

    if (data.status !== 'OK') {
      throw new Error(`Google Maps: ${data.status} — ${data.error_message || ''}`);
    }

    const route_data = data.routes[0];
    const optimizedWaypointOrder = route_data.waypoint_order;
    const legs = route_data.legs;

    // Reconstruir el orden de paradas según Google Maps
    const reorderedWaypoints = optimizedWaypointOrder.map(i => orders[i]);
    const lastOrder = orders[orders.length - 1];
    const orderedStops = [...reorderedWaypoints, lastOrder];

    // Agregar coordenadas y tiempos de cada leg
    const route = orderedStops.map((stop, idx) => ({
      ...stop,
      stopNumber:   idx + 1,
      distanceText: legs[idx]?.distance?.text  || '',
      durationText: legs[idx]?.duration?.text  || '',
      // Coordenadas del destino de cada leg (posición de la parada)
      lat: legs[idx]?.end_location?.lat  ?? null,
      lng: legs[idx]?.end_location?.lng  ?? null,
    }));

    // Añadir coordenadas del punto de origen (primera parada en el mapa)
    if (legs[0]?.start_location) {
      route[0]._originLat = legs[0].start_location.lat;
      route[0]._originLng = legs[0].start_location.lng;
    }

    const totalDistanceM  = legs.reduce((s, l) => s + (l.distance?.value || 0), 0);
    const totalDurationS  = legs.reduce((s, l) => s + (l.duration?.value  || 0), 0);
    const totalDistance   = `${(totalDistanceM / 1000).toFixed(1)} km`;
    const totalDuration   = `${Math.round(totalDurationS / 60)} min`;

    // URL de Google Maps con todas las paradas
    const mapsUrl = `https://www.google.com/maps/dir/${encodeURIComponent(originStr)}/${route.map(s => encodeURIComponent(s.fullAddress)).join('/')}`;

    console.log(`[Delivery] Ruta optimizada: ${route.length} paradas, ${totalDistance}, ${totalDuration}`);

    res.json({ success: true, optimized: true, route, totalDistance, totalDuration, mapsUrl });

  } catch (err) {
    console.error('[Delivery/optimize]', err.message);
    // Fallback graceful: devolver sin optimizar
    const route = orders.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    res.json({ success: true, optimized: false, route, error: err.message });
  }
});

// ── PATCH /api/delivery/orders/:id/status ─────────────────────────────
// Body: { status: 'entregado'|'en_camino'|'cancelled'|'por_despachar', source: 'shopify'|'bot' }
router.patch('/orders/:id/status', async (req, res) => {
  const { status, source } = req.body;
  const { id } = req.params;

  const VALID = ['entregado', 'en_camino', 'cancelled', 'por_despachar', 'nuevo'];
  if (!VALID.includes(status)) {
    return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${VALID.join(', ')}` });
  }

  const pool = getPool();
  try {
    if (source === 'shopify') {
      await pool.query(
        `UPDATE shopify_orders SET crm_status = $1, updated_at = NOW()
         WHERE shopify_order_id = $2 AND organization_id = $3`,
        [status, id, req.orgId]
      );
    } else {
      await pool.query(
        `UPDATE orders SET status = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3`,
        [status, parseInt(id), req.orgId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Delivery/status]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/delivery/summary ──────────────────────────────────────────
router.get('/summary', async (req, res) => {
  const pool = getPool();
  try {
    const [shopifyRes, botRes] = await Promise.all([
      pool.query(`
        SELECT crm_status, COUNT(*) AS count
        FROM shopify_orders
        WHERE organization_id = $1
          AND (synced_at::date = CURRENT_DATE OR updated_at::date = CURRENT_DATE)
        GROUP BY crm_status
      `, [req.orgId]),
      pool.query(`
        SELECT status AS crm_status, COUNT(*) AS count
        FROM orders
        WHERE organization_id = $1
          AND (created_at::date = CURRENT_DATE OR updated_at::date = CURRENT_DATE)
        GROUP BY status
      `, [req.orgId]),
    ]);

    const counts = {};
    [...shopifyRes.rows, ...botRes.rows].forEach(r => {
      counts[r.crm_status] = (counts[r.crm_status] || 0) + parseInt(r.count);
    });

    const entregados    = counts['entregado']     || 0;
    const pendientes    = (counts['por_despachar'] || 0) + (counts['nuevo'] || 0);
    const enCamino      = counts['en_camino']     || 0;
    const cancelados    = counts['cancelled']     || 0;

    res.json({ success: true, summary: { entregados, pendientes, enCamino, cancelados, raw: counts } });
  } catch (err) {
    console.error('[Delivery/summary]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
