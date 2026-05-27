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

    // ── Semana actual: desde el lunes 00:00 hasta ahora ────────────────────
    const [
      revenueRow,
      ordersRow,
      newConvsRow,
      botMsgsRow,
      totalMsgsRow,
      activityRows,
      recentOrderRows,
      allTimeRevenueRow,
      allTimeOrdersRow,
      lastWeekRevenueRow,
      lastWeekOrdersRow,
      lastWeekNewConvsRow,
      lastWeekBotMsgsRow,
    ] = await Promise.all([

      // Ingresos esta semana (todos los estados — incluye pendientes)
      pool.query(`
        SELECT COALESCE(SUM(total_price::numeric), 0) AS revenue
        FROM orders
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Pedidos creados esta semana
      pool.query(`
        SELECT COUNT(*) AS n
        FROM orders
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Nuevas conversaciones esta semana
      pool.query(`
        SELECT COUNT(*) AS n
        FROM conversations
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Mensajes enviados por el bot esta semana
      pool.query(`
        SELECT COUNT(*) AS n
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.direction = 'outbound'
          AND m.sent_by   = 'ai'
          AND m.created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Total mensajes entrantes esta semana (actividad del cliente)
      pool.query(`
        SELECT COUNT(*) AS n
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.direction = 'inbound'
          AND m.created_at >= date_trunc('week', NOW())
      `, [orgId]),

      // Actividad por día — últimos 7 días
      pool.query(`
        SELECT
          date_trunc('day', m.created_at AT TIME ZONE 'America/Santiago') AS day,
          COUNT(*) FILTER (WHERE m.direction = 'inbound')                              AS inbound,
          COUNT(*) FILTER (WHERE m.direction = 'outbound' AND m.sent_by = 'ai')       AS bot
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.created_at >= NOW() - INTERVAL '6 days'
        GROUP BY date_trunc('day', m.created_at AT TIME ZONE 'America/Santiago')
        ORDER BY day ASC
      `, [orgId]),

      // Últimas 6 órdenes (feed de victorias) + si fue creada por el bot
      pool.query(`
        SELECT id, customer_name, customer_phone, total_price::numeric AS total_price,
               status, created_at,
               (conversation_id IS NOT NULL) AS by_bot
        FROM orders
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 6
      `, [orgId]),

      // Ingresos totales históricos
      pool.query(`
        SELECT COALESCE(SUM(total_price::numeric), 0) AS revenue
        FROM orders
        WHERE organization_id = $1
      `, [orgId]),

      // Pedidos totales históricos
      pool.query(`
        SELECT COUNT(*) AS n
        FROM orders
        WHERE organization_id = $1
      `, [orgId]),

      // ── Semana PASADA (lunes anterior → domingo) ─────────────────────────
      pool.query(`
        SELECT COALESCE(SUM(total_price::numeric), 0) AS revenue
        FROM orders
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW() - INTERVAL '7 days')
          AND created_at <  date_trunc('week', NOW())
      `, [orgId]),

      pool.query(`
        SELECT COUNT(*) AS n FROM orders
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW() - INTERVAL '7 days')
          AND created_at <  date_trunc('week', NOW())
      `, [orgId]),

      pool.query(`
        SELECT COUNT(*) AS n FROM conversations
        WHERE organization_id = $1
          AND created_at >= date_trunc('week', NOW() - INTERVAL '7 days')
          AND created_at <  date_trunc('week', NOW())
      `, [orgId]),

      pool.query(`
        SELECT COUNT(*) AS n
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.direction = 'outbound' AND m.sent_by = 'ai'
          AND m.created_at >= date_trunc('week', NOW() - INTERVAL '7 days')
          AND m.created_at <  date_trunc('week', NOW())
      `, [orgId]),
    ]);

    // ── Construir actividad por día con todos los días aunque no haya datos ─
    const dayMap = {};
    activityRows.rows.forEach(r => {
      const d = new Date(r.day);
      const key = d.toISOString().split('T')[0];
      dayMap[key] = { inbound: parseInt(r.inbound), bot: parseInt(r.bot) };
    });

    const activityByDay = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      activityByDay.push({
        date:    key,
        inbound: dayMap[key]?.inbound || 0,
        bot:     dayMap[key]?.bot     || 0,
      });
    }

    res.json({
      success: true,
      data: {
        week: {
          revenue:          parseFloat(revenueRow.rows[0].revenue)   || 0,
          orders:           parseInt(ordersRow.rows[0].n)            || 0,
          newConversations: parseInt(newConvsRow.rows[0].n)          || 0,
          botMessages:      parseInt(botMsgsRow.rows[0].n)           || 0,
          clientMessages:   parseInt(totalMsgsRow.rows[0].n)         || 0,
        },
        lastWeek: {
          revenue:          parseFloat(lastWeekRevenueRow.rows[0].revenue)   || 0,
          orders:           parseInt(lastWeekOrdersRow.rows[0].n)            || 0,
          newConversations: parseInt(lastWeekNewConvsRow.rows[0].n)          || 0,
          botMessages:      parseInt(lastWeekBotMsgsRow.rows[0].n)           || 0,
        },
        allTime: {
          revenue: parseFloat(allTimeRevenueRow.rows[0].revenue) || 0,
          orders:  parseInt(allTimeOrdersRow.rows[0].n)          || 0,
        },
        activityByDay,
        recentOrders: recentOrderRows.rows.map(o => ({
          id:           o.id,
          customerName: o.customer_name || 'Cliente',
          totalPrice:   parseFloat(o.total_price) || 0,
          status:       o.status,
          createdAt:    o.created_at,
          byBot:        o.by_bot === true || o.by_bot === 't',
        })),
      },
    });

  } catch (err) {
    console.error('[dashboard/wins]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
