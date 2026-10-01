function list(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function keyOf(order) {
  return order?.source && order?.id != null ? `${order.source}_${String(order.id)}` : null;
}

const CLOSED = new Set(['entregado', 'cancelled', 'postponed', 'not_delivered']);

/**
 * Registra un cambio externo (administración o Diva) en la ruta donde estaba
 * el pedido. La parada permanece en la ruta original como evidencia del
 * intento y deja de formar parte de la carga pendiente.
 */
async function recordRouteOutcome(client, orgId, source, id, status, note = '') {
  const stopKey = `${source}_${String(id)}`;
  const { rows } = await client.query(
    `SELECT id, status, orders, stop_statuses
       FROM delivery_routes
      WHERE organization_id = $1 AND status IN ('sent', 'in_progress')
      ORDER BY created_at DESC
      FOR UPDATE`,
    [orgId]
  );
  const touched = [];
  for (const route of rows) {
    const orders = list(route.orders);
    if (!orders.some(order => keyOf(order) === stopKey)) continue;
    const statuses = route.stop_statuses && typeof route.stop_statuses === 'object' ? route.stop_statuses : {};
    if (CLOSED.has(statuses[stopKey])) continue;
    const nextStatuses = { ...statuses, [stopKey]: status };
    const allDone = orders.length > 0 && orders.every(order => CLOSED.has(nextStatuses[keyOf(order)]));
    await client.query(
      `UPDATE delivery_routes
          SET stop_statuses = COALESCE(stop_statuses, '{}'::jsonb) || jsonb_build_object($1::text, $2::text),
              stop_notes = CASE WHEN $3::text = '' THEN COALESCE(stop_notes, '{}'::jsonb)
                                ELSE COALESCE(stop_notes, '{}'::jsonb) || jsonb_build_object($1::text, $3::text) END,
              stop_times = COALESCE(stop_times, '{}'::jsonb) || jsonb_build_object($1::text, to_jsonb(NOW())),
              status = CASE WHEN $4::boolean THEN 'completed' ELSE status END,
              completed_at = CASE WHEN $4::boolean THEN COALESCE(completed_at, NOW()) ELSE completed_at END
        WHERE id = $5 AND organization_id = $6`,
      [stopKey, status, String(note || '').slice(0, 500), allDone, route.id, orgId]
    );
    touched.push(route.id);
  }
  return touched;
}

/** Incorpora los resultados de rutas anteriores a cada parada de una ruta. */
async function attachAttemptHistory(client, route, orgId) {
  if (!route?.id) return route;
  const currentKeys = new Set([...list(route.orders), ...list(route.optimized_route)].map(keyOf).filter(Boolean));
  if (!currentKeys.size) return route;
  const { rows } = await client.query(
    `SELECT id, name, orders, stop_statuses, stop_notes, stop_times,
            created_at, sent_at, completed_at
       FROM delivery_routes
      WHERE organization_id = $1 AND id <> $2
        AND stop_statuses IS NOT NULL AND stop_statuses::text <> '{}'
        AND ($3::timestamp IS NULL OR created_at < $3::timestamp)
      ORDER BY COALESCE(completed_at, sent_at, created_at) DESC
      LIMIT 500`,
    [orgId, route.id, route.created_at || null]
  );
  const histories = new Map();
  for (const oldRoute of rows) {
    const statuses = oldRoute.stop_statuses || {};
    const notes = oldRoute.stop_notes || {};
    const times = oldRoute.stop_times || {};
    for (const order of list(oldRoute.orders)) {
      const key = keyOf(order);
      const status = statuses[key];
      if (!currentKeys.has(key) || !CLOSED.has(status)) continue;
      const items = histories.get(key) || [];
      if (items.length >= 10) continue;
      items.push({
        routeId: oldRoute.id,
        routeName: oldRoute.name,
        status,
        note: notes[key] || null,
        at: times[key] || oldRoute.completed_at || oldRoute.sent_at || oldRoute.created_at,
      });
      histories.set(key, items);
    }
  }
  const add = stop => {
    const history = histories.get(keyOf(stop)) || [];
    return history.length ? { ...stop, attemptHistory: history } : stop;
  };
  return { ...route, orders: list(route.orders).map(add), optimized_route: list(route.optimized_route).map(add) };
}

module.exports = { recordRouteOutcome, attachAttemptHistory };
