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
 * REPARTIDOR (desde la app mobile):
 *   GET  /api/delivery/routes/active    → Ruta activa asignada (sent o in_progress)
 *   PATCH /api/delivery/routes/:id/stops/:key → Marcar parada como entregada/fallida
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { getPool } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

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
  const street = addr.address || addr.address1 || '';
  const city   = addr.city || '';
  let items = [];
  try { items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []); } catch (_) {}
  return {
    id: String(row.id), source: 'bot',
    orderName: `#BOT-${row.id}`,
    customerName: row.customer_name || 'Sin nombre',
    phone: row.phone || '',
    address: street, city, fullAddress: [street, city].filter(Boolean).join(', '),
    items, totalPrice: parseFloat(row.total_price) || 0, status: row.crm_status,
  };
}

// ─── ADMIN: Pedidos pendientes para seleccionar ──────────────────────────────

router.get('/orders', async (req, res) => {
  const pool = getPool();
  try {
    const [shopifyRes, botRes] = await Promise.all([
      pool.query(`
        SELECT shopify_order_id      AS id,
               shopify_name          AS order_name,
               customer_name,
               customer_phone        AS phone,
               shipping_city,
               raw_json->'shipping_address' AS shipping_address,
               items,
               total_price,
               crm_status
        FROM shopify_orders
        WHERE organization_id = $1
          AND (crm_status IS NULL OR crm_status NOT IN ('en_camino', 'entregado', 'cancelled'))
        ORDER BY synced_at ASC
      `, [req.orgId]),
      pool.query(`
        SELECT id,
               customer_name,
               shipping_address,
               customer_phone        AS phone,
               items,
               total_price,
               status                AS crm_status
        FROM orders
        WHERE organization_id = $1
          AND status IS NOT NULL
          AND status NOT IN ('draft', 'en_camino', 'entregado', 'cancelled')
        ORDER BY created_at ASC
      `, [req.orgId]),
    ]);
    const orders = [
      ...shopifyRes.rows.map(normalizeShopifyOrder),
      ...botRes.rows.map(normalizeBotOrder),
    ].filter(o => o.fullAddress.trim().length > 3);
    res.json({ success: true, orders, total: orders.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Optimizar ruta con Google Maps ───────────────────────────────────

router.post('/optimize', async (req, res) => {
  const { orders, origin } = req.body;
  if (!orders || orders.length === 0)
    return res.status(400).json({ success: false, error: 'No hay pedidos para optimizar' });

  if (orders.length === 1) {
    return res.json({ success: true, optimized: false, route: [{ ...orders[0], stopNumber: 1 }], totalDistance: '', totalDuration: '' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    const route = orders.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    return res.json({ success: true, optimized: false, route, warning: 'Sin GOOGLE_MAPS_API_KEY — orden sin optimizar' });
  }

  try {
    const originStr = origin && typeof origin === 'object' && origin.lat
      ? `${origin.lat},${origin.lng}`
      : (origin || orders[0].fullAddress);

    const addresses        = orders.map(o => o.fullAddress);
    const destination      = addresses[addresses.length - 1];
    const waypointAddr     = addresses.slice(0, -1);
    const waypointsParam   = `optimize:true|${waypointAddr.join('|')}`;

    const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: { origin: originStr, destination, waypoints: waypointsParam, key: apiKey, language: 'es', region: 'cl', mode: 'driving' },
      timeout: 10000,
    });

    if (data.status !== 'OK') throw new Error(`Google Maps: ${data.status} — ${data.error_message || ''}`);

    const routeData          = data.routes[0];
    const optimizedOrder     = routeData.waypoint_order;
    const legs               = routeData.legs;
    const reordered          = optimizedOrder.map(i => orders[i]);
    const orderedStops       = [...reordered, orders[orders.length - 1]];

    const route = orderedStops.map((stop, idx) => ({
      ...stop,
      stopNumber:   idx + 1,
      distanceText: legs[idx]?.distance?.text  || '',
      durationText: legs[idx]?.duration?.text  || '',
      lat: legs[idx]?.end_location?.lat  ?? null,
      lng: legs[idx]?.end_location?.lng  ?? null,
    }));

    const totalDistanceM = legs.reduce((s, l) => s + (l.distance?.value || 0), 0);
    const totalDurationS = legs.reduce((s, l) => s + (l.duration?.value  || 0), 0);
    const totalDistance  = `${(totalDistanceM / 1000).toFixed(1)} km`;
    const totalDuration  = `${Math.round(totalDurationS / 60)} min`;
    const mapsUrl = `https://www.google.com/maps/dir/${encodeURIComponent(originStr)}/${route.map(s => encodeURIComponent(s.fullAddress)).join('/')}`;

    res.json({ success: true, optimized: true, route, totalDistance, totalDuration, mapsUrl });
  } catch (err) {
    console.error('[Delivery/optimize]', err.message);
    const route = orders.map((o, i) => ({ ...o, stopNumber: i + 1 }));
    res.json({ success: true, optimized: false, route, error: err.message });
  }
});

// ─── ADMIN: Listar rutas ─────────────────────────────────────────────────────

router.get('/routes', async (req, res) => {
  // IMPORTANTE: Esta ruta debe estar antes de /routes/active para no ser interceptada
  const pool = getPool();
  const { status, limit = 20, page = 1 } = req.query;
  try {
    let query = `SELECT id, name, status, driver_name, driver_phone,
                        total_distance, total_duration, maps_url,
                        created_at, sent_at, completed_at,
                        jsonb_array_length(orders) AS order_count,
                        stop_statuses
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

router.get('/routes/active', async (req, res) => {
  const pool = getPool();
  try {
    const { rows } = await pool.query(`
      SELECT * FROM delivery_routes
      WHERE organization_id = $1 AND status IN ('sent', 'in_progress')
      ORDER BY sent_at DESC NULLS LAST
      LIMIT 1
    `, [req.orgId]);

    if (rows.length === 0) {
      return res.json({ success: true, route: null });
    }

    const r = rows[0];
    // Si está 'sent', marcarla como 'in_progress' cuando el repartidor la abre
    if (r.status === 'sent') {
      await pool.query(`UPDATE delivery_routes SET status = 'in_progress' WHERE id = $1`, [r.id]);
      r.status = 'in_progress';
    }

    res.json({ success: true, route: r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Crear ruta ───────────────────────────────────────────────────────

router.post('/routes', async (req, res) => {
  const { name, orders, optimizedRoute, totalDistance, totalDuration, mapsUrl, driverName, driverPhone, send } = req.body;
  if (!orders || orders.length === 0)
    return res.status(400).json({ success: false, error: 'La ruta debe tener pedidos' });

  const pool   = getPool();
  const status = send ? 'sent' : 'draft';
  const routeName = name || `Reparto ${new Date().toLocaleDateString('es-CL')}`;

  try {
    const { rows: [route] } = await pool.query(`
      INSERT INTO delivery_routes
        (organization_id, name, status, driver_name, driver_phone,
         orders, optimized_route, total_distance, total_duration, maps_url, sent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      req.orgId, routeName, status, driverName || null, driverPhone || null,
      JSON.stringify(orders),
      optimizedRoute ? JSON.stringify(optimizedRoute) : null,
      totalDistance || null, totalDuration || null, mapsUrl || null,
      send ? new Date() : null,
    ]);

    // Si se envía, marcar los pedidos CRM como 'en_camino'
    if (send) {
      const shopifyIds = orders.filter(o => o.source === 'shopify').map(o => o.id);
      const botIds     = orders.filter(o => o.source === 'bot').map(o => parseInt(o.id));
      await Promise.all([
        shopifyIds.length && pool.query(
          `UPDATE shopify_orders SET crm_status = 'en_camino', updated_at = NOW()
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Actualizar ruta (enviar, cancelar, cambiar datos) ────────────────

router.patch('/routes/:id', async (req, res) => {
  const { id } = req.params;
  const { status, driverName, driverPhone, name } = req.body;
  const pool = getPool();

  const VALID = ['draft', 'sent', 'in_progress', 'completed', 'cancelled'];
  if (status && !VALID.includes(status))
    return res.status(400).json({ success: false, error: 'Estado inválido' });

  try {
    const sets = []; const params = [req.orgId, parseInt(id)];
    if (status)      { sets.push(`status = $${params.length + 1}`); params.push(status); }
    if (driverName !== undefined) { sets.push(`driver_name = $${params.length + 1}`); params.push(driverName || null); }
    if (driverPhone !== undefined) { sets.push(`driver_phone = $${params.length + 1}`); params.push(driverPhone || null); }
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
          `UPDATE shopify_orders SET crm_status = 'en_camino', updated_at = NOW() WHERE organization_id = $1 AND shopify_order_id = ANY($2)`,
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: Eliminar ruta borrador ───────────────────────────────────────────

router.delete('/routes/:id', async (req, res) => {
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

router.patch('/routes/:id/stops/:stopKey', async (req, res) => {
  const { id, stopKey } = req.params;
  const { status } = req.body;  // 'entregado' | 'cancelled' | 'pending'
  const pool = getPool();

  const VALID = ['entregado', 'cancelled', 'pending'];
  if (!VALID.includes(status))
    return res.status(400).json({ success: false, error: `Estado inválido. Opciones: ${VALID.join(', ')}` });

  try {
    // Actualizar stop_statuses en la ruta
    const { rows: [route] } = await pool.query(
      `UPDATE delivery_routes
       SET stop_statuses = stop_statuses || jsonb_build_object($1::text, $2::text)
       WHERE id = $3 AND organization_id = $4
       RETURNING stop_statuses, orders`,
      [stopKey, status, parseInt(id), req.orgId]
    );
    if (!route) return res.status(404).json({ success: false, error: 'Ruta no encontrada' });

    // Actualizar el estado real del pedido en la tabla correspondiente
    const [source, orderId] = stopKey.split('_');
    if (source === 'shopify') {
      await pool.query(
        `UPDATE shopify_orders SET crm_status = $1, updated_at = NOW() WHERE shopify_order_id = $2 AND organization_id = $3`,
        [status === 'entregado' ? 'entregado' : status === 'cancelled' ? 'cancelled' : 'en_camino', orderId, req.orgId]
      );
    } else if (source === 'bot') {
      await pool.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
        [status === 'entregado' ? 'entregado' : status === 'cancelled' ? 'cancelled' : 'en_camino', parseInt(orderId), req.orgId]
      );
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

    res.json({ success: true, stopStatuses: route.stop_statuses });
  } catch (err) {
    console.error('[Delivery/stop]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
