const db = require('../db/database');
const evolution = require('./evolution-whatsapp');
const policy = require('./outbound-policy');

const GAP_SECONDS = 120;
const LEASE_MINUTES = 10;
const terminalStops = new Set(['entregado', 'partial', 'postponed', 'cancelled', 'not_delivered']);

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function notifyChat(io, orgId, message) {
  if (!io || !message) return;
  try {
    const conversation = await db.getConversationById(message.conversation_id, orgId);
    io.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message, conversation });
  } catch (error) {
    console.warn('[OrderNoticeQueue] No se pudo actualizar la vista del chat:', error.message);
  }
}

function resultFor(message) {
  const state = message.outbound_queue.state;
  if (!['queued', 'processing', 'sent'].includes(state)) {
    throw Object.assign(new Error('Revisa el intento anterior en el chat antes de reenviar.'), { code: 'NOTICE_REQUIRES_REVIEW' });
  }
  return { queued: state !== 'sent', sent: state === 'sent', text: message.content, message,
    messageId: message.whatsapp_message_id, conversationId: message.conversation_id, via: 'text', provider: 'evolution' };
}

async function existing(client, conversationId, ref) {
  if (ref.key) {
    const { rows } = await client.query(`SELECT * FROM messages WHERE conversation_id=$1
      AND outbound_queue->'orderNotice'->'ref'->>'key'=$2 ORDER BY id DESC LIMIT 1`, [conversationId, ref.key]);
    if (rows[0]) return rows[0];
  }
  if (ref.charges?.length) {
    const { rows } = await client.query(`SELECT m.* FROM messages m WHERE conversation_id=$1
      AND outbound_queue->>'state' IN ('queued','processing','uncertain') AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(m.outbound_queue->'orderNotice'->'ref'->'charges') stored
        JOIN jsonb_array_elements($2::jsonb) requested
          ON requested->>'source'=stored->>'source' AND requested->>'id'=stored->>'id')
      LIMIT 1`, [conversationId, JSON.stringify(ref.charges)]);
    if (rows[0]) throw Object.assign(new Error('Ya hay un aviso de cobro pendiente para este pedido.'), { code: 'envio_pendiente' });
  }
  return null;
}

async function enqueue({ orgId, conversationId, phone, channelId, kind, text, agentType, respectSendingHours, ref = {}, io }, pool = db.getPool()) {
  if (!text?.trim() || text.length > 4096) throw new Error('El aviso excede el largo permitido o está vacío.');
  const message = await transaction(pool, async client => {
    const { rows: [conversation] } = await client.query(`SELECT id FROM conversations
      WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, conversationId]);
    if (!conversation) throw new Error('Conversación no encontrada');
    const prior = await existing(client, conversationId, ref);
    if (prior) return prior;
    await client.query('INSERT INTO order_notice_lanes (organization_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
    const orderNotice = { kind, phone, channelId, respectSendingHours, ref };
    const { rows } = await client.query(`INSERT INTO messages
      (conversation_id,direction,content,type,status,sent_by,agent_type,outbound_queue)
      VALUES ($1,'outbound',$2,'text','pending','ai',$3,
        jsonb_build_object('state','queued','queuedAt',NOW(),'dueAt',NOW(),'sendingProvider','evolution','orderNotice',$4::jsonb)) RETURNING *`,
    [conversationId, text, agentType, JSON.stringify(orderNotice)]);
    return rows[0];
  });
  await notifyChat(io, orgId, message);
  return resultFor(message);
}

// A committed claim protects the transport call even if the process exits between sending and recording its receipt.
async function claim(pool, orgId, now) {
  return transaction(pool, async client => {
    const { rows: [lane] } = await client.query(`SELECT * FROM order_notice_lanes
      WHERE organization_id=$1 AND available_at <= $2 FOR UPDATE SKIP LOCKED`, [orgId, now]);
    if (!lane) return null;
    if (lane.active_message_id) {
      await client.query(`UPDATE messages SET outbound_queue=outbound_queue ||
        CASE WHEN outbound_queue ? 'transportAt' THEN '{"state":"uncertain","reason":"Envío interrumpido; verificar en WhatsApp"}'::jsonb
        ELSE '{"state":"queued"}'::jsonb END WHERE id=$1 AND outbound_queue->>'state'='processing'`, [lane.active_message_id]);
      await client.query(`UPDATE order_notice_lanes SET active_message_id=NULL,
        available_at=$2::timestamptz+make_interval(secs=>$3) WHERE organization_id=$1`, [orgId, now, GAP_SECONDS]);
      return null;
    }
    const { rows: [message] } = await client.query(`SELECT m.*, c.phone_number, c.whatsapp_channel_id, c.pipeline_state
      FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.organization_id=$1
      AND m.outbound_queue ? 'orderNotice' AND m.outbound_queue->>'state'='queued'
      AND (m.outbound_queue->>'dueAt')::timestamptz <= $2::timestamptz
      AND (NOT COALESCE((m.outbound_queue->'orderNotice'->>'respectSendingHours')::boolean,false) OR $3)
      AND (m.outbound_queue->'orderNotice'->>'kind' NOT IN ('scheduled_order','customer_feedback') OR $4)
      ORDER BY m.id LIMIT 1 FOR UPDATE OF m`,
    [orgId, now, policy.isChatMessagingHour(now), policy.isCustomerMessagingHour(now)]);
    if (!message) return null;
    const { rows: [claimed] } = await client.query(`UPDATE messages SET outbound_queue=outbound_queue ||
      jsonb_build_object('state','processing','startedAt',$2::timestamptz) WHERE id=$1 RETURNING outbound_queue->>'startedAt' AS stamp`, [message.id, now]);
    message.claimedAt = claimed.stamp;
    await client.query(`UPDATE order_notice_lanes SET active_message_id=$2, available_at=$3::timestamptz+make_interval(mins=>$4)
      WHERE organization_id=$1`, [orgId, message.id, now, LEASE_MINUTES]);
    return message;
  });
}

async function staleReason(pool, orgId, message) {
  const { phone, channelId, ref, kind } = message.outbound_queue.orderNotice;
  if (db.normalizePhone(message.phone_number) !== phone || message.whatsapp_channel_id !== channelId) return 'Cambió el destinatario o el canal';
  const { rows: [opt] } = await pool.query(`SELECT 1 FROM contacts WHERE organization_id=$1 AND opt_out
    AND regexp_replace(phone,'[^0-9]','','g')=$2 LIMIT 1`, [orgId, phone]);
  if (opt || message.pipeline_state === 'opted_out') return 'El contacto solicitó dejar de recibir mensajes';
  if (ref.routeId && ['delivery_consolidated','delivery'].includes(kind)) {
    const { rows: [route] } = await pool.query(`SELECT status, orders, stop_statuses FROM delivery_routes WHERE organization_id=$1 AND id=$2`, [orgId, ref.routeId]);
    const stops = typeof route?.orders === 'string' ? JSON.parse(route.orders) : route?.orders;
    const statuses = typeof route?.stop_statuses === 'string' ? JSON.parse(route.stop_statuses) : route?.stop_statuses;
    if (route?.status !== 'in_progress' || !stops?.some(stop => stop.source + '_' + stop.id === ref.stopKey)
        || terminalStops.has(statuses?.[ref.stopKey])) return 'La parada ya no está en reparto';
  }
  if (ref.charges) {
    const pending = await require('./payment-collection').getPendingCharges(orgId);
    if (ref.charges.some(item => !pending.some(order => order.source === item.source && String(order.id) === item.id
      && Number(order.total_price) === item.total && db.normalizePhone(order.customer_phone) === phone
      && !['pending','pre_verified'].includes(order.proof_status)))) return 'Cambió el saldo o se recibió un comprobante';
  }
  if (ref.feedbackId) {
    const { rows: [request] } = await pool.query('SELECT * FROM customer_feedback_requests WHERE id=$1 AND organization_id=$2', [ref.feedbackId, orgId]);
    if (!request || !['sending','pending'].includes(request.status)) return 'La encuesta ya no está pendiente';
    const state = await require('./customer-feedback').requestEligibility(pool, request);
    if (!state.eligible) return state.reason;
  }
  if (ref.scheduledId) {
    const { rows } = await pool.query("SELECT id FROM scheduled_orders WHERE id=$1 AND organization_id=$2 AND status='pending'", [ref.scheduledId, orgId]);
    if (!rows.length) return 'El pedido agendado ya no está pendiente';
  }
  return null;
}

async function finish(pool, orgId, message, state, reason, messageId, now, attempted) {
  const { ref } = message.outbound_queue.orderNotice;
  return transaction(pool, async client => {
    const { rows: [lane] } = await client.query('SELECT active_message_id FROM order_notice_lanes WHERE organization_id=$1 FOR UPDATE', [orgId]);
    if (lane?.active_message_id !== message.id) return null;
    const sent = state === 'sent';
    const result = await client.query(`UPDATE messages SET whatsapp_message_id=$2, status=$3,
      created_at=CASE WHEN $4='sent' THEN $5::timestamptz AT TIME ZONE 'UTC' ELSE created_at END,
      outbound_queue=outbound_queue || jsonb_build_object('state',$4::text,'reason',$6::text)
        || CASE WHEN $4='sent' THEN jsonb_build_object('sentAt',$5::timestamptz)
          WHEN $4='queued' THEN jsonb_build_object('dueAt',$5::timestamptz+interval '30 seconds') ELSE '{}'::jsonb END
      WHERE id=$1 AND outbound_queue->>'state'='processing' AND outbound_queue->>'startedAt'=$7 RETURNING *`,
    [message.id, messageId, sent || ['queued','uncertain'].includes(state) ? 'pending' : 'failed', state, now, reason, message.claimedAt]);
    if (!result.rows.length) throw new Error('El aviso perdió su turno.');
    const delay = attempted ? GAP_SECONDS : state === 'queued' ? 30 : 0;
    await client.query(`UPDATE order_notice_lanes SET active_message_id=NULL, available_at=$2::timestamptz+make_interval(secs=>$3)
      WHERE organization_id=$1`, [orgId, now, delay]);
    if (ref.deliveryEventId && (sent || state === 'cancelled')) {
      await client.query(`UPDATE delivery_customer_events SET status=$3, sent_at=CASE WHEN $3='sent' THEN NOW() END,
        last_error=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, ref.deliveryEventId, sent ? 'sent' : 'failed', reason]);
    }
    if (ref.feedbackId && (sent || state === 'cancelled')) {
      await require('./customer-feedback').setRequestStatus(client, ref.feedbackId, orgId, sent ? 'sent' : 'skipped', reason, message.conversation_id);
    }
    if (sent && ref.scheduledId) await client.query("UPDATE scheduled_orders SET status='sent', sent_at=NOW() WHERE id=$1 AND organization_id=$2 AND status='pending'", [ref.scheduledId, orgId]);
    if (sent && ref.charges) {
      for (const order of ref.charges) await require('./payment-collection').registerChargeSent(order.source, order.id, orgId, messageId, client);
    }
    return result.rows[0];
  });
}

async function tick(orgId, { pool = db.getPool(), io, clock = () => new Date(), send = evolution.sendTextMessage } = {}) {
  const message = await claim(pool, orgId, clock());
  if (!message) return;
  let state = 'queued', reason = null, receipt = null, attempted = false;
  const notice = message.outbound_queue.orderNotice;
  try {
    reason = await staleReason(pool, orgId, message);
    if (reason) state = 'cancelled';
    else {
      const config = await db.getWhatsappChannel(orgId, notice.channelId);
      if (!config || config.id !== notice.channelId || config.provider !== 'evolution' || config.assigned_user_id) {
        state = 'review'; reason = 'Revisar el canal Evolution del pedido';
      } else if (config.status !== 'connected') reason = 'Esperando conexión de Evolution';
      else if ((notice.respectSendingHours && !policy.isChatMessagingHour(clock())) ||
        (['scheduled_order','customer_feedback'].includes(notice.kind) && !policy.isCustomerMessagingHour(clock()))) reason = 'Esperando horario de atención';
      else {
        const boundary = await pool.query(`UPDATE messages m SET outbound_queue=m.outbound_queue || jsonb_build_object('transportAt',clock_timestamp())
          FROM order_notice_lanes l WHERE m.id=$1 AND l.organization_id=$2 AND l.active_message_id=m.id
          AND m.outbound_queue->>'state'='processing' AND m.outbound_queue->>'startedAt'=$3
          RETURNING m.id`, [message.id, orgId, message.claimedAt]);
        if (!boundary.rows.length) return;
        attempted = true;
        receipt = (await send(notice.phone, message.content, config))?.messageId || null;
        state = receipt ? 'sent' : 'uncertain';
        if (!receipt) reason = 'Evolution no confirmó el envío';
      }
    }
  } catch (error) {
    state = attempted ? 'uncertain' : 'queued';
    reason = attempted ? 'Verificar en WhatsApp antes de reenviar' : 'No se pudo verificar el aviso antes del envío';
    console.warn('[OrderNoticeQueue]', message.id, reason, error.code || error.name);
  }
  const updated = await finish(pool, orgId, message, state, reason, receipt, clock(), attempted);
  await notifyChat(io, orgId, updated);
  if (updated && state === 'sent') {
    await db.updateConversationLastMessage(message.conversation_id, message.content);
    if (notice.ref.scheduledId) {
      await require('./conversation-mode').activateDivaForAutomatedMessage(message.conversation_id, db);
      await db.updatePipelineState(message.conversation_id, 'collecting_order', notice.ref.confirmationDraft);
    }
  }
  return updated;
}

let timer, running;
function start(io) {
  if (timer) return;
  const poll = async () => {
    const { rows } = await db.getPool().query(`SELECT organization_id FROM order_notice_lanes l WHERE available_at<=NOW()
      AND (active_message_id IS NOT NULL OR EXISTS(SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id=c.id
        WHERE c.organization_id=l.organization_id AND m.outbound_queue ? 'orderNotice' AND m.outbound_queue->>'state'='queued'))`);
    for (const row of rows) await tick(row.organization_id, { io });
  };
  timer = setInterval(() => {
    if (!running) running = poll().catch(error => console.warn('[OrderNoticeQueue]', error.message)).finally(() => { running = null; });
  }, 5000);
  timer.unref?.();
}
async function stop() { clearInterval(timer); timer = null; await running; }

module.exports = { enqueue, tick, start, stop, existing, resultFor };
