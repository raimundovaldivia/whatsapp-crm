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
    const { rows: [conv] } = await client.query('SELECT id, phone_number, whatsapp_channel_id FROM conversations WHERE id=$1 AND organization_id=$2 FOR UPDATE', [conversationId, orgId]);
    if (!conv) throw Object.assign(new Error('Conversación no encontrada'), { status: 404 });
    if (sentBy === 'human') {
      const { rows: [user] } = await client.query('SELECT role FROM users WHERE id=$1 AND organization_id=$2 AND merged_into_user_id IS NULL', [createdBy, orgId]);
      if (!ROLES.includes(user?.role)) throw Object.assign(new Error('No autorizado'), { status: 403 });
    }
    const context = { state: 'queued', phone: conv.phone_number, channelId: conv.whatsapp_channel_id || null,
      sendingProvider: input.sendingProvider || null, createdBy, queuedAt: now.toISOString() };
    const { rows: [existing] } = await client.query(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE c.organization_id=$1 AND c.id=$2 AND m.content=$3 AND m.sent_by=$4
      AND m.outbound_queue->>'state' IN ('queued','processing')
      AND COALESCE(m.outbound_queue->>'createdBy','')=COALESCE($5::text,'') ORDER BY m.id DESC LIMIT 1`,
    [orgId, conversationId, text.trim(), sentBy, createdBy]);
    if (existing) { await client.query('COMMIT'); return existing; }
    // Only the latest automatic response remains eligible. Human drafts remain separate.
    replaced = (await client.query(`UPDATE messages m SET status='failed', outbound_queue=outbound_queue || '{"state":"cancelled","reason":"Reemplazado por una respuesta más reciente"}'::jsonb
      FROM conversations c WHERE m.conversation_id=c.id AND c.organization_id=$1 AND c.id=$2
      AND m.sent_by='ai' AND m.outbound_queue->>'state'='queued' RETURNING m.*`, [orgId, conversationId])).rows;
    const { rows } = await client.query(`INSERT INTO messages (conversation_id,direction,content,type,status,sent_by,agent_type,ai_provider,ai_model,prompt_version,outbound_queue)
      SELECT c.id,'outbound',$3,'text','pending',$4,$5,$6,$7,$8,
        $9::jsonb || jsonb_build_object('dueAt',
          (((($10::timestamptz AT TIME ZONE 'America/Santiago')::date +
            CASE WHEN EXTRACT(HOUR FROM $10::timestamptz AT TIME ZONE 'America/Santiago') >= $12 THEN 1 ELSE 0 END)
            + make_interval(mins => $11::int)) AT TIME ZONE 'America/Santiago'))
      FROM conversations c WHERE c.id=$2 AND c.organization_id=$1 RETURNING *`,
    [orgId, conversationId, text.trim(), sentBy, input.agentType || null, input.aiProvider || null, input.aiModel || null, input.promptVersion || null, JSON.stringify(context), now.toISOString(), policy.CHAT_QUEUE_WINDOW_START_MINUTES, policy.CUSTOMER_WINDOW_END_HOUR]);
    message = rows[0];
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  for (const previous of replaced) await publish(io, orgId, previous);
  await publish(io, orgId, message);
  return message;
}

function createWorker({ pool = db.getPool(), send = provider.sendTextMessage, configForConversation = provider.configForConversation, checkFreshness = guardrail.checkResponseFreshness, io, clock = () => new Date() } = {}) {
  async function settle(orgId, message, state, reason, status = 'failed') {
    const { rows: [updated] } = await pool.query(`UPDATE messages m SET status=$4,
      outbound_queue=m.outbound_queue || jsonb_build_object('state',$3::text,'reason',$5::text)
      FROM conversations c WHERE m.id=$2 AND m.conversation_id=c.id AND c.organization_id=$1
      AND m.outbound_queue->>'state'='processing' RETURNING m.*`, [orgId, message.id, state, status, reason]);
    await publish(io, orgId, updated);
  }
  async function tick(orgId) {
    if (!Number.isSafeInteger(orgId) || orgId < 1) throw invalid('Organización inválida');
    // A process could have died after provider acceptance. Never retry that attempt.
    const expired = await pool.query(`UPDATE messages m SET outbound_queue=m.outbound_queue || '{"state":"uncertain","reason":"Envío interrumpido; revisar antes de reenviar"}'::jsonb
      FROM conversations c WHERE m.conversation_id=c.id AND c.organization_id=$1
      AND m.outbound_queue->>'state'='processing'
      AND (m.outbound_queue->>'startedAt')::timestamptz < $2::timestamptz - INTERVAL '5 minutes' RETURNING m.*`, [orgId, clock().toISOString()]);
    for (const previous of expired.rows) await publish(io, orgId, previous);
    if (!policy.isChatMessagingHour(clock())) return;
    const { rows: [message] } = await pool.query(`UPDATE messages m SET outbound_queue=m.outbound_queue || jsonb_build_object('state','processing','startedAt',$2::text)
      WHERE m.id=(SELECT q.id FROM messages q JOIN conversations c ON c.id=q.conversation_id
        WHERE c.organization_id=$1 AND q.outbound_queue->>'state'='queued'
        AND (q.outbound_queue->>'dueAt')::timestamptz <= $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM messages busy WHERE busy.conversation_id=c.id AND busy.outbound_queue->>'state'='processing')
        ORDER BY q.id FOR UPDATE OF q,c SKIP LOCKED LIMIT 1) RETURNING m.*`, [orgId, clock().toISOString()]);
    if (!message) return;
    const context = message.outbound_queue;
    try {
      const { rows: [conv] } = await pool.query(`SELECT c.*, EXISTS(SELECT 1 FROM messages newer WHERE newer.conversation_id=c.id AND newer.id>$3
        AND (newer.outbound_queue IS NULL OR newer.outbound_queue->>'state'='sent')) AS changed
        FROM conversations c WHERE c.id=$2 AND c.organization_id=$1`, [orgId, message.conversation_id, message.id]);
      if (!conv || conv.changed || conv.phone_number !== context.phone || (conv.whatsapp_channel_id || null) !== context.channelId) {
        return settle(orgId, message, 'review', 'La conversación o el destinatario cambió; revisar el mensaje');
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
      const config = await configForConversation(orgId, conv);
      if (!config) return settle(orgId, message, 'review', 'Canal no disponible');
      if (context.sendingProvider && context.sendingProvider !== (config.provider || 'meta')) {
        return settle(orgId, message, 'review', 'El proveedor del chat cambió; revisar el canal de envío');
      }
      // Check again at the transport boundary (a slow lookup may cross 21:00).
      if (!policy.isChatMessagingHour(clock())) {
        return settle(orgId, message, 'queued', 'Esperando horario de atención', 'pending');
      }
      const result = await send(conv.phone_number, message.content, config);
      const id = provider.messageId(result);
      if (!id) return settle(orgId, message, 'uncertain', 'WhatsApp no devolvió un identificador; revisar antes de reenviar', 'pending');
      const { rows: [updated] } = await pool.query(`UPDATE messages m SET whatsapp_message_id=$3,status='sent',created_at=$4::timestamptz AT TIME ZONE 'UTC',
        outbound_queue=m.outbound_queue || jsonb_build_object('state','sent','sentAt',$4::text)
        FROM conversations c WHERE m.id=$2 AND m.conversation_id=c.id AND c.organization_id=$1
        AND m.outbound_queue->>'state'='processing' RETURNING m.*`, [orgId, message.id, id, clock().toISOString()]);
      await db.updateConversationLastMessage(conv.id, message.content);
      await publish(io, orgId, updated);
    } catch (error) {
      await settle(orgId, message, error.is24hWindow ? 'review' : 'uncertain', error.is24hWindow
        ? 'La ventana de WhatsApp venció; requiere revisión del equipo'
        : 'No se pudo confirmar el envío; revisar antes de reenviar', error.is24hWindow ? 'failed' : 'pending');
    }
  }
  return { tick };
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
        WHERE m.outbound_queue->>'state' IN ('queued','processing')`);
      for (const row of rows) await worker.tick(row.organization_id);
    } catch { console.warn('[OutboundQueue] No se pudo procesar la cola; no se reenvía automáticamente'); }
    finally { running = false; }
  }, 30000);
  timer.unref?.();
}
function stop() { clearInterval(timer); timer = null; }
module.exports = { deferOutsideHours, createWorker, start, stop };
