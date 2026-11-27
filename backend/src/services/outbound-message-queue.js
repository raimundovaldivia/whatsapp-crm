const db = require('../db/database');
const provider = require('./whatsapp-provider');
const policy = require('./outbound-policy');
const guardrail = require('./response-guardrail');

const ROLES = ['owner', 'admin', 'supervisor', 'agent'];
const invalid = message => Object.assign(new Error(message), { status: 400 });
function validate({ orgId, conversationId, text, sentBy, createdBy }) {
  if (![orgId, conversationId].every(n => Number.isSafeInteger(n) && n > 0)) throw invalid('Conversación inválida');
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 4096) throw invalid('El mensaje debe tener entre 1 y 4096 caracteres');
  if (!['human', 'ai'].includes(sentBy)) throw invalid('Remitente inválido');
  if (sentBy === 'human' && (!Number.isSafeInteger(createdBy) || createdBy < 1)) throw invalid('Usuario requerido');
}

async function publish(io, orgId, message) {
  if (!io || !message) return;
  const conversation = await db.getConversationById(message.conversation_id, orgId);
  io.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message, conversation });
}

async function deferOutsideHours(input, pool = db.getPool()) {
  const { orgId, conversationId, text, sentBy = 'ai', createdBy = null, io, now = new Date() } = input;
  validate({ orgId, conversationId, text, sentBy, createdBy });
  if (policy.isChatMessagingHour(now)) return null;
  const client = await pool.connect();
  let message;
  let replaced = [];
  try {
    await client.query('BEGIN');
    const { rows: [conv] } = await client.query(`SELECT c.id, c.phone_number, c.whatsapp_channel_id, org.slug
      FROM conversations c JOIN organizations org ON org.id=c.organization_id
      WHERE c.id=$1 AND c.organization_id=$2 FOR UPDATE OF c`, [conversationId, orgId]);
    if (!conv) throw Object.assign(new Error('Conversación no encontrada'), { status: 404 });
    if (sentBy === 'human') {
      const { rows: [user] } = await client.query('SELECT role FROM users WHERE id=$1 AND organization_id=$2 AND merged_into_user_id IS NULL', [createdBy, orgId]);
      if (!ROLES.includes(user?.role)) throw Object.assign(new Error('No autorizado'), { status: 403 });
    }
    const context = { state: 'queued', phone: conv.phone_number, channelId: conv.whatsapp_channel_id || null,
      sendingProvider: input.sendingProvider || null, createdBy, queuedAt: now.toISOString() };
    if (sentBy === 'ai' && conv.slug === 'diez-rios-mrs96z69' && Number.isSafeInteger(input.inboundMessageId) && input.inboundMessageId > 0) {
      context.replyToInboundId = input.inboundMessageId;
      const prior = await client.query(`SELECT * FROM messages WHERE conversation_id=$1
        AND sent_by='ai' AND outbound_queue->>'replyToInboundId'=$2 ORDER BY id DESC LIMIT 1`,
      [conversationId, String(input.inboundMessageId)]);
      if (prior.rows[0]) { await client.query('COMMIT'); return prior.rows[0]; }
      const last = await latestChatMessage(client, orgId, conversationId);
      context.inboundAt = inboundTime(input.inboundTimestamp, last?.at);
      context.handoff = input.handoff === true;
      if (isCurrentBotTurn(last, context, now)) context.dueAt = now.toISOString();
      else { context.state = 'review'; context.reason = 'La consulta fue atendida, cambió o venció'; }
    }
    const photo = sentBy === 'ai' ? input.productMedia : null;
    if (photo) context.productMedia = photo;
    const { rows: [existing] } = await client.query(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.organization_id=$1 AND c.id=$2 AND m.content=$3 AND m.sent_by=$4
      AND NOT (m.outbound_queue ? 'orderNotice')
      AND (m.outbound_queue->>'state' IN ('queued','processing') OR
        ($7::boolean AND m.outbound_queue->>'manualReplyBy' IS NOT NULL
         AND m.outbound_queue->>'state' IN ('sent','uncertain')
         AND (m.outbound_queue->>'queuedAt')::timestamptz > $8::timestamptz - INTERVAL '24 hours'
         AND NOT EXISTS (SELECT 1 FROM messages reply WHERE reply.conversation_id=c.id
           AND reply.direction='inbound' AND reply.id>m.id)))
      AND (m.outbound_queue->>'replyToInboundId') IS NOT DISTINCT FROM $9::text
      AND COALESCE(m.outbound_queue->>'createdBy','')=COALESCE($5::text,'')
      AND (m.outbound_queue->'productMedia') IS NOT DISTINCT FROM $6::jsonb ORDER BY m.id DESC LIMIT 1`,
    [orgId, conversationId, text.trim(), sentBy, createdBy, photo ? JSON.stringify(photo) : null, input.manualChatReply === true && sentBy === 'human', now.toISOString(), context.replyToInboundId ? String(context.replyToInboundId) : null]);
    if (existing) { await client.query('COMMIT'); return existing; }
    // Only the latest automatic response remains eligible. Human drafts remain separate.
    if (context.state === 'queued') replaced = (await client.query(`UPDATE messages m SET status='failed', outbound_queue=outbound_queue || '{"state":"cancelled","reason":"Reemplazado por una respuesta más reciente"}'::jsonb
      FROM conversations c WHERE m.conversation_id=c.id AND c.organization_id=$1 AND c.id=$2
      AND m.sent_by='ai' AND m.outbound_queue->>'state'='queued' AND NOT (m.outbound_queue ? 'orderNotice') RETURNING m.*`, [orgId, conversationId])).rows;
    const { rows } = await client.query(`INSERT INTO messages (conversation_id,direction,content,type,status,sent_by,agent_type,ai_provider,ai_model,prompt_version,outbound_queue)
      SELECT c.id,'outbound',$3,'text',CASE WHEN $9::jsonb->>'state'='review' THEN 'failed' ELSE 'pending' END,$4,$5,$6,$7,$8,
        jsonb_build_object('dueAt',
          (((($10::timestamptz AT TIME ZONE 'America/Santiago')::date +
            CASE WHEN EXTRACT(HOUR FROM $10::timestamptz AT TIME ZONE 'America/Santiago') >= $12 THEN 1 ELSE 0 END)
            + make_interval(mins => $11::int)) AT TIME ZONE 'America/Santiago')) || $9::jsonb
      FROM conversations c WHERE c.id=$2 AND c.organization_id=$1 RETURNING *`,
    [orgId, conversationId, text.trim(), sentBy, input.agentType || null, input.aiProvider || null, input.aiModel || null, input.promptVersion || null, JSON.stringify(context), now.toISOString(), policy.CHAT_QUEUE_WINDOW_START_MINUTES, policy.CUSTOMER_WINDOW_END_HOUR]);
    message = rows[0];
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  for (const previous of replaced) await publish(io, orgId, previous);
  await publish(io, orgId, message);
  if (message.outbound_queue.replyToInboundId && message.outbound_queue.state === 'queued') {
    const worker = createWorker({ pool, io, clock: input.now ? () => now : undefined });
    return await worker.sendDue(orgId, message.id) || message;
  }
  if (input.manualChatReply === true && sentBy === 'human') {
    const worker = createWorker({ pool, io, clock: input.now ? () => now : undefined });
    return await worker.sendReplyNow(orgId, conversationId, message.id, createdBy) || message;
  }
  return message;
}

// Only a real message on this conversation can open an after-hours reply.
async function latestChatMessage(pool, orgId, conversationId) {
  const { rows: [last] } = await pool.query(`SELECT m.id, m.direction, m.whatsapp_message_id, m.created_at AT TIME ZONE 'UTC' AS at
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.organization_id=$1 AND c.id=$2 AND m.direction IN ('inbound','outbound')
      AND (m.outbound_queue IS NULL OR m.outbound_queue->>'state' IN ('sent','uncertain'))
      AND m.status IS DISTINCT FROM 'failed'
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1`, [orgId, conversationId]);
  return last;
}

function isOpenReply(last, draft, now) {
  if (!last || last.direction !== 'inbound') return false;
  const at = new Date(last.at).getTime();
  return at > now.getTime() - 24 * 60 * 60 * 1000 && at <= now.getTime()
    && at <= Date.parse(draft.outbound_queue.queuedAt);
}

function inboundTime(timestamp, receivedAt) {
  if (timestamp == null) return receivedAt ? new Date(receivedAt).getTime() : null;
  const value = String(timestamp).trim();
  const time = /^\d+$/.test(value) ? Number(value) * (value.length <= 10 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isCurrentBotTurn(last, context, now) {
  return last?.id === context.replyToInboundId && last.direction === 'inbound' && Boolean(last.whatsapp_message_id)
    && Number.isFinite(context.inboundAt) && context.inboundAt > now.getTime() - 86400000
    && context.inboundAt <= now.getTime();
}

function createWorker({ pool = db.getPool(), send = provider.sendTextMessage, sendMedia = provider.sendMediaMessage, configForConversation = provider.configForConversation, historyForPhone = require('./evolution-whatsapp').latestDirectMessage, checkFreshness = guardrail.checkResponseFreshness, io, clock = () => new Date() } = {}) {
  async function settle(orgId, message, state, reason, status = 'failed') {
    const { rows: [updated] } = await pool.query(`UPDATE messages m SET status=$4,
      outbound_queue=m.outbound_queue || jsonb_build_object('state',$3::text,'reason',$5::text)
      FROM conversations c WHERE m.id=$2 AND m.conversation_id=c.id AND c.organization_id=$1
      AND m.outbound_queue->>'state'='processing' RETURNING m.*`, [orgId, message.id, state, status, reason]);
    await publish(io, orgId, updated);
    return updated;
  }
  async function tick(orgId) {
    if (!Number.isSafeInteger(orgId) || orgId < 1) throw invalid('Organización inválida');
    // A process could have died after provider acceptance. Never retry that attempt.
    const expired = await pool.query(`UPDATE messages m SET outbound_queue=m.outbound_queue || '{"state":"uncertain","reason":"Envío interrumpido; revisar antes de reenviar"}'::jsonb
      FROM conversations c WHERE m.conversation_id=c.id AND c.organization_id=$1
      AND m.outbound_queue->>'state'='processing' AND NOT (m.outbound_queue ? 'orderNotice')
      AND (m.outbound_queue->>'startedAt')::timestamptz < $2::timestamptz - INTERVAL '5 minutes' RETURNING m.*`, [orgId, clock().toISOString()]);
    for (const previous of expired.rows) await publish(io, orgId, previous);
    return sendDue(orgId);
  }

  async function sendDue(orgId, messageId = null) {
    const now = clock();
    const { rows: [message] } = await pool.query(`UPDATE messages m SET outbound_queue=m.outbound_queue || jsonb_build_object('state','processing','startedAt',$2::text)
      WHERE m.id=(SELECT q.id FROM messages q JOIN conversations c ON c.id=q.conversation_id
        WHERE c.organization_id=$1 AND q.outbound_queue->>'state'='queued' AND NOT (q.outbound_queue ? 'orderNotice')
        AND ($3::boolean OR (q.sent_by='ai' AND q.outbound_queue ? 'replyToInboundId'))
        AND ($4::int IS NULL OR q.id=$4)
        AND (q.outbound_queue->>'dueAt')::timestamptz <= $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM messages busy WHERE busy.conversation_id=c.id AND busy.outbound_queue->>'state'='processing')
        ORDER BY q.id FOR UPDATE OF q,c SKIP LOCKED LIMIT 1) RETURNING m.*`, [orgId, now.toISOString(), policy.isChatMessagingHour(now), messageId]);
    if (message) return deliver(orgId, message);
  }

  async function sendReplyNow(orgId, conversationId, messageId, actorId) {
    if (![orgId, conversationId, messageId, actorId].every(n => Number.isSafeInteger(n) && n > 0)) throw invalid('Mensaje inválido');
    // Both the scheduler and the operator acquire the same row and conversation locks.
    const { rows: [message] } = await pool.query(`UPDATE messages m SET outbound_queue=m.outbound_queue ||
      jsonb_build_object('state','processing','startedAt',$5::text)
      WHERE m.id=(SELECT q.id FROM messages q JOIN conversations c ON c.id=q.conversation_id
        JOIN organizations org ON org.id=c.organization_id AND org.slug='diez-rios-mrs96z69'
        JOIN users u ON u.id=$4 AND u.organization_id=c.organization_id AND u.merged_into_user_id IS NULL
        WHERE c.organization_id=$1 AND c.id=$2 AND q.id=$3 AND q.direction='outbound' AND q.sent_by='human'
        AND q.type='text' AND q.outbound_queue->>'state'='queued' AND u.role=ANY($6::text[])
        AND NOT EXISTS (SELECT 1 FROM messages busy WHERE busy.conversation_id=c.id AND busy.outbound_queue->>'state'='processing')
        FOR UPDATE OF q,c SKIP LOCKED) RETURNING m.*`, [orgId, conversationId, messageId, actorId, clock().toISOString(), ROLES]);
    if (message) return deliver(orgId, message, actorId);
    return null;
  }

  async function deliver(orgId, message, actorId = null) {
    const context = message.outbound_queue;
    try {
      const { rows: [conv] } = await pool.query(`SELECT c.*, EXISTS(SELECT 1 FROM messages newer WHERE newer.conversation_id=c.id AND newer.id>$3
        AND (newer.outbound_queue IS NULL OR newer.outbound_queue->>'state'='sent')) AS changed
        FROM conversations c WHERE c.id=$2 AND c.organization_id=$1`, [orgId, message.conversation_id, message.id]);
      if (!conv || conv.changed || conv.phone_number !== context.phone || (conv.whatsapp_channel_id || null) !== context.channelId) {
        return settle(orgId, message, 'review', 'La conversación o el destinatario cambió; revisar el mensaje');
      }
      let remoteLast;
      let config;
      if (actorId) {
        const last = await latestChatMessage(pool, orgId, conv.id);
        if (!isOpenReply(last, message, clock())) {
          // Evolution may have received the inbound while its CRM webhook was disconnected.
          config = await configForConversation(orgId, conv);
          if (config?.provider === 'evolution' && (!context.sendingProvider || context.sendingProvider === 'evolution')) {
            try { remoteLast = await historyForPhone(conv.phone_number, config); }
            catch { /* Unavailable history leaves the draft scheduled. */ }
          }
          if (!isOpenReply(remoteLast, message, clock()) || (last && new Date(last.at) >= new Date(remoteLast.at))) {
            return settle(orgId, message, 'queued', 'Se requiere un mensaje entrante pendiente de las últimas 24 horas en este chat', 'pending');
          }
        }
      }
      const localDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', dateStyle: 'short' }).format(date);
      if (context.queuedAt && localDay(new Date(context.queuedAt)) !== localDay(clock()) && /\b(hoy|ayer|mañana|esta noche|esta tarde)\b/i.test(message.content)) {
        return settle(orgId, message, 'review', 'Cambió el día de una referencia del mensaje; revisar antes de enviar');
      }
      if (message.sent_by === 'human') {
        const { rows: [user] } = await pool.query('SELECT role FROM users WHERE id=$1 AND organization_id=$2 AND merged_into_user_id IS NULL', [context.createdBy, orgId]);
        if (!ROLES.includes(user?.role)) return settle(orgId, message, 'review', 'El usuario ya no tiene permiso para enviar');
      } else if (conv.agent_mode === 'human') {
        return settle(orgId, message, 'review', 'El equipo tomó la conversación');
      }
      if (message.sent_by === 'ai' && String(await db.getSetting(orgId, 'ai_enabled_global')) === 'false') {
        return settle(orgId, message, 'review', 'La atención automática fue desactivada');
      }
      const fresh = await checkFreshness(orgId, conv.id, message.content, {});
      if (!fresh.ok) return settle(orgId, message, 'review', 'Los datos del mensaje requieren revisión');
      const orderIds = [...new Set([...message.content.matchAll(/\bDR-(\d+)\b/gi)].map(match => Number(match[1])))];
      if (orderIds.length) {
        const { rows: orders } = await pool.query(`SELECT id,status,
          (COALESCE(updated_at,created_at) AT TIME ZONE 'UTC') > $4::timestamptz AS changed
          FROM orders WHERE organization_id=$1 AND conversation_id=$2 AND id=ANY($3::int[])`,
        [orgId, conv.id, orderIds, context.queuedAt]);
        if (orders.length !== orderIds.length || orders.some(order => order.changed || ['cancelled','cancelado','entregado','delivered'].includes(order.status))) {
          return settle(orgId, message, 'review', 'El pedido mencionado cambió o ya no está pendiente');
        }
      }
      config = config || await configForConversation(orgId, conv);
      if (!config) return settle(orgId, message, 'review', 'Canal no disponible');
      if (context.sendingProvider && context.sendingProvider !== (config.provider || 'meta')) {
        return settle(orgId, message, 'review', 'El proveedor del chat cambió; revisar el canal de envío');
      }
      // Check again at the transport boundary (a slow lookup may cross 21:00).
      if (actorId) {
        const last = await latestChatMessage(pool, orgId, conv.id);
        const latest = remoteLast && (!last || new Date(remoteLast.at) > new Date(last.at)) ? remoteLast : last;
        if (!isOpenReply(latest, message, clock()) || (last && last.id > message.id)) {
          return settle(orgId, message, 'queued', 'La consulta ya no está pendiente o venció su plazo', 'pending');
        }
        await pool.query(`UPDATE messages SET outbound_queue=outbound_queue || jsonb_build_object('manualReplyBy',$2::int)
          WHERE id=$1 AND outbound_queue->>'state'='processing'`, [message.id, actorId]);
      } else if (message.sent_by === 'ai' && context.replyToInboundId) {
        const last = await latestChatMessage(pool, orgId, conv.id);
        const current = await db.getConversationById(conv.id, orgId);
        const allowedMode = current?.agent_mode === 'ai' || (context.handoff && current?.agent_mode === 'coordinating');
        if (!allowedMode || current.campaign_manual_hold || !isCurrentBotTurn(last, context, clock())
            || String(await db.getSetting(orgId, 'ai_enabled_global')) === 'false') {
          return settle(orgId, message, 'review', 'La consulta cambió o la atención automática está pausada');
        }
      } else if (!policy.isChatMessagingHour(clock())) {
        return settle(orgId, message, 'queued', 'Esperando horario de atención', 'pending');
      }
      const botReply = message.sent_by === 'ai' && Boolean(context.replyToInboundId);
      const photo = botReply ? null : context.productMedia;
      const result = photo ? await sendMedia(conv.phone_number, photo, config)
        : await send(conv.phone_number, message.content, config, { botReply });
      const id = provider.messageId(result);
      if (!id) return settle(orgId, message, 'uncertain', 'WhatsApp no devolvió un identificador; revisar antes de reenviar', 'pending');
      const { rows: [updated] } = await pool.query(`UPDATE messages m SET whatsapp_message_id=$3,status='sent',created_at=$4::timestamptz AT TIME ZONE 'UTC',
        type=CASE WHEN $5::text IS NULL THEN m.type ELSE 'image' END,
        media_id=COALESCE($5::text,m.media_id),content=COALESCE($6::text,m.content),
        outbound_queue=m.outbound_queue || jsonb_build_object('state','sent','sentAt',$4::text)
        FROM conversations c WHERE m.id=$2 AND m.conversation_id=c.id AND c.organization_id=$1
        AND m.outbound_queue->>'state'='processing' RETURNING m.*`, [orgId, message.id, id, clock().toISOString(), photo?.mediaUrl || null, photo?.caption || null]);
      await db.updateConversationLastMessage(conv.id, updated.content);
      await publish(io, orgId, updated);
      if (botReply && context.productMedia) {
        await require('./product-media-delivery').sendSuggested({ suggestion: context.productMedia, orgId,
          conversation: conv, config, io, agentType: message.agent_type });
      }
      return updated;
    } catch (error) {
      return settle(orgId, message, error.is24hWindow ? 'review' : 'uncertain', error.is24hWindow
        ? 'La ventana de WhatsApp venció; requiere revisión del equipo'
        : 'No se pudo confirmar el envío; revisar antes de reenviar', error.is24hWindow ? 'failed' : 'pending');
    }
  }
  return { tick, sendDue, sendReplyNow };
}

let timer;
let running = false;
function start(io) {
  if (timer) return;
  const worker = createWorker({ io });
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await db.getPool().query(`SELECT DISTINCT c.organization_id FROM conversations c JOIN messages m ON m.conversation_id=c.id
        WHERE m.outbound_queue->>'state' IN ('queued','processing') AND NOT (m.outbound_queue ? 'orderNotice')`);
      for (const row of rows) await worker.tick(row.organization_id);
    } catch { console.warn('[OutboundQueue] No se pudo procesar la cola; no se reenvía automáticamente'); }
    finally { running = false; }
  }, 30000);
  timer.unref?.();
}
function stop() { clearInterval(timer); timer = null; }
module.exports = { deferOutsideHours, createWorker, start, stop };
