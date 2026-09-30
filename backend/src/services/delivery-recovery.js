const { getPool } = require('../db/database');

const AUTO_REASON = 'La ruta terminó sin que el repartidor registrara el resultado de esta entrega';

function chileDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/**
 * Cierra rutas iniciadas antes del día actual que quedaron sin resolución.
 * Solo toca pedidos que realmente siguen `en_camino`; una ruta enviada pero
 * nunca iniciada no cuenta como intento de entrega.
 */
async function reconcileStaleDeliveryRoutes(orgId = null, now = new Date()) {
  const pool = await getPool().connect();
  const today = chileDateParts(now);
  let recovered = 0;
  try {
    await pool.query('BEGIN');
    const { rows: routes } = await pool.query(
      `SELECT * FROM delivery_routes
        WHERE status = 'in_progress'
          AND started_at IS NOT NULL
          AND (started_at AT TIME ZONE 'America/Santiago')::date < $1::date
          AND ($2::int IS NULL OR organization_id = $2)
        FOR UPDATE`,
      [today, orgId]
    );

    for (const route of routes) {
      const orders = Array.isArray(route.orders) ? route.orders : JSON.parse(route.orders || '[]');
      const statuses = { ...(route.stop_statuses || {}) };
      const notes = { ...(route.stop_notes || {}) };
      const times = { ...(route.stop_times || {}) };
      const unresolved = orders.filter(order => {
        const status = statuses[`${order.source}_${order.id}`];
        return !status || status === 'pending';
      });

      for (const order of unresolved) {
        const key = `${order.source}_${order.id}`;
        statuses[key] = 'not_delivered';
        notes[key] = AUTO_REASON;
        times[key] = now.toISOString();
        const id = String(order.id);
        if (order.source === 'shopify') {
          const result = await pool.query(
            `UPDATE shopify_orders
                SET crm_status = 'no_entregado', updated_at = NOW(),
                    last_attempt_at = COALESCE(last_attempt_at, $3),
                    last_attempt_status = 'sin_resolver', delivery_note = $4
              WHERE organization_id = $1 AND shopify_order_id = $2
                AND crm_status = 'en_camino' AND delivered_at IS NULL`,
            [route.organization_id, id, route.started_at, AUTO_REASON]
          );
          recovered += result.rowCount || 0;
        } else if (order.source === 'bot' && /^\d+$/.test(id)) {
          const result = await pool.query(
            `UPDATE orders
                SET status = 'no_entregado', updated_at = NOW(),
                    last_attempt_at = COALESCE(last_attempt_at, $3),
                    last_attempt_status = 'sin_resolver', delivery_note = $4
              WHERE organization_id = $1 AND id = $2
                AND status = 'en_camino' AND delivered_at IS NULL`,
            [route.organization_id, Number(id), route.started_at, AUTO_REASON]
          );
          recovered += result.rowCount || 0;
        }
      }

      if (unresolved.length) {
        await pool.query(
          `UPDATE delivery_routes
              SET stop_statuses = $2::jsonb, stop_notes = $3::jsonb,
                  stop_times = $4::jsonb, status = 'completed', completed_at = COALESCE(completed_at, NOW())
            WHERE id = $1`,
          [route.id, JSON.stringify(statuses), JSON.stringify(notes), JSON.stringify(times)]
        );
      }
    }
    await pool.query('COMMIT');
    return { routes: routes.length, recovered };
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  } finally {
    pool.release();
  }
}

function startDeliveryRecoveryJob() {
  const run = () => reconcileStaleDeliveryRoutes().then(result => {
    if (result.recovered) console.log(`[DeliveryRecovery] ${result.recovered} pedido(s) pasaron a no_entregado`);
  }).catch(error => console.error('[DeliveryRecovery]', error.message));
  setTimeout(run, 30 * 1000);
  setInterval(run, 15 * 60 * 1000);
}

module.exports = { AUTO_REASON, chileDateParts, reconcileStaleDeliveryRoutes, startDeliveryRecoveryJob };
