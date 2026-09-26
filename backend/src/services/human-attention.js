const db = require('../db/database');
const assignment = require('./admin-assignment');
const identity = require('./staff-identity');
const { notifyAdmin } = require('./admin-notify');

// Old manual chats are recovered from evidence, without sending anything to customers.
async function pending(orgId = null) {
  const { rows } = await db.getPool().query(`SELECT c.id, c.organization_id, c.phone_number,
    c.contact_name, a.admin_phone, first_in.id AS message_id, first_in.created_at AT TIME ZONE 'UTC' AS pending_since,
    last_in.created_at AT TIME ZONE 'UTC' AS last_inbound_at, last_in.content AS preview
    FROM conversations c
    LEFT JOIN admin_assignments a ON a.organization_id=c.organization_id AND a.conversation_id=c.id
    JOIN LATERAL (SELECT m.id,m.created_at FROM messages m
      WHERE m.conversation_id=c.id AND m.direction='inbound'
      AND m.created_at > COALESCE(c.human_closed_at,'-infinity'::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.conversation_id=c.id
        AND r.direction='outbound' AND r.sent_by='human' AND r.status <> 'failed'
        AND (r.created_at,r.id) > (m.created_at,m.id))
      ORDER BY m.created_at,m.id LIMIT 1) first_in ON TRUE
    JOIN LATERAL (SELECT m.created_at,m.content FROM messages m WHERE m.conversation_id=c.id
      AND m.direction='inbound' ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_in ON TRUE
    WHERE c.agent_mode <> 'ai' AND ($1::int IS NULL OR c.organization_id=$1)
    ORDER BY last_in.created_at DESC,c.id`, [orgId]);
  return rows;
}

async function incoming(orgId, conversation, content) {
  // Keep a claimable case even when it was paused manually or closed in the past.
  await db.getPool().query(`INSERT INTO admin_pending_replies(org_id,conversation_id,customer_phone,context)
    SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM admin_pending_replies
      WHERE org_id=$1 AND conversation_id=$2 AND status='pending')`,
  [orgId,conversation.id,conversation.phone_number,content]);
  const active = await assignment.forConversation(orgId,conversation.id);
  const owner = active && await identity.resolve(orgId,active.admin_phone);
  const recipientPhone = identity.canAttend(owner) ? active.admin_phone : null;
  return notifyAdmin(orgId,{kind:'reply',conversationId:conversation.id,recipientPhone,
    body:`💬 Pendiente de respuesta: ${conversation.contact_name || conversation.phone_number} (#${conversation.id})\n${content}\n\n${recipientPhone ? 'Este cliente sigue asignado a ti.' : `Escribe TOMAR ${conversation.id} para atender.`} CERRAR termina la atención; BOT la devuelve al bot.`});
}

// Minutes inside a configured weekly schedule, including Chilean DST changes.
function businessMinutes(start, end, hours) {
  if (!hours || !Array.isArray(hours.days) || !Number.isInteger(hours.start) ||
      !Number.isInteger(hours.end) || hours.start < 0 || hours.end > 24 || hours.end <= hours.start) return 0;
  const format = new Intl.DateTimeFormat('en-US',{timeZone:hours.timezone || 'America/Santiago',weekday:'short',hour:'numeric',hourCycle:'h23'});
  let minutes=0;
  // Only thresholds up to 30 minutes matter; bound old recovery histories.
  const lower=Math.max(new Date(start).getTime(),new Date(end).getTime()-8*86400000);
  for(let t=lower;t+60000<=new Date(end).getTime();t+=60000) {
    const parts=Object.fromEntries(format.formatToParts(new Date(t)).map(p=>[p.type,p.value]));
    const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
    if(hours.days.includes(day) && Number(parts.hour)>=hours.start && Number(parts.hour)<hours.end) minutes++;
    if(minutes>=30) return minutes;
  }
  return minutes;
}

async function remind(now = new Date()) {
  const cases = await pending();
  const settings = new Map();
  for(const c of cases) {
    if(!settings.has(c.organization_id)) {
      let hours=null;
      try { hours=JSON.parse(await db.getSetting(c.organization_id,'human_attention_hours')); } catch {}
      settings.set(c.organization_id,hours);
    }
    const hours=settings.get(c.organization_id);
    if(!hours || businessMinutes(new Date(now.getTime()-60000),now,hours)===0) continue;
    const waited=businessMinutes(c.pending_since,now,hours);
    const stage=waited>=30 ? 30 : waited>=10 ? 10 : null;
    if(!stage) continue;
    const pool=db.getPool();
    const claimed=await pool.query(`INSERT INTO human_attention_reminders(organization_id,conversation_id,message_id,stage)
      VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,conversation_id,message_id,stage)
      DO UPDATE SET claimed_at=NOW() WHERE human_attention_reminders.completed=FALSE
      AND human_attention_reminders.claimed_at < NOW()-INTERVAL '5 minutes' RETURNING stage`,
    [c.organization_id,c.id,c.message_id,stage]);
    if(!claimed.rows.length) continue;
    // Recheck after claiming: a response/close can have removed the pending case.
    const current=(await pending(c.organization_id)).find(r=>r.id===c.id && r.message_id===c.message_id);
    if(!current) continue;
    const actor=current.admin_phone && await identity.resolve(c.organization_id,current.admin_phone);
    const result=await notifyAdmin(c.organization_id,{kind:'reply',conversationId:c.id,
      recipientPhone:stage===10 && identity.canAttend(actor) ? current.admin_phone : null,
      body:`⏰ ${stage===30 ? 'Escalación al administrador' : 'Recordatorio'}: ${c.contact_name || c.phone_number} (#${c.id}) sigue pendiente de respuesta.\n${c.preview || '[Archivo recibido]'}\n\n${current.admin_phone ? 'Tiene encargado asignado. Revisa el caso en el CRM.' : `Escribe TOMAR ${c.id} para atender.`}`});
    if(result.sent || result.queued) await pool.query(`UPDATE human_attention_reminders SET completed=TRUE
      WHERE organization_id=$1 AND conversation_id=$2 AND message_id=$3 AND stage=$4`,[c.organization_id,c.id,c.message_id,stage]);
  }
}
module.exports={pending,incoming,remind,businessMinutes};
