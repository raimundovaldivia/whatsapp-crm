const crypto = require('crypto');
const { getPool, normalizePhone } = require('../db/database');
const meta = require('./meta-platform');

const PURCHASE_LOOKBACK_DAYS = 7;
const ATTRIBUTION_LOOKBACK_DAYS = 30;
const MAX_ATTEMPTS = 8;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;
let running = false;

function phoneHash(value) {
  const normalized = normalizePhone(value);
  if (!/^56\d{9}$/.test(normalized)) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function purchaseEventId(organizationId, source, orderKey) {
  return `purchase:${organizationId}:${source}:${orderKey}`;
}

function unixSeconds(value) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('La compra no tiene una fecha válida');
  return Math.floor(milliseconds / 1000);
}

function buildPurchasePayload(delivery, config) {
  const userData = {
    whatsapp_business_account_id: String(config.businessAccountId),
    ctwa_clid: delivery.ctwa_clid,
  };
  if (delivery.phone_hash) userData.ph = [delivery.phone_hash];
  return {
    data: [{
      event_name: 'Purchase',
      event_time: unixSeconds(delivery.event_time),
      event_id: delivery.event_id,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
      custom_data: {
        currency: delivery.currency || 'CLP',
        value: Number(delivery.value_amount),
      },
    }],
  };
}

function buildAudiencePayload(delivery) {
  if (!delivery.phone_hash) throw new Error('El comprador no tiene un teléfono válido');
  return { payload: { schema: 'PHONE_SHA256', data: [delivery.phone_hash] } };
}

async function enabledConfigurations(pool, organizationId = null) {
  const values = [];
  let scope = '';
  if (organizationId !== null && organizationId !== undefined) {
    values.push(organizationId);
    scope = 'AND connection.organization_id = $1';
  }
  const { rows } = await pool.query(
    `SELECT connection.organization_id, connection.user_access_token,
            connection.conversion_dataset_id, connection.purchase_audience_id,
            connection.purchase_sync_since, whatsapp.business_account_id
       FROM meta_connections connection
       LEFT JOIN whatsapp_configs whatsapp
         ON whatsapp.organization_id = connection.organization_id
      WHERE connection.status = 'connected'
        AND connection.purchase_sync_enabled = TRUE
        ${scope}`,
    values
  );
  return rows;
}

async function paidOrders(pool, organizationId, since) {
  const { rows: localOrders } = await pool.query(
    `SELECT 'bot' AS source, order_row.id::text AS order_key,
            order_row.conversation_id, order_row.customer_phone,
            order_row.total_price AS value_amount,
            COALESCE(order_row.payment_marked_at, order_row.created_at) AS event_time
       FROM orders order_row
      WHERE order_row.organization_id = $1
        AND order_row.status = 'paid'
        AND COALESCE(order_row.payment_marked_at, order_row.created_at) >= $2::timestamptz
      ORDER BY COALESCE(order_row.payment_marked_at, order_row.created_at) ASC
      LIMIT 1000`,
    [organizationId, since]
  );
  const { rows: shopifyOrders } = await pool.query(
    `SELECT 'shopify' AS source, shopify.shopify_order_id AS order_key,
            NULL::integer AS conversation_id, shopify.customer_phone,
            shopify.total_price AS value_amount,
            COALESCE(shopify.payment_marked_at, shopify.shopify_created_at, shopify.synced_at) AS event_time
       FROM shopify_orders shopify
      WHERE shopify.organization_id = $1
        AND LOWER(COALESCE(shopify.financial_status, '')) = 'paid'
        AND COALESCE(shopify.payment_marked_at, shopify.shopify_created_at, shopify.synced_at) >= $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM orders order_row
           WHERE order_row.organization_id = shopify.organization_id
             AND order_row.shopify_order_id = shopify.shopify_order_id
        )
      ORDER BY COALESCE(shopify.payment_marked_at, shopify.shopify_created_at, shopify.synced_at) ASC
      LIMIT 1000`,
    [organizationId, since]
  );
  return [...localOrders, ...shopifyOrders];
}

async function purchaseAttribution(pool, organizationId, order) {
  const digits = normalizePhone(order.customer_phone);
  const { rows: [attribution] } = await pool.query(
    `SELECT attribution.ctwa_clid
       FROM whatsapp_attributions attribution
       JOIN conversations conversation
         ON conversation.id = attribution.conversation_id
        AND conversation.organization_id = attribution.organization_id
      WHERE attribution.organization_id = $1
        AND NULLIF(attribution.ctwa_clid, '') IS NOT NULL
        AND (
          ($2::integer IS NOT NULL AND attribution.conversation_id = $2)
          OR ($3::text <> '' AND RIGHT(regexp_replace(COALESCE(conversation.phone_number, ''), '[^0-9]', '', 'g'), 9) = RIGHT($3, 9))
        )
        AND attribution.first_seen_at <= $4::timestamptz + INTERVAL '5 minutes'
        AND attribution.first_seen_at >= $4::timestamptz - INTERVAL '${ATTRIBUTION_LOOKBACK_DAYS} days'
      ORDER BY CASE WHEN attribution.conversation_id = $2 THEN 0 ELSE 1 END,
               attribution.first_seen_at DESC, attribution.id DESC
      LIMIT 1`,
    [organizationId, order.conversation_id, digits, order.event_time]
  );
  return attribution?.ctwa_clid || null;
}

async function purchaseContact(pool, organizationId, phone) {
  const digits = normalizePhone(phone);
  if (!digits) return { contactId: null, optedOut: false };
  const { rows: [contact] } = await pool.query(
    `SELECT MIN(id)::integer AS contact_id,
            BOOL_OR(COALESCE(opt_out,FALSE)) AS opted_out
       FROM contacts
      WHERE organization_id=$1
        AND RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9) = RIGHT($2, 9)`,
    [organizationId, digits]
  );
  return { contactId: contact?.contact_id || null, optedOut: !!contact?.opted_out };
}

async function insertDelivery(pool, organizationId, order, destination, data) {
  const { rows: [delivery] } = await pool.query(
    `INSERT INTO meta_purchase_deliveries (
       organization_id, contact_id, source, order_key, destination, event_id,
       ctwa_clid, phone_hash, value_amount, currency, event_time
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLP',$10)
     ON CONFLICT (organization_id, source, order_key, destination) DO NOTHING
     RETURNING id`,
    [
      organizationId,
      data.contactId || null,
      order.source,
      String(order.order_key),
      destination,
      purchaseEventId(organizationId, order.source, order.order_key),
      data.ctwaClid || null,
      data.phoneHash || null,
      Number(order.value_amount),
      order.event_time,
    ]
  );
  return delivery?.id || null;
}

async function discoverAudienceRemovals(pool, organizationId) {
  const { rowCount } = await pool.query(
    `INSERT INTO meta_purchase_deliveries (
       organization_id, contact_id, source, order_key, destination, event_id,
       phone_hash, value_amount, currency, event_time
     )
     SELECT removal.organization_id, removal.contact_id, removal.source, removal.order_key,
            'audience_remove', removal.event_id || ':remove', removal.phone_hash,
            removal.value_amount, removal.currency, NOW()
       FROM (
         SELECT DISTINCT ON (added.phone_hash) added.*
           FROM meta_purchase_deliveries added
           JOIN contacts contact
             ON contact.id=added.contact_id
            AND contact.organization_id=added.organization_id
          WHERE added.organization_id=$1
            AND added.destination='audience'
            AND added.status='sent'
            AND contact.opt_out=TRUE
            AND added.phone_hash IS NOT NULL
          ORDER BY added.phone_hash, added.id ASC
       ) removal
     ON CONFLICT (organization_id, source, order_key, destination) DO NOTHING`,
    [organizationId]
  );
  return rowCount || 0;
}

async function discoverPurchaseDeliveries({ pool = getPool(), organizationId = null, now = new Date() } = {}) {
  const configurations = await enabledConfigurations(pool, organizationId);
  let discovered = 0;
  for (const configuration of configurations) {
    const orders = await paidOrders(pool, configuration.organization_id, configuration.purchase_sync_since);
    for (const order of orders) {
      const amount = Number(order.value_amount);
      if (!Number.isFinite(amount) || amount < 0) continue;
      const hashedPhone = phoneHash(order.customer_phone);
      const clickId = await purchaseAttribution(pool, configuration.organization_id, order);
      const contact = await purchaseContact(pool, configuration.organization_id, order.customer_phone);
      if (configuration.purchase_audience_id && hashedPhone && !contact.optedOut) {
        discovered += Number(Boolean(await insertDelivery(pool, configuration.organization_id, order, 'audience', {
          phoneHash: hashedPhone,
          contactId: contact.contactId,
        })));
      }
      const eventAgeMs = now.getTime() - new Date(order.event_time).getTime();
      const recentEnough = eventAgeMs >= 0 && eventAgeMs <= PURCHASE_LOOKBACK_DAYS * 86400000;
      if (configuration.conversion_dataset_id && configuration.business_account_id && clickId && recentEnough) {
        discovered += Number(Boolean(await insertDelivery(pool, configuration.organization_id, order, 'purchase', {
          ctwaClid: clickId,
          phoneHash: hashedPhone,
          contactId: contact.contactId,
        })));
      }
    }
    discovered += await discoverAudienceRemovals(pool, configuration.organization_id);
  }
  return discovered;
}

async function claimDelivery(pool, organizationId = null) {
  const values = [];
  let scope = '';
  if (organizationId !== null && organizationId !== undefined) {
    values.push(organizationId);
    scope = `AND delivery.organization_id = $${values.length}`;
  }
  values.push(MAX_ATTEMPTS);
  const attemptPlaceholder = `$${values.length}`;
  const { rows: [delivery] } = await pool.query(
    `WITH candidate AS (
       SELECT delivery.id
         FROM meta_purchase_deliveries delivery
         JOIN meta_connections connection
           ON connection.organization_id = delivery.organization_id
          AND connection.purchase_sync_enabled = TRUE
        WHERE delivery.status IN ('pending','failed')
          AND delivery.attempt_count < ${attemptPlaceholder}
          AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= NOW())
          ${scope}
        ORDER BY delivery.created_at ASC, delivery.id ASC
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT 1
     )
     UPDATE meta_purchase_deliveries delivery
        SET status = 'processing', claimed_at = NOW(), attempt_count = attempt_count + 1, updated_at = NOW()
       FROM candidate
      WHERE delivery.id = candidate.id
      RETURNING delivery.*`,
    values
  );
  return delivery || null;
}

async function releaseStaleDeliveries(pool, organizationId = null) {
  const values = [];
  let scope = '';
  if (organizationId !== null && organizationId !== undefined) {
    values.push(organizationId);
    scope = `AND organization_id = $${values.length}`;
  }
  await pool.query(
    `UPDATE meta_purchase_deliveries
        SET status='failed', last_error='El proceso anterior se interrumpió antes de confirmar el envío',
            next_attempt_at=NOW(), updated_at=NOW()
      WHERE status='processing'
        AND claimed_at < NOW() - INTERVAL '10 minutes'
        ${scope}`,
    values
  );
}

async function deliveryConfiguration(pool, organizationId) {
  const { rows: [configuration] } = await pool.query(
    `SELECT connection.user_access_token, connection.conversion_dataset_id,
            connection.purchase_audience_id, whatsapp.business_account_id
       FROM meta_connections connection
       LEFT JOIN whatsapp_configs whatsapp
         ON whatsapp.organization_id = connection.organization_id
      WHERE connection.organization_id = $1
        AND connection.status = 'connected'
        AND connection.purchase_sync_enabled = TRUE`,
    [organizationId]
  );
  return configuration || null;
}

function retryDelayMinutes(attemptCount) {
  return Math.min(24 * 60, 2 ** Math.max(0, attemptCount - 1));
}

async function markSent(pool, delivery, response) {
  await pool.query(
    `UPDATE meta_purchase_deliveries
        SET status='sent', sent_at=NOW(), response_json=$1::jsonb,
            last_error=NULL, next_attempt_at=NULL, updated_at=NOW()
      WHERE id=$2 AND organization_id=$3`,
    [JSON.stringify(response || {}), delivery.id, delivery.organization_id]
  );
}

async function markFailed(pool, delivery, error) {
  const retryMinutes = retryDelayMinutes(delivery.attempt_count);
  await pool.query(
    `UPDATE meta_purchase_deliveries
        SET status='failed', last_error=$1,
            next_attempt_at=CASE WHEN attempt_count < $2 THEN NOW() + ($3 || ' minutes')::interval ELSE NULL END,
            updated_at=NOW()
      WHERE id=$4 AND organization_id=$5`,
    [String(error || 'Error desconocido').slice(0, 1000), MAX_ATTEMPTS, String(retryMinutes), delivery.id, delivery.organization_id]
  );
}

async function markSkipped(pool, delivery, reason) {
  await pool.query(
    `UPDATE meta_purchase_deliveries
        SET status='skipped', last_error=$1, next_attempt_at=NULL, updated_at=NOW()
      WHERE id=$2 AND organization_id=$3`,
    [String(reason).slice(0, 1000), delivery.id, delivery.organization_id]
  );
}

async function contactOptedOut(pool, delivery) {
  if (!delivery.contact_id) return false;
  const { rows: [contact] } = await pool.query(
    'SELECT opt_out FROM contacts WHERE id=$1 AND organization_id=$2',
    [delivery.contact_id, delivery.organization_id]
  );
  return !!contact?.opt_out;
}

async function sendDelivery(delivery, {
  pool = getPool(),
  graphPost = meta.graphPost,
  graphDelete = meta.graphDelete,
  decryptToken = meta.decryptToken,
} = {}) {
  const configuration = await deliveryConfiguration(pool, delivery.organization_id);
  if (!configuration?.user_access_token) throw new Error('Meta no está conectado para esta organización');
  const token = decryptToken(configuration.user_access_token);
  if (delivery.destination === 'purchase') {
    if (!configuration.conversion_dataset_id || !configuration.business_account_id) {
      throw new Error('Falta configurar el dataset de conversiones o la cuenta de WhatsApp Business');
    }
    const response = await graphPost(
      `${configuration.conversion_dataset_id}/events`,
      token,
      buildPurchasePayload(delivery, { businessAccountId: configuration.business_account_id })
    );
    if (Number(response?.events_received) < 1) throw new Error('Meta no confirmó la recepción del evento Purchase');
    return response;
  }
  if (delivery.destination === 'audience') {
    if (!configuration.purchase_audience_id) throw new Error('Falta configurar la audiencia de compradores');
    if (await contactOptedOut(pool, delivery)) return { skipped: true, reason: 'El contacto se dio de baja antes del envío' };
    return graphPost(
      `${configuration.purchase_audience_id}/users`,
      token,
      buildAudiencePayload(delivery)
    );
  }
  if (delivery.destination === 'audience_remove') {
    if (!configuration.purchase_audience_id) throw new Error('Falta configurar la audiencia de compradores');
    return graphDelete(
      `${configuration.purchase_audience_id}/users`,
      token,
      buildAudiencePayload(delivery)
    );
  }
  throw new Error('Destino de sincronización inválido');
}

async function processPurchaseDeliveries({
  pool = getPool(),
  organizationId = null,
  graphPost = meta.graphPost,
  graphDelete = meta.graphDelete,
  decryptToken = meta.decryptToken,
  limit = 100,
} = {}) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  await releaseStaleDeliveries(pool, organizationId);
  for (let index = 0; index < limit; index++) {
    const delivery = await claimDelivery(pool, organizationId);
    if (!delivery) break;
    try {
      const response = await sendDelivery(delivery, { pool, graphPost, graphDelete, decryptToken });
      if (response?.skipped) {
        await markSkipped(pool, delivery, response.reason);
        skipped++;
        continue;
      }
      await markSent(pool, delivery, response);
      sent++;
    } catch (error) {
      await markFailed(pool, delivery, meta.graphError(error));
      failed++;
    }
  }
  return { sent, failed, skipped };
}

async function runMetaPurchaseSync(options = {}) {
  const pool = options.pool || getPool();
  const discovered = await discoverPurchaseDeliveries({ ...options, pool });
  const processed = await processPurchaseDeliveries({ ...options, pool });
  return { discovered, ...processed };
}

function startMetaPurchaseSyncJob(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return timer;
  const execute = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runMetaPurchaseSync();
      if (result.discovered || result.sent || result.skipped || result.failed) {
        console.log(`[Meta Purchase] descubiertos=${result.discovered} enviados=${result.sent} omitidos=${result.skipped} fallidos=${result.failed}`);
      }
    } catch (error) {
      console.warn('[Meta Purchase] Sincronización pospuesta:', error.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(execute, intervalMs);
  timer.unref?.();
  setTimeout(execute, 10000).unref?.();
  return timer;
}

function stopMetaPurchaseSyncJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  PURCHASE_LOOKBACK_DAYS,
  phoneHash,
  purchaseEventId,
  buildPurchasePayload,
  buildAudiencePayload,
  discoverPurchaseDeliveries,
  releaseStaleDeliveries,
  processPurchaseDeliveries,
  runMetaPurchaseSync,
  startMetaPurchaseSyncJob,
  stopMetaPurchaseSyncJob,
};
