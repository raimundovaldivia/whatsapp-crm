'use strict';
const { loadCustomerIdentityMap, normalizePhone } = require('./customer-identity');
const { loadPurchases, purchaseSummary } = require('./broadcast-purchases');
const { businessWeek } = require('./conversation-review-rules');

const phoneSQL = column => `(CASE WHEN regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') ~ '^9[0-9]{8}$'
  THEN '56' || regexp_replace(${column}, '[^0-9]', '', 'g') ELSE regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') END)`;

async function loadContext(pool, orgId, rawPhone, now = new Date()) {
  const phone = normalizePhone(rawPhone);
  const identities = await loadCustomerIdentityMap(pool, orgId, [{ phone }]);
  const canonical = identities.get(phone) || phone;
  const phones = [...new Set([phone, ...[...identities.entries()].filter(([, p]) => p === canonical).map(([p]) => p)])];
  const queries = await Promise.all([
    pool.query(`SELECT id, phone, name, client_type, opt_out FROM contacts WHERE organization_id = $1
      AND ${phoneSQL('phone')} = ANY($2::text[]) ORDER BY id`, [orgId, phones]),
    pool.query(`SELECT * FROM (SELECT m.id, m.conversation_id, m.content, m.direction, m.type, m.created_at,
        COALESCE(wc.provider, cfg.provider, 'meta') AS provider, COUNT(*) OVER() AS total_messages
      FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = $1
      LEFT JOIN whatsapp_channels wc ON wc.id = c.whatsapp_channel_id AND wc.organization_id = $1
      LEFT JOIN whatsapp_configs cfg ON cfg.organization_id = $1
      WHERE c.organization_id = $1 AND ${phoneSQL('c.phone_number')} = ANY($2::text[])
        AND wc.assigned_user_id IS NULL AND m.status IS DISTINCT FROM 'failed'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 10000) history ORDER BY created_at, id`, [orgId, phones]),
    pool.query(`SELECT 'crm' AS source, o.id::text, o.created_at AS date, o.status FROM orders o
      LEFT JOIN conversations c ON c.id = o.conversation_id AND c.organization_id = $1
      WHERE o.organization_id = $1 AND ${phoneSQL("COALESCE(NULLIF(o.customer_phone, ''), c.phone_number)")} = ANY($2::text[])
      UNION ALL SELECT 'shopify', shopify_order_id::text, shopify_created_at, financial_status FROM shopify_orders
      WHERE organization_id = $1 AND ${phoneSQL('customer_phone')} = ANY($2::text[]) ORDER BY source, id`, [orgId, phones]),
    pool.query(`SELECT r.id, r.created_at, r.result_status FROM broadcast_campaign_recipients r
      JOIN broadcast_campaigns bc ON bc.id = r.campaign_id AND bc.organization_id = $1
      LEFT JOIN whatsapp_channels wc ON wc.id = bc.sending_channel_id AND wc.organization_id = $1
      WHERE r.organization_id = $1 AND ${phoneSQL('r.destination_phone')} = ANY($2::text[])
        AND r.result_status IN ('accepted', 'unknown') AND wc.assigned_user_id IS NULL
        AND COALESCE(r.template_name, '') !~* '^(cobro|cobranza|pedido_salio|pedido_en_camino|payment|delivery)'
        AND r.created_at >= NOW() - INTERVAL '7 days' ORDER BY r.created_at DESC, r.id DESC`, [orgId, phones]),
    pool.query(`SELECT id, title, price, stock, active, deprecated_at, unit_cost, min_margin_pct
      FROM products WHERE organization_id = $1 AND active = TRUE AND deprecated_at IS NULL ORDER BY id`, [orgId]),
    pool.query(`SELECT id, phone, desired_date, status FROM scheduled_orders WHERE organization_id = $1
      AND ${phoneSQL('phone')} = ANY($2::text[]) AND status = 'pending' ORDER BY id`, [orgId, phones]),
    loadPurchases(pool, orgId, phones),
  ]);
  const [contacts, messages, orderEvents, campaigns, catalog, scheduled, purchases] = queries;
  return { phone, phones, contacts: contacts.rows, messages: messages.rows.map(({ total_messages, ...m }) => m),
    totalMessages: Number(messages.rows[0]?.total_messages || 0), orderEvents: orderEvents.rows.filter(o => o.date),
    campaigns: campaigns.rows, catalog: catalog.rows, pendingScheduled: scheduled.rows, purchases,
    purchaseSummary: purchaseSummary(purchases, businessWeek(now).today) };
}
module.exports = { loadContext, phoneSQL };
