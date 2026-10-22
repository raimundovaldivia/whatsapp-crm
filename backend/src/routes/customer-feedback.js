const express = require('express');
const { getPool } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('owner', 'admin', 'supervisor'));

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const [{ rows }, { rows: [summary] }] = await Promise.all([
      getPool().query(
        `SELECT f.id, f.conversation_id, f.source, f.order_id, f.order_label,
                f.customer_phone, f.customer_name, f.status, f.score,
                f.sentiment, f.feedback_text, f.sent_at, f.replied_at,
                f.scheduled_for, f.last_error
           FROM customer_feedback_requests f
          WHERE f.organization_id = $1
          ORDER BY COALESCE(f.replied_at, f.sent_at, f.scheduled_for) DESC
          LIMIT $2`,
        [req.orgId, limit]
      ),
      getPool().query(
        `SELECT COUNT(*) FILTER (WHERE status = 'replied')::int AS responses,
                COUNT(*) FILTER (WHERE status = 'sent')::int AS awaiting,
                COUNT(*) FILTER (WHERE sentiment = 'positive')::int AS positive,
                COUNT(*) FILTER (WHERE sentiment = 'negative')::int AS negative,
                ROUND(AVG(score)::numeric, 2) AS average_score
           FROM customer_feedback_requests
          WHERE organization_id = $1`,
        [req.orgId]
      ),
    ]);
    res.json({ success: true, summary, feedback: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'No se pudo cargar el feedback' });
  }
});

module.exports = router;
