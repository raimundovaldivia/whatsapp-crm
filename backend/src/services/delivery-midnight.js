const { getPool } = require('../db/database');
const { AUTO_REASON, chileDateParts } = require('./delivery-recovery');

// Cierre diario de rutas. Corre al cambiar el día (00:00 America/Santiago) y una vez
// al arrancar el backend. Cierra las rutas activas (sent / in_progress) iniciadas o
// enviadas antes de hoy: sus paradas sin resultado pasan a no_entregado y la ruta
// queda cancelada. Las rutas de hoy no se tocan.
const CLOSED = new Set(['entregado', 'partial', 'cancelled', 'postponed', 'not_delivered']);

function list(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function keyOf(order) {
  return order?.source && order?.id != null ? `${order.source}_${String(order.id)}` : null;
}

async function deactivateActiveRoutes(now = new Date()) {
  const client = await getPool().connect();
  const today = chileDateParts(now);
  const summary = { routes: 0, orders: 0 };
  try {
    await client.query('BEGIN');
    const { rows: routes } = await client.query(
      `SELECT * FROM delivery_routes
        WHERE status IN ('sent', 'in_progress')
          AND (COALESCE(started_at, sent_at, created_at) AT TIME ZONE 'America/Santiago')::date < $1::date
        ORDER BY id
        FOR UPDATE`,
      [today]
    );

    for (const route of routes) {
      const statuses = { ...(route.stop_statuses || {}) };
      const notes = { ...(route.stop_notes || {}) };
      const times = { ...(route.stop_times || {}) };

      for (const order of list(route.orders)) {
        const key = keyOf(order);
        if (!key || CLOSED.has(statuses[key])) continue;
        statuses[key] = 'not_delivered';
        notes[key] = AUTO_REASON;
        times[key] = now.toISOString();
        const id = String(order.id);

        if (order.source === 'shopify') {
          const result = await client.query(
            `UPDATE shopify_orders
                SET crm_status = 'no_entregado', last_attempt_status = 'sin_resolver',
                    last_attempt_at = COALESCE(last_attempt_at, NOW()), delivery_note = $3,
                    updated_at = NOW()
              WHERE organization_id = $1 AND shopify_order_id = $2
                AND crm_status IN ('asignado_ruta', 'en_camino') AND delivered_at IS NULL`,
            [route.organization_id, id, AUTO_REASON]
          );
          summary.orders += result.rowCount || 0;
        } else if (order.source === 'bot' && /^\d+$/.test(id)) {
          const result = await client.query(
            `UPDATE orders
                SET status = 'no_entregado', last_attempt_status = 'sin_resolver',
                    last_attempt_at = COALESCE(last_attempt_at, NOW()), delivery_note = $3,
                    updated_at = NOW()
              WHERE organization_id = $1 AND id = $2
                AND status IN ('asignado_ruta', 'en_camino') AND delivered_at IS NULL`,
            [route.organization_id, Number(id), AUTO_REASON]
          );
          summary.orders += result.rowCount || 0;
        }
      }

      await client.query(
        `UPDATE delivery_routes
            SET stop_statuses = $2::jsonb, stop_notes = $3::jsonb, stop_times = $4::jsonb,
                status = 'cancelled', completed_at = COALESCE(completed_at, NOW())
          WHERE id = $1`,
        [route.id, JSON.stringify(statuses), JSON.stringify(notes), JSON.stringify(times)]
      );
      summary.routes += 1;
    }

    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function runAndLog(reason) {
  return deactivateActiveRoutes().then(result => {
    if (result.routes) console.log(`[DeliveryMidnight:${reason}] ${result.routes} ruta(s) cerradas, ${result.orders} pedido(s) no entregados`);
  }).catch(error => console.error('[DeliveryMidnight]', error.message));
}

function startDeliveryMidnightJob() {
  // Al arrancar: cubre rutas dejadas abiertas si el servidor estuvo apagado a medianoche.
  setTimeout(() => runAndLog('arranque'), 30 * 1000);
  // Al cambiar el día: revisa cada minuto y ejecuta una sola vez por día.
  let lastDay = chileDateParts();
  setInterval(() => {
    const today = chileDateParts();
    if (today === lastDay) return;
    lastDay = today;
    runAndLog('medianoche');
  }, 60 * 1000).unref?.();
}

module.exports = { deactivateActiveRoutes, startDeliveryMidnightJob };
