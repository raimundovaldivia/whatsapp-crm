const crypto = require('node:crypto');
const db = require('../db/database');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,96}$/;
const TERMINAL_STOPS = new Set(['entregado', 'partial', 'cancelled', 'postponed', 'not_delivered']);

async function publicBaseUrl(orgId) {
  const storeUrl = await db.getSetting(orgId, 'store_public_url');
  if (typeof storeUrl === 'string' && storeUrl.length <= 2048) {
    try {
      const url = new URL(storeUrl.trim());
      // El catálogo puede incluir una ruta; el seguimiento vive en la raíz.
      if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
    } catch { /* Una configuración antigua inválida conserva el enlace de la API. */ }
  }
  return String(process.env.CRM_PUBLIC_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL || '')
    .trim()
    .replace(/\/$/, '');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function validStopKey(value) {
  const key = String(value || '').trim();
  return key && key.length <= 300 ? key : null;
}

async function createTrackingLink(orgId, routeId, stopKey, { lifetimeHours = 12 } = {}) {
  const key = validStopKey(stopKey);
  if (!key || !Number.isSafeInteger(Number(orgId)) || Number(orgId) <= 0
    || !Number.isSafeInteger(Number(routeId)) || Number(routeId) <= 0) return null;
  const baseUrl = await publicBaseUrl(orgId);
  if (!baseUrl) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const hash = tokenHash(token);
  const hours = Math.min(24, Math.max(1, Number(lifetimeHours) || 12));
  const { rows: [session] } = await db.getPool().query(
    `INSERT INTO delivery_tracking_sessions
       (organization_id, route_id, stop_key, token_hash, expires_at)
     SELECT $1, r.id, $3, $4, NOW() + ($5 || ' hours')::interval
       FROM delivery_routes r
      WHERE r.id = $2 AND r.organization_id = $1 AND r.status = 'in_progress'
     RETURNING route_id`,
    [orgId, Number(routeId), key, hash, String(hours)]
  );
  return session ? `${baseUrl}/seguimiento/${token}` : null;
}

// Solo se llama después de comprobar tienda, teléfono y referencia del pedido.
// Reutiliza un seguimiento vigente sin prolongar su vencimiento ni enviar avisos.
async function createOrderTrackingToken(orgId, stopKey) {
  if (!Number.isSafeInteger(Number(orgId)) || Number(orgId) <= 0
    || !/^(bot|shopify)_[1-9]\d{0,29}$/.test(String(stopKey || ''))) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await db.getPool().query(
    `WITH eligible AS (
       SELECT s.* FROM delivery_tracking_sessions s
       JOIN delivery_routes r ON r.id = s.route_id AND r.organization_id = s.organization_id
       WHERE s.organization_id = $1 AND s.stop_key = $2
         AND r.status = 'in_progress' AND s.revoked_at IS NULL AND s.expires_at > NOW()
         AND NOT (COALESCE(r.stop_statuses->>$2, 'pending') = ANY($4::text[]))
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(r.optimized_route) = 'array' AND r.optimized_route <> '[]'::jsonb
                  THEN r.optimized_route ELSE COALESCE(r.orders, '[]'::jsonb) END
           ) stop WHERE (stop->>'source') || '_' || (stop->>'id') = $2
         )
     )
     INSERT INTO delivery_tracking_sessions
       (organization_id, route_id, stop_key, token_hash, expires_at,
        latitude, longitude, accuracy_m, location_updated_at)
     SELECT organization_id, route_id, stop_key, $3, expires_at,
            latitude, longitude, accuracy_m, location_updated_at
       FROM eligible
      WHERE (SELECT COUNT(DISTINCT route_id) FROM eligible) = 1
      ORDER BY location_updated_at DESC NULLS LAST, expires_at DESC LIMIT 1
     RETURNING route_id`,
    [Number(orgId), stopKey, tokenHash(token), [...TERMINAL_STOPS]]
  );
  return rows.length === 1 ? token : null;
}

function validateLocation(input = {}) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const accuracy = input.accuracy == null ? null : Number(input.accuracy);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw Object.assign(new Error('Latitud inválida'), { status: 400 });
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw Object.assign(new Error('Longitud inválida'), { status: 400 });
  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000)) {
    throw Object.assign(new Error('Precisión inválida'), { status: 400 });
  }
  return { latitude, longitude, accuracy };
}

async function updateRouteLocation(orgId, routeId, input) {
  const location = validateLocation(input);
  const { rowCount } = await db.getPool().query(
    `UPDATE delivery_tracking_sessions s
        SET latitude = $3,
            longitude = $4,
            accuracy_m = $5,
            location_updated_at = NOW(),
            updated_at = NOW()
       FROM delivery_routes r
      WHERE s.organization_id = $1
        AND s.route_id = $2
        AND r.id = s.route_id
        AND r.organization_id = s.organization_id
        AND r.status = 'in_progress'
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()`,
    [orgId, Number(routeId), location.latitude, location.longitude, location.accuracy]
  );
  return { ...location, activeLinks: rowCount || 0, updatedAt: new Date().toISOString() };
}

async function getTrackingStatus(token) {
  if (!TOKEN_PATTERN.test(String(token || ''))) return null;
  const { rows: [row] } = await db.getPool().query(
    `SELECT s.stop_key, s.latitude, s.longitude, s.accuracy_m,
            s.location_updated_at, s.expires_at, s.revoked_at,
            r.status AS route_status, r.stop_statuses, r.orders, r.optimized_route,
            COALESCE(o.status, so.crm_status) AS order_status,
            COALESCE(o.delivered_at, so.delivered_at) AS delivered_at
       FROM delivery_tracking_sessions s
       JOIN delivery_routes r
         ON r.id = s.route_id AND r.organization_id = s.organization_id
       LEFT JOIN orders o ON o.organization_id = s.organization_id AND s.stop_key = 'bot_' || o.id::text
       LEFT JOIN shopify_orders so ON so.organization_id = s.organization_id AND s.stop_key = 'shopify_' || so.shopify_order_id
      WHERE s.token_hash = $1
      LIMIT 1`,
    [tokenHash(token)]
  );
  if (!row) return null;
  const statuses = row.stop_statuses && typeof row.stop_statuses === 'object'
    ? row.stop_statuses
    : JSON.parse(row.stop_statuses || '{}');
  const stopStatus = statuses[row.stop_key] || 'pending';
  const optimized = Array.isArray(row.optimized_route) ? row.optimized_route : [];
  const stops = optimized.length ? optimized : Array.isArray(row.orders) ? row.orders : [];
  const belongs = stops.some(stop => `${stop.source}_${stop.id}` === row.stop_key);
  const orderDelivered = row.order_status === 'entregado'
    || (['paid', 'payment_received'].includes(row.order_status) && row.delivered_at);
  const orderInTransit = row.order_status === 'en_camino'
    || (['paid', 'payment_received'].includes(row.order_status) && !row.delivered_at);
  const active = row.route_status === 'in_progress'
    && belongs && orderInTransit
    && !TERMINAL_STOPS.has(stopStatus)
    && !row.revoked_at
    && new Date(row.expires_at).getTime() > Date.now();
  return {
    active,
    status: active ? 'in_transit' : stopStatus === 'entregado' || (orderDelivered && stopStatus !== 'partial') ? 'delivered' : 'finished',
    latitude: active && row.latitude != null ? Number(row.latitude) : null,
    longitude: active && row.longitude != null ? Number(row.longitude) : null,
    accuracyM: active && row.accuracy_m != null ? Math.round(Number(row.accuracy_m)) : null,
    updatedAt: active && row.location_updated_at ? new Date(row.location_updated_at).toISOString() : null,
  };
}

module.exports = {
  TOKEN_PATTERN,
  publicBaseUrl,
  tokenHash,
  validateLocation,
  createTrackingLink,
  createOrderTrackingToken,
  updateRouteLocation,
  getTrackingStatus,
};
