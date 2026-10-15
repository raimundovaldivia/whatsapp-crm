/**
 * dashboard.js — Métricas de victorias semanales (Hooked: variable reward)
 *
 * GET /api/dashboard/wins → resumen de la semana actual
 */

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('owner', 'admin'));

/**
 * GET /api/dashboard/wins
 * Devuelve métricas de la semana actual (lunes→hoy) para el dashboard de victorias.
 */
router.get('/wins', async (req, res) => {
  try {
    const pool  = getPool();
    const orgId = req.orgId;

    const [
      todaySalesRow,
      todayOrdersRow,
      weekSalesRow,
      weekOrdersRow,
      lastWeekSalesRow,
      dailySalesRows,
      newConvsRow,
      botMsgsRow,
      clientMsgsRow,
      lastWeekNewConvsRow,
      lastWeekBotMsgsRow,
      recentOrderRows,
    ] = await Promise.all([

      // Ventas hoy — shopify_orders + órdenes bot del panel (sin doble conteo)
      pool.query(`
        SELECT COALESCE(SUM(total_price), 0) AS s FROM (
          SELECT total_price::numeric FROM shopify_orders
          WHERE organization_id = $1
            AND shopify_created_at IS NOT NULL
            AND (shopify_created_at AT TIME ZONE 'America/Santiago')::date = (NOW() AT TIME ZONE 'America/Santiago')::date
            AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED','CANCELLED'))
          UNION ALL
          SELECT NULLIF(total_price,'')::numeric FROM orders
          WHERE organization_id = $1
            AND (created_at AT TIME ZONE 'America/Santiago')::date = (NOW() AT TIME ZONE 'America/Santiago')::date
            AND (status IS NULL OR status NOT IN ('cancelled'))
            AND total_price IS NOT NULL AND total_price <> ''
        ) t
      `, [orgId]),

      // Pedidos hoy — shopify + bot
      pool.query(`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM shopify_orders
          WHERE organization_id = $1
            AND shopify_created_at IS NOT NULL
            AND (shopify_created_at AT TIME ZONE 'America/Santiago')::date = (NOW() AT TIME ZONE 'America/Santiago')::date
            AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED','CANCELLED'))
          UNION ALL
          SELECT 1 FROM orders
          WHERE organization_id = $1
            AND (created_at AT TIME ZONE 'America/Santiago')::date = (NOW() AT TIME ZONE 'America/Santiago')::date
            AND (status IS NULL OR status NOT IN ('cancelled'))
        ) t
      `, [orgId]),

      // Ventas esta semana — shopify + bot
      pool.query(`
        SELECT COALESCE(SUM(total_price), 0) AS s FROM (
          SELECT total_price::numeric FROM shopify_orders
          WHERE organization_id = $1
            AND shopify_created_at IS NOT NULL
            AND shopify_created_at >= date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED','CANCELLED'))
          UNION ALL
          SELECT NULLIF(total_price,'')::numeric FROM orders
          WHERE organization_id = $1
            AND created_at >= date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND (status IS NULL OR status NOT IN ('cancelled'))
            AND total_price IS NOT NULL AND total_price <> ''
        ) t
      `, [orgId]),

      // Pedidos esta semana — shopify + bot
      pool.query(`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM shopify_orders
          WHERE organization_id = $1
            AND shopify_created_at IS NOT NULL
            AND shopify_created_at >= date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED','CANCELLED'))
          UNION ALL
          SELECT 1 FROM orders
          WHERE organization_id = $1
            AND created_at >= date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND (status IS NULL OR status NOT IN ('cancelled'))
        ) t
      `, [orgId]),

      // Ventas semana pasada — shopify + bot
      pool.query(`
        SELECT COALESCE(SUM(total_price), 0) AS s FROM (
          SELECT total_price::numeric FROM shopify_orders
          WHERE organization_id = $1
            AND shopify_created_at IS NOT NULL
            AND shopify_created_at >= date_trunc('week', (NOW() - INTERVAL '7 days') AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND shopify_created_at <  date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED','CANCELLED'))
          UNION ALL
          SELECT NULLIF(total_price,'')::numeric FROM orders
          WHERE organization_id = $1
            AND created_at >= date_trunc('week', (NOW() - INTERVAL '7 days') AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND created_at <  date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago'
            AND (status IS NULL OR status NOT IN ('cancelled'))
            AND total_price IS NOT NULL AND total_price <> ''
        ) t
      `, [orgId]),

      // Ventas por día — últimos 7 días, hora local Chile (shopify + bot)
      pool.query(`
        SELECT day, SUM(orders) AS orders, SUM(revenue) AS revenue FROM (
          SELECT (shopify_created_at AT TIME ZONE 'America/Santiago')::date AS day,
                 COUNT(*) AS orders, COALESCE(SUM(total_price), 0) AS revenue
          FROM shopify_orders
          WHERE organization_id = $1
            AND shopify_created_at IS NOT NULL
            AND (shopify_created_at AT TIME ZONE 'America/Santiago')::date >= (NOW() AT TIME ZONE 'America/Santiago')::date - 6
            AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED','CANCELLED'))
          GROUP BY 1
          UNION ALL
          SELECT (created_at AT TIME ZONE 'America/Santiago')::date AS day,
                 COUNT(*) AS orders, COALESCE(SUM(NULLIF(total_price,'')::numeric), 0) AS revenue
          FROM orders
          WHERE organization_id = $1
            AND (created_at AT TIME ZONE 'America/Santiago')::date >= (NOW() AT TIME ZONE 'America/Santiago')::date - 6
            AND (status IS NULL OR status NOT IN ('cancelled'))
            AND total_price IS NOT NULL AND total_price <> ''
          GROUP BY 1
        ) t
        GROUP BY day
        ORDER BY day ASC
      `, [orgId]),

      // Nuevas conversaciones esta semana
      pool.query(`
        SELECT COUNT(*) AS n FROM conversations
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Mensajes bot esta semana
      pool.query(`
        SELECT COUNT(*) AS n FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.direction = 'outbound' AND m.sent_by = 'ai'
          AND m.created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Mensajes clientes esta semana
      pool.query(`
        SELECT COUNT(*) AS n FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.direction = 'inbound'
          AND m.created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Conversaciones semana pasada
      pool.query(`
        SELECT COUNT(*) AS n FROM conversations
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW() - INTERVAL '7 days')
          AND created_at <  date_trunc('week', NOW())
      `, [orgId]),

      // Mensajes bot semana pasada
      pool.query(`
        SELECT COUNT(*) AS n FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.direction = 'outbound' AND m.sent_by = 'ai'
          AND m.created_at >= date_trunc('week', NOW() - INTERVAL '7 days')
          AND m.created_at <  date_trunc('week', NOW())
      `, [orgId]),

      // Últimos 8 pedidos (bot + shopify mezclados)
      pool.query(`
        SELECT customer_name, NULLIF(total_price, '')::numeric AS total_price, status, created_at, 'bot' AS source
        FROM orders
        WHERE organization_id = $1 AND (status IS NULL OR status NOT IN ('cancelled'))
        UNION ALL
        SELECT customer_name, total_price::numeric AS total_price,
               COALESCE(financial_status, 'nuevo') AS status, shopify_created_at AS created_at, 'shopify' AS source
        FROM shopify_orders
        WHERE organization_id = $1
          AND shopify_created_at IS NOT NULL
          AND (financial_status IS NULL OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))
        ORDER BY created_at DESC
        LIMIT 8
      `, [orgId]),
    ]);

    // Construir ventas por día (últimos 7, rellenando días sin datos)
    // r.day viene como DATE de PG → string 'YYYY-MM-DD' sin conversión de zona horaria
    const dayMap = {};
    dailySalesRows.rows.forEach(r => {
      // PG devuelve Date objects para columnas DATE; formatear directo sin toISOString (que aplica UTC)
      const d = r.day;
      const key = typeof d === 'string' ? d.slice(0, 10)
        : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      dayMap[key] = { orders: parseInt(r.orders), revenue: parseFloat(r.revenue) };
    });

    // Generar los últimos 7 días en hora local del servidor (Chile)
    const nowCL = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    const dailySales = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(nowCL);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      dailySales.push({
        date:    key,
        orders:  dayMap[key]?.orders  || 0,
        revenue: dayMap[key]?.revenue || 0,
      });
    }

    res.json({
      success: true,
      data: {
        today: {
          revenue: parseFloat(todaySalesRow.rows[0].s)  || 0,
          orders:  parseInt(todayOrdersRow.rows[0].n)   || 0,
        },
        week: {
          revenue:          parseFloat(weekSalesRow.rows[0].s)    || 0,
          orders:           parseInt(weekOrdersRow.rows[0].n)     || 0,
          newConversations: parseInt(newConvsRow.rows[0].n)       || 0,
          botMessages:      parseInt(botMsgsRow.rows[0].n)        || 0,
          clientMessages:   parseInt(clientMsgsRow.rows[0].n)     || 0,
        },
        lastWeek: {
          revenue:          parseFloat(lastWeekSalesRow.rows[0].s)      || 0,
          newConversations: parseInt(lastWeekNewConvsRow.rows[0].n)     || 0,
          botMessages:      parseInt(lastWeekBotMsgsRow.rows[0].n)      || 0,
        },
        dailySales,
        recentOrders: recentOrderRows.rows.map(o => ({
          customerName: o.customer_name || 'Cliente',
          totalPrice:   parseFloat(o.total_price) || 0,
          status:       o.status,
          createdAt:    o.created_at,
          source:       o.source,
        })),
      },
    });

  } catch (err) {
    console.error('[dashboard/wins]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/personal-offers', async (req, res) => {
  try {
    const days = Number.parseInt(req.query.days || '30', 10);
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
      return res.status(400).json({ success: false, error: 'days debe estar entre 1 y 90' });
    }
    const pool = getPool();
    const params = [req.orgId, days];
    const [summaryResult, tiersResult, dailyResult, priceQualificationResult, inventoryResult, baselineResult] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS detected,
               COUNT(*) FILTER (WHERE po.sent_at IS NOT NULL)::int AS sent,
               COUNT(*) FILTER (WHERE po.status = 'failed')::int AS failed,
               COUNT(*) FILTER (WHERE po.status = 'redeemed')::int AS won,
               COUNT(*) FILTER (WHERE po.status = 'sent' AND po.expires_at <= NOW())::int AS expired,
               COUNT(*) FILTER (WHERE po.sent_at IS NOT NULL AND EXISTS (
                 SELECT 1 FROM messages m
                  WHERE m.conversation_id = po.conversation_id AND m.direction = 'inbound'
                    AND m.created_at > po.sent_at AND m.created_at <= COALESCE(po.redeemed_at, po.expires_at)
               ))::int AS replied,
               COALESCE(SUM(po.redeemed_discount_amount) FILTER (WHERE po.status = 'redeemed'), 0)::numeric AS discounts,
               COALESCE(SUM(NULLIF(o.total_price, '')::numeric) FILTER (WHERE po.status = 'redeemed'), 0)::numeric AS recovered_revenue,
               COALESCE(AVG(NULLIF(o.total_price, '')::numeric) FILTER (WHERE po.status = 'redeemed'), 0)::numeric AS average_ticket,
               COALESCE(SUM(po.redeemed_trays) FILTER (WHERE po.status = 'redeemed'), 0)::int AS trays,
               COALESCE(SUM(recovered.eggs) FILTER (WHERE po.status = 'redeemed'), 0)::int AS eggs,
               COALESCE(SUM((recovered.eggs * po.unit_cost)) FILTER (WHERE po.status = 'redeemed'), 0)::numeric AS estimated_egg_cost
          FROM personal_offers po
          LEFT JOIN orders o ON o.id = po.redeemed_order_id AND o.organization_id = po.organization_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(
              COALESCE((item->>'quantity')::int, 0) *
              COALESCE(NULLIF(SUBSTRING(COALESCE(item->>'name', item->>'title', item->>'product_name', '')
                FROM '[Bb]andeja[[:space:]]+de[[:space:]]+([0-9]+)'), '')::int, 30)
            ), 0)::int AS eggs
            FROM jsonb_array_elements(COALESCE(NULLIF(o.items, '')::jsonb, '[]'::jsonb)) item
            WHERE COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* 'huevos?'
              AND COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* 'bandeja'
              AND COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* '(^|[^[:alnum:]])(xl|l)([^[:alnum:]]|$)'
          ) recovered ON po.status = 'redeemed'
         WHERE po.organization_id = $1
           AND po.created_at >= NOW() - ($2::int * INTERVAL '1 day')
      `, params),
      pool.query(`
        SELECT CASE WHEN redeemed_trays >= 3 THEN '3+' ELSE redeemed_trays::text END AS tier,
               COUNT(*)::int AS won,
               COALESCE(SUM(redeemed_discount_amount), 0)::numeric AS discounts,
               COALESCE(SUM(NULLIF(o.total_price, '')::numeric), 0)::numeric AS revenue,
               COALESCE(AVG(NULLIF(o.total_price, '')::numeric), 0)::numeric AS average_ticket
          FROM personal_offers po
          JOIN orders o ON o.id = po.redeemed_order_id AND o.organization_id = po.organization_id
         WHERE po.organization_id = $1 AND po.status = 'redeemed'
           AND po.created_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY 1 ORDER BY MIN(redeemed_trays)
      `, params),
      pool.query(`
        SELECT (po.created_at AT TIME ZONE 'America/Santiago')::date AS day,
               COUNT(*)::int AS detected,
               COUNT(*) FILTER (WHERE po.sent_at IS NOT NULL)::int AS sent,
               COUNT(*) FILTER (WHERE po.status = 'redeemed')::int AS won,
               COALESCE(SUM(NULLIF(o.total_price, '')::numeric) FILTER (WHERE po.status = 'redeemed'), 0)::numeric AS revenue
          FROM personal_offers po
          LEFT JOIN orders o ON o.id = po.redeemed_order_id AND o.organization_id = po.organization_id
         WHERE po.organization_id = $1
           AND po.created_at >= NOW() - ($2::int * INTERVAL '1 day')
         GROUP BY 1 ORDER BY 1
      `, params),
      pool.query(`
        WITH cohort AS (
          SELECT c.id, c.limbo_reason_code,
                 COALESCE(NULLIF(c.order_draft, ''), '{}')::jsonb #>> '{purchase_feedback,reason}' AS feedback_reason,
                 COALESCE(CASE WHEN c.qualified_at IS NOT NULL THEN c.lead_signals ELSE qa.proposed_signals END, '{}'::jsonb) AS signals
            FROM conversations c
            LEFT JOIN LATERAL (
              SELECT a.proposed_signals
                FROM lead_qualification_audits a
                JOIN lead_qualification_runs r ON r.run_id = a.run_id
                 AND r.organization_id = a.organization_id AND r.status = 'completed'
               WHERE a.organization_id = c.organization_id AND a.conversation_id = c.id
               ORDER BY r.completed_at DESC NULLS LAST, a.id DESC LIMIT 1
            ) qa ON TRUE
           WHERE c.organization_id = $1 AND c.source_channel = 'whatsapp'
             AND c.last_inbound_at >= NOW() - ($2::int * INTERVAL '1 day')
             AND c.last_inbound_at < NOW() - INTERVAL '2 hours'
             AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.organization_id = c.organization_id AND o.conversation_id = c.id AND o.status <> 'cancelled')
        )
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE limbo_reason_code = 'price' OR feedback_reason = 'price' OR signals->>'priceObjection' = 'true')::int AS price_confirmed,
               COUNT(*) FILTER (WHERE limbo_reason_code IS NULL AND feedback_reason IS NULL AND COALESCE(signals->>'priceObjection', 'false') <> 'true' AND signals->>'priceQuestion' = 'true')::int AS price_probable,
               COUNT(*) FILTER (WHERE COALESCE(limbo_reason_code, '') <> 'price' AND COALESCE(feedback_reason, '') <> 'price'
                 AND COALESCE(signals->>'priceObjection', 'false') <> 'true'
                 AND (limbo_reason_code IS NOT NULL OR feedback_reason IS NOT NULL))::int AS other_known,
               COUNT(*) FILTER (WHERE limbo_reason_code IS NULL AND feedback_reason IS NULL AND COALESCE(signals->>'priceObjection', 'false') <> 'true' AND COALESCE(signals->>'priceQuestion', 'false') <> 'true')::int AS unknown
          FROM cohort
      `, params),
      pool.query(`
        WITH sizes AS (
          SELECT CASE
                   WHEN COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* '(^|[^[:alnum:]])xl([^[:alnum:]]|$)' THEN 'XL'
                   WHEN COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* '(^|[^[:alnum:]])l([^[:alnum:]]|$)' THEN 'L'
                 END AS size,
                 COALESCE((item->>'quantity')::int, 0) *
                 COALESCE(NULLIF(SUBSTRING(COALESCE(item->>'name', item->>'title', item->>'product_name', '')
                   FROM '[Bb]andeja[[:space:]]+de[[:space:]]+([0-9]+)'), '')::int, 30) AS eggs
            FROM personal_offers po
            JOIN orders o ON o.id = po.redeemed_order_id AND o.organization_id = po.organization_id
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NULLIF(o.items, '')::jsonb, '[]'::jsonb)) item
           WHERE po.organization_id = $1 AND po.status = 'redeemed'
             AND po.created_at >= NOW() - ($2::int * INTERVAL '1 day')
             AND COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* 'huevos?'
             AND COALESCE(item->>'name', item->>'title', item->>'product_name', '') ~* 'bandeja'
        )
        SELECT wanted.size, COALESCE(SUM(sizes.eggs), 0)::int AS sold,
               CASE wanted.size
                 WHEN 'XL' THEN COALESCE((SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int END FROM settings WHERE organization_id = $1 AND key = 'personal_offer_target_xl_eggs'), 3000)
                 ELSE COALESCE((SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::int END FROM settings WHERE organization_id = $1 AND key = 'personal_offer_target_l_eggs'), 3000)
               END AS target
          FROM (VALUES ('XL'), ('L')) wanted(size)
          LEFT JOIN sizes ON sizes.size = wanted.size
         GROUP BY wanted.size ORDER BY wanted.size DESC
      `, params),
      pool.query(`SELECT captured_at, inventory_xl_eggs, inventory_l_eggs, qualification_summary, configuration
        FROM personal_offer_baselines WHERE organization_id = $1 ORDER BY captured_at DESC LIMIT 1`, [req.orgId]),
    ]);
    const row = summaryResult.rows[0] || {};
    const sent = Number(row.sent) || 0;
    const won = Number(row.won) || 0;
    const replied = Number(row.replied) || 0;
    const revenue = Number(row.recovered_revenue) || 0;
    const estimatedCost = Number(row.estimated_egg_cost) || 0;
    res.json({
      success: true,
      data: {
        periodDays: days,
        detected: Number(row.detected) || 0,
        sent,
        replied,
        won,
        failed: Number(row.failed) || 0,
        expired: Number(row.expired) || 0,
        responseRate: sent ? Math.round(replied * 1000 / sent) / 10 : 0,
        conversionRate: sent ? Math.round(won * 1000 / sent) / 10 : 0,
        recoveredRevenue: revenue,
        averageTicket: Number(row.average_ticket) || 0,
        discounts: Number(row.discounts) || 0,
        trays: Number(row.trays) || 0,
        eggs: Number(row.eggs) || 0,
        estimatedContribution: revenue - estimatedCost,
        baseline: baselineResult.rows[0] || null,
        priceQualification: {
          total: Number(priceQualificationResult.rows[0]?.total) || 0,
          confirmed: Number(priceQualificationResult.rows[0]?.price_confirmed) || 0,
          probable: Number(priceQualificationResult.rows[0]?.price_probable) || 0,
          otherKnown: Number(priceQualificationResult.rows[0]?.other_known) || 0,
          unknown: Number(priceQualificationResult.rows[0]?.unknown) || 0,
        },
        inventory: inventoryResult.rows.map(item => ({
          size: item.size,
          sold: Number(item.sold) || 0,
          target: Number(item.target) || 3000,
          remaining: Math.max(0, (Number(item.target) || 3000) - (Number(item.sold) || 0)),
          unit: 'eggs',
        })),
        tiers: tiersResult.rows.map(tier => ({
          tier: tier.tier, won: Number(tier.won) || 0,
          discounts: Number(tier.discounts) || 0,
          revenue: Number(tier.revenue) || 0,
          averageTicket: Number(tier.average_ticket) || 0,
        })),
        daily: dailyResult.rows.map(day => ({
          date: day.day, detected: Number(day.detected) || 0,
          sent: Number(day.sent) || 0, won: Number(day.won) || 0,
          revenue: Number(day.revenue) || 0,
        })),
      },
    });
  } catch (err) {
    console.error('[dashboard/personal-offers]', err.message);
    res.status(500).json({ success: false, error: 'No se pudieron cargar las métricas de ofertas personales' });
  }
});

module.exports = router;
