const db = require('../db/database');
const commercial = require('./commercial');
const { crmOrderLabel } = require('../utils/order-reference');
const { createOrderTrackingToken } = require('./delivery-tracking');

function invalid() {
  return Object.assign(new Error('Revisa el teléfono y el número de pedido.'), { status: 400 });
}

function validateLookup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  if (typeof input.phone !== 'string' || input.phone.length > 30 || !/^\+?[\d ()-]{8,30}$/.test(input.phone.trim())) throw invalid();
  let phone = input.phone.replace(/\D/g, '');
  if (/^9\d{8}$/.test(phone)) phone = `56${phone}`;
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw invalid();
  if (typeof input.orderNumber !== 'string' || input.orderNumber.length > 40) throw invalid();
  const reference = input.orderNumber.trim().replace(/^#/, '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,38}$/.test(reference)) throw invalid();
  const crm = /^(?:DR|BOT)-(\d+)$/.exec(reference);
  if (crm && (!Number.isSafeInteger(Number(crm[1])) || Number(crm[1]) < 1 || Number(crm[1]) > 2147483647)) throw invalid();
  const slug = input.storeSlug;
  const hostname = input.hostname;
  if (hostname != null && typeof hostname !== 'string') throw invalid();
  if (slug != null && (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug))) throw invalid();
  if (!slug && (typeof hostname !== 'string' || hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname))) throw invalid();
  return { phone, reference, crmId: crm ? Number(crm[1]) : null, slug, hostname: hostname?.toLowerCase() };
}

async function findStore(pool, { slug, hostname }) {
  if (slug) {
    const { rows } = await pool.query('SELECT id, name FROM organizations WHERE slug = $1 LIMIT 1', [slug]);
    return rows[0] || null;
  }
  const host = hostname.replace(/^www\./, '');
  const hosts = [host, `www.${host}`];
  const { rows } = await pool.query(
    `SELECT o.id, o.name, s.value FROM organizations o
       JOIN settings s ON s.organization_id = o.id AND s.key = 'store_public_url'
      WHERE substring(lower(btrim(s.value)) from '^https://([^/?#]+)') = ANY($1::text[])
      LIMIT 3`, [hosts.flatMap(value => [value, `${value}:443`])]);
  const matches = rows.filter(row => {
    try {
      const url = new URL(row.value.trim());
      return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.hostname);
    } catch { return false; }
  });
  // Un dominio compartido requiere la ruta explícita de la tienda.
  return matches.length === 1 ? matches[0] : null;
}

function publicStatus(row, routeStatus) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'cancelled' || row.cancelled) return ['cancelled', 'Cancelado'];
  // Una reprogramación conserva la fecha histórica de entrega en algunos pedidos.
  // El estado vigente prevalece; el pago solo confirma entrega si hay evidencia.
  if (status === 'entregado' || (['paid', 'payment_received'].includes(status) && row.delivered_at)) {
    return routeStatus === 'partial' ? ['partial', 'Entrega parcial'] : ['delivered', 'Entregado'];
  }
  if (status === 'en_camino') return ['in_transit', 'En camino'];
  if (status === 'no_entregado') return ['not_delivered', 'No se pudo entregar'];
  if (row.last_attempt_status === 'reprogramado' && status === 'por_despachar') return ['rescheduled', 'Entrega reprogramada'];
  if (status === 'asignado_ruta') return ['assigned', 'Preparando el reparto'];
  if (status === 'por_despachar') return ['preparing', 'Por despachar'];
  if (status === 'failed') return ['needs_review', 'Pendiente de revisión'];
  if (['nuevo', 'draft', 'sent', 'paid', 'payment_received'].includes(status)) return ['received', 'Pedido recibido'];
  return ['pending', 'Estado por confirmar'];
}

function publicPayment(row, shopify = false) {
  const methods = { efectivo: 'Efectivo', transferencia: 'Transferencia', mixto: 'Efectivo y transferencia', otro: 'Otro medio' };
  const method = Object.hasOwn(methods, row.payment_method) ? row.payment_method : null;
  const recorded = String(shopify ? row.financial_status || '' : row.status || '').toLowerCase();
  const states = { paid: 'Pagado', payment_received: 'Pagado', pending: 'Pendiente de pago',
    authorized: 'Pago autorizado, pendiente de cobro', partially_paid: 'Pago parcial',
    refunded: 'Reembolsado', partially_refunded: 'Reembolso parcial', voided: 'Pago anulado' };
  let status = Object.hasOwn(states, recorded) ? recorded : 'unknown';
  if (status === 'payment_received') status = 'paid';
  if (!shopify && ['nuevo', 'draft', 'sent', 'por_despachar', 'asignado_ruta', 'en_camino', 'no_entregado', 'entregado'].includes(recorded)) status = 'pending';
  return { status, statusLabel: states[status] || 'Estado de pago por confirmar',
    method, methodLabel: method ? methods[method] : 'Medio no registrado' };
}

async function lookupOrder(input) {
  const lookup = validateLookup(input);
  const pool = db.getPool();
  const store = await findStore(pool, lookup);
  if (!store || !await commercial.permitted(store.id, 'storefront')) return null;
  const phones = [lookup.phone];
  if (/^569\d{8}$/.test(lookup.phone)) phones.push(lookup.phone.slice(2));
  // Solo se comparan formatos del mismo teléfono, nunca alias por nombre/dirección.
  const phoneMatch = "regexp_replace(customer_phone, '[^0-9]', '', 'g') = ANY($3::text[])";
  const { rows } = lookup.crmId
    ? await pool.query(
      `SELECT id, status, payment_method, delivered_at, last_attempt_status, delivery_date::text AS delivery_date,
              (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date::text AS ordered_date
         FROM orders WHERE organization_id = $1 AND id = $2 AND ${phoneMatch} LIMIT 1`,
      [store.id, lookup.crmId, phones])
    : await pool.query(
      `SELECT shopify_order_id AS id, shopify_name, crm_status AS status, payment_method, financial_status, delivered_at, last_attempt_status,
              raw_json->>'cancelled_at' IS NOT NULL AS cancelled, delivery_date::text AS delivery_date,
              (shopify_created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date::text AS ordered_date
         FROM shopify_orders WHERE organization_id = $1
          AND upper(regexp_replace(shopify_name, '^#', '')) = $2 AND ${phoneMatch} LIMIT 2`,
      [store.id, lookup.reference, phones]);
  if (rows.length !== 1) return null;
  const row = rows[0];
  let routeStatus;
  if (row.status === 'entregado' || row.delivered_at) {
    const { rows: routes } = await pool.query(
      `SELECT stop_statuses->>$2 AS status FROM delivery_routes
        WHERE organization_id = $1 AND stop_statuses ? $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [store.id, `${lookup.crmId ? 'bot' : 'shopify'}_${row.id}`]);
    routeStatus = routes[0]?.status;
  }
  let [status, statusLabel] = publicStatus(row, routeStatus);
  const canTrack = status === 'in_transit' || (status === 'received' && ['paid', 'payment_received'].includes(row.status));
  const trackingToken = canTrack
    ? await createOrderTrackingToken(store.id, `${lookup.crmId ? 'bot' : 'shopify'}_${row.id}`).catch(() => null)
    : null;
  if (trackingToken) [status, statusLabel] = ['in_transit', 'En camino'];
  return {
    storeName: store.name,
    orderNumber: lookup.crmId ? crmOrderLabel(row.id) : row.shopify_name,
    status, statusLabel, orderedDate: row.ordered_date || null,
    deliveryDate: row.delivery_date || null,
    payment: publicPayment(row, !lookup.crmId), trackingToken,
  };
}

module.exports = { lookupOrder, validateLookup, publicStatus, publicPayment };
