/**
 * dashboard.js — Métricas de victorias semanales (Hooked: variable reward)
 *
 * GET /api/dashboard/wins → resumen de la semana actual
 */

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

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

module.exports = router;
