const db = require('../db/database');
const push = require('./push');

function phoneDigits(value = '') {
  const digits = String(value).trim().split('@')[0].split(':')[0].replace(/\D/g, '');
  return /^9\d{8}$/.test(digits) ? `56${digits}` : digits;
}

function jsonList(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function activeDeliveryTargets(routes, phone) {
  const wanted = phoneDigits(phone);
  if (!wanted) return [];
  const targets = [];
  for (const route of routes || []) {
    if (!route?.driver_user_id) continue;
    const stop = jsonList(route.orders).find(item => phoneDigits(item?.phone || item?.customer_phone) === wanted);
    if (!stop) continue;
    const statuses = route.stop_statuses && typeof route.stop_statuses === 'object'
      ? route.stop_statuses
      : (() => { try { return JSON.parse(route.stop_statuses || '{}'); } catch { return {}; } })();
    const stopStatus = statuses[`${stop.source}_${stop.id}`];
    if (route.status === 'completed' && !['cancelled', 'postponed', 'not_delivered'].includes(stopStatus)) continue;
    targets.push({
      driverUserId: route.driver_user_id,
      routeId: route.id,
      routeName: route.name || 'Ruta',
      stopKey: `${stop.source}_${stop.id}`,
      customerName: stop.customerName || stop.customer_name || 'Cliente',
    });
  }
  return targets;
}

async function notifyAssignedDriversForInbound(orgId, conversation, messageText) {
  const phone = phoneDigits(conversation?.phone_number);
  if (!orgId || !phone) return { sent: 0, targets: [] };
  const { rows } = await db.getPool().query(
    `SELECT id, name, status, driver_user_id, orders, stop_statuses
       FROM delivery_routes
      WHERE organization_id = $1
        AND (
          status = 'in_progress'
          OR (status = 'completed' AND completed_at >= NOW() - INTERVAL '7 days')
        )
        AND driver_user_id IS NOT NULL`,
    [orgId]
  );
  const targets = activeDeliveryTargets(rows, phone);
  const preview = String(messageText || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Envió un nuevo mensaje';
  let sent = 0;
  for (const target of targets) {
    const result = await push.pushUser(orgId, target.driverUserId, {
      title: `💬 ${target.customerName} escribió`,
      body: preview,
      data: {
        kind: 'delivery_chat',
        routeId: String(target.routeId),
        routeName: target.routeName,
        stopKey: target.stopKey,
        customerName: target.customerName,
      },
    });
    sent += Number(result?.sent || 0);
  }
  return { sent, targets };
}

module.exports = { phoneDigits, jsonList, activeDeliveryTargets, notifyAssignedDriversForInbound };
