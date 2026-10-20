const db = require('../db/database');
const deliveryNotifications = require('./delivery-notifications');
const { isCustomerMessagingHour } = require('./outbound-policy');

const DISCOVERY_SQL = `
  WITH delivered AS (
    SELECT o.organization_id, 'bot'::text AS source, o.id::text AS order_id,
           ('#DR-' || o.id::text) AS order_label, o.conversation_id,
           o.customer_phone, o.customer_name, o.delivered_at
      FROM orders o
     WHERE o.delivered_at IS NOT NULL
    UNION ALL
    SELECT so.organization_id, 'shopify'::text, so.shopify_order_id,
           COALESCE(so.shopify_name, '#' || so.shopify_order_id), NULL::integer,
           so.customer_phone, so.customer_name, so.delivered_at
      FROM shopify_orders so
     WHERE so.delivered_at IS NOT NULL
  ), ranked AS (
    SELECT d.*,
           RIGHT(regexp_replace(COALESCE(d.customer_phone, ''), '[^0-9]', '', 'g'), 9) AS phone_key,
           ROW_NUMBER() OVER (
             PARTITION BY d.organization_id,
                          RIGHT(regexp_replace(COALESCE(d.customer_phone, ''), '[^0-9]', '', 'g'), 9)
             ORDER BY d.delivered_at, d.source, d.order_id
           ) AS purchase_number
      FROM delivered d
     WHERE length(regexp_replace(COALESCE(d.customer_phone, ''), '[^0-9]', '', 'g')) >= 9
  ), candidates AS (
    SELECT r.*, COALESCE(r.conversation_id, matched_conversation.id) AS resolved_conversation_id
      FROM ranked r
      LEFT JOIN LATERAL (
        SELECT c.id
          FROM conversations c
         WHERE c.organization_id = r.organization_id
           AND RIGHT(regexp_replace(COALESCE(c.phone_number, ''), '[^0-9]', '', 'g'), 9) = r.phone_key
         ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
         LIMIT 1
      ) matched_conversation ON TRUE
     WHERE r.purchase_number = 1
       AND r.delivered_at <= NOW() - INTERVAL '24 hours'
       AND r.delivered_at > NOW() - INTERVAL '72 hours'
  )
  INSERT INTO customer_feedback_requests
    (organization_id, conversation_id, source, order_id, order_label,
     customer_phone, customer_name, status, scheduled_for)
  SELECT organization_id, resolved_conversation_id, source, order_id, order_label,
         phone_key, customer_name, 'pending', delivered_at + INTERVAL '24 hours'
    FROM candidates
   WHERE resolved_conversation_id IS NOT NULL
  ON CONFLICT (organization_id, customer_phone) DO NOTHING`;

function normalizeText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function parseFeedbackReply(message) {
  const raw = String(message || '').trim();
  if (!raw || raw.length > 500) return null;
  const text = normalizeText(raw);
  if (/\b(bandejas?|cajas?|huevos?|queso|quiero|pedido\s+nuevo|mandame|enviame)\b/.test(text)) return null;

  const scoreMatch = text.match(/^([1-5])(?:\s*\/\s*5|\s*estrellas?)?(?:\s|[.,!]|$)/);
  if (scoreMatch) {
    const score = Number(scoreMatch[1]);
    return { score, sentiment: score >= 4 ? 'positive' : 'negative', text: raw };
  }

  const negative = /\b(mala?|pesim[oa]|regular|decepcionad[oa]|no\s+me\s+gusto|no\s+quede\s+conforme|podria\s+mejorar|llego\s+mal|venia\s+mal)\b/.test(text);
  const positive = /\b(excelente|muy\s+bien|todo\s+bien|buena\s+experiencia|me\s+encanto|feliz|conforme|impecable)\b/.test(text);
  if (negative) return { score: null, sentiment: 'negative', text: raw };
  if (positive) return { score: null, sentiment: 'positive', text: raw };
  return null;
}

async function discoverFirstPurchaseFeedback(pool = db.getPool()) {
  const result = await pool.query(DISCOVERY_SQL);
  return result.rowCount || 0;
}

async function claimDueRequests(pool = db.getPool(), limit = 20) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const { rows } = await pool.query(`
    WITH due AS (
      SELECT id
        FROM customer_feedback_requests
       WHERE (status = 'pending' OR (status = 'sending' AND updated_at < NOW() - INTERVAL '15 minutes'))
         AND scheduled_for <= NOW() AND attempt_count < 5
       ORDER BY scheduled_for, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
    )
    UPDATE customer_feedback_requests f
       SET status = 'sending', attempt_count = attempt_count + 1, updated_at = NOW()
      FROM due
     WHERE f.id = due.id
     RETURNING f.*`, [safeLimit]);
  return rows;
}

async function requestEligibility(pool, request) {
  const { rows: [state] } = await pool.query(`
    SELECT c.agent_mode, c.pipeline_state, c.delivery_state,
           COALESCE(contact.opt_out, FALSE) AS opted_out,
           EXISTS (
             SELECT 1 FROM order_returns r
              WHERE r.organization_id = c.organization_id
                AND r.status IN ('requested','scheduled','in_progress','review')
                AND RIGHT(regexp_replace(COALESCE(r.customer->>'phone', ''), '[^0-9]', '', 'g'), 9)
                    = RIGHT(regexp_replace($3, '[^0-9]', '', 'g'), 9)
           ) AS unresolved_return
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT ct.opt_out
          FROM contacts ct
         WHERE ct.organization_id = c.organization_id
           AND RIGHT(regexp_replace(COALESCE(ct.phone, ''), '[^0-9]', '', 'g'), 9)
               = RIGHT(regexp_replace($3, '[^0-9]', '', 'g'), 9)
         ORDER BY ct.updated_at DESC NULLS LAST, ct.id DESC
         LIMIT 1
      ) contact ON TRUE
     WHERE c.id = $1 AND c.organization_id = $2
     LIMIT 1`, [request.conversation_id, request.organization_id, request.customer_phone]);
  if (!state) return { eligible: false, reason: 'CONVERSATION_NOT_FOUND' };
  if (state.opted_out || state.pipeline_state === 'opted_out') return { eligible: false, reason: 'OPTED_OUT' };
  if (state.agent_mode !== 'ai' || state.delivery_state === 'resolution_needed' || state.unresolved_return) {
    return { eligible: false, reason: 'ACTIVE_POST_SALE' };
  }
  return { eligible: true };
}

async function setRequestStatus(pool, id, organizationId, status, error = null) {
  await pool.query(
    `UPDATE customer_feedback_requests
        SET status = $1, last_error = $2,
            sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END,
            updated_at = NOW()
      WHERE id = $3 AND organization_id = $4`,
    [status, error ? String(error).slice(0, 500) : null, id, organizationId]
  );
}

async function runCustomerFeedback(io = null, now = new Date()) {
  const summary = { discovered: 0, sent: 0, skipped: 0, failed: 0 };
  if (!isCustomerMessagingHour(now)) return { ...summary, reason: 'outside_customer_hours' };
  const pool = db.getPool();
  summary.discovered = await discoverFirstPurchaseFeedback(pool);
  const requests = await claimDueRequests(pool);

  for (const request of requests) {
    try {
      const eligibility = await requestEligibility(pool, request);
      if (!eligibility.eligible) {
        await setRequestStatus(pool, request.id, request.organization_id, 'skipped', eligibility.reason);
        summary.skipped++;
        continue;
      }
      const result = await deliveryNotifications.sendCustomerFeedbackRequest(request.organization_id, {
        phone: request.customer_phone,
        customerName: request.customer_name,
        orderName: request.order_label,
        conversationId: request.conversation_id,
      });
      await setRequestStatus(pool, request.id, request.organization_id, 'sent');
      if (io && result?.message) {
        const conversation = await db.getConversationById(request.conversation_id, request.organization_id).catch(() => null);
        io.to(`org_${request.organization_id}`).emit(`new_message_${request.organization_id}`, { message: result.message, conversation });
      }
      summary.sent++;
    } catch (error) {
      const finalFailure = Number(request.attempt_count) >= 5;
      if (finalFailure) {
        await setRequestStatus(pool, request.id, request.organization_id, 'failed', error.code || error.message);
        summary.failed++;
      } else {
        await pool.query(
          `UPDATE customer_feedback_requests
              SET status = 'pending', scheduled_for = NOW() + INTERVAL '6 hours',
                  last_error = $1, updated_at = NOW()
            WHERE id = $2 AND organization_id = $3`,
          [String(error.code || error.message).slice(0, 500), request.id, request.organization_id]
        );
      }
    }
  }
  return summary;
}

async function handleInboundFeedback(orgId, conversationId, message, pool = db.getPool()) {
  const parsed = parseFeedbackReply(message);
  if (!parsed) return null;
  const { rows: [request] } = await pool.query(
    `UPDATE customer_feedback_requests
        SET status = 'replied', replied_at = NOW(), score = $1,
            sentiment = $2, feedback_text = $3, updated_at = NOW()
      WHERE id = (
        SELECT id FROM customer_feedback_requests
         WHERE organization_id = $4 AND conversation_id = $5
           AND status = 'sent' AND sent_at > NOW() - INTERVAL '7 days'
         ORDER BY sent_at DESC LIMIT 1
      )
      RETURNING *`,
    [parsed.score, parsed.sentiment, parsed.text, orgId, conversationId]
  );
  if (!request) return null;
  const negative = parsed.sentiment === 'negative';
  return {
    ...parsed,
    request,
    needsHuman: negative,
    response: negative
      ? 'Gracias por contarnos. Lamento que tu primera experiencia no haya sido la esperada. Le paso tu comentario al equipo para que lo revise contigo por aquí.'
      : '¡Muchas gracias por contarnos! Nos alegra saber que tu primera experiencia fue buena 😊',
  };
}

function startCustomerFeedbackJob(io = null) {
  const intervalMs = 60 * 60 * 1000;
  setTimeout(() => {
    runCustomerFeedback(io).catch(error => console.error('[CustomerFeedback]', error.message));
    setInterval(() => runCustomerFeedback(io).catch(error => console.error('[CustomerFeedback]', error.message)), intervalMs);
  }, 7 * 60 * 1000);
}

module.exports = {
  DISCOVERY_SQL,
  parseFeedbackReply,
  discoverFirstPurchaseFeedback,
  claimDueRequests,
  requestEligibility,
  runCustomerFeedback,
  handleInboundFeedback,
  startCustomerFeedbackJob,
};
