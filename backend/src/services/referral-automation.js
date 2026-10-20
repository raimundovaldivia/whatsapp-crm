'use strict';
const db = require('../db/database');
const engine = require('./referral-engine');
const { isCustomerMessagingHour } = require('./outbound-policy');
const notifications = require('./delivery-notifications');

async function reminders(orgId) {
  const pool = db.getPool();
  const s = await engine.settings(pool,orgId);
  if (!s.enabled || !s.rules.reminder_days) return;
  const { rows } = await pool.query(`SELECT r.*,m.body,m.customer_name FROM referral_rewards r
    JOIN referral_messages m ON m.organization_id=r.organization_id AND m.reward_id=r.id AND m.dedupe_key='reward:' || r.id
    WHERE r.organization_id=$1 AND r.status='available' AND r.expires_at>NOW() AND m.status='sent'
      AND m.sent_at < NOW()-($2::int*INTERVAL '1 day')
      AND NOT EXISTS(SELECT 1 FROM referral_messages sent WHERE sent.organization_id=$1 AND sent.dedupe_key='reminder:' || r.id)
    ORDER BY r.id LIMIT 100`,[orgId,s.rules.reminder_days]);
  for (const r of rows) await engine.queueMessage(pool,orgId,r.referral_code_id,r.beneficiary_phone,r.customer_name,
    `Te recordamos tu beneficio pendiente. ${r.body}`,`reminder:${r.id}`,s.rules.auto_send,r.id);
}
async function approve(orgId, actorId, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length>100) throw Object.assign(new Error('Selecciona entre 1 y 100 mensajes'),{status:400});
  ids.forEach(engine.positiveId);
  return engine.transaction(orgId,async client => {
    const s = await engine.settings(client,orgId);
    if (!s.enabled) throw Object.assign(new Error('El programa está pausado'),{status:409});
    const { rows } = await client.query(`UPDATE referral_messages SET status='queued',approved_by=$3,last_error=NULL,updated_at=NOW()
      WHERE organization_id=$1 AND id=ANY($2::bigint[]) AND status IN ('draft','blocked') RETURNING id`,[orgId,ids,actorId]);
    await engine.audit(client,orgId,actorId,'messages_approved',{ ids:rows.map(r=>r.id) });
    return { queued:rows.length };
  });
}
async function sendPending(orgId, io = null, now = new Date()) {
  if (!isCustomerMessagingHour(now)) return { sent:0,reason:'Fuera del horario 09:00–21:00 de Chile' };
  const pool = db.getPool();
  // An interrupted send has an unknown outcome. Never automatically resend it.
  await pool.query(`UPDATE referral_messages SET status='uncertain',last_error='Envío interrumpido: revisar el chat antes de cualquier nuevo contacto',updated_at=NOW()
    WHERE organization_id=$1 AND status='sending' AND updated_at<NOW()-INTERVAL '15 minutes'`,[orgId]);
  const s = await engine.settings(pool,orgId);
  if (!s.enabled) return { sent:0,reason:'Programa pausado' };
  const { rows } = await pool.query(`WITH due AS (
    SELECT id FROM referral_messages WHERE organization_id=$1 AND status='queued' AND due_at<=NOW()
      AND ($2::boolean OR approved_by IS NOT NULL) ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 20
  ) UPDATE referral_messages m SET status='sending',updated_at=NOW() FROM due WHERE m.organization_id=$1 AND m.id=due.id RETURNING m.*`,[orgId,s.rules.auto_send]);
  let sent = 0;
  for (const m of rows) {
    try {
      const { rows:[eligible] } = await pool.query(`SELECT rc.active,
        NOT EXISTS(SELECT 1 FROM contacts c WHERE c.organization_id=$1 AND ${engine.phoneSql('c.phone')}=$2 AND c.opt_out=TRUE) AS allowed,
        EXISTS(SELECT 1 FROM conversations c WHERE c.organization_id=$1 AND ${engine.phoneSql('c.phone_number')}=$2
          AND (c.pipeline_state='opted_out' OR c.agent_mode='human' OR c.delivery_state='resolution_needed')) AS paused,
        (m.reward_id IS NULL OR EXISTS(SELECT 1 FROM referral_rewards r WHERE r.organization_id=$1 AND r.id=m.reward_id AND r.status='available' AND r.expires_at>NOW())) AS benefit_valid
        FROM referral_messages m JOIN referral_codes rc ON rc.organization_id=m.organization_id AND rc.id=m.referral_code_id
        WHERE m.organization_id=$1 AND m.id=$3`,[orgId,m.phone,m.id]);
      if (!eligible?.allowed || !eligible?.active || !eligible?.benefit_valid) {
        await pool.query(`UPDATE referral_messages SET status='cancelled',last_error='Cliente excluido, código pausado o beneficio no disponible',updated_at=NOW() WHERE organization_id=$1 AND id=$2`,[orgId,m.id]); continue;
      }
      if (eligible.paused) {
        await pool.query(`UPDATE referral_messages SET status='queued',due_at=NOW()+INTERVAL '1 day',updated_at=NOW() WHERE organization_id=$1 AND id=$2`,[orgId,m.id]); continue;
      }
      const result = await notifications.sendDeliveryNotification(orgId,{phone:m.phone,customerName:m.customer_name},{
        text:m.body,templateText:m.body,assignmentKey:'referral_program',templateLabel:'Programa de referidos',agentType:'referral',
        templateComponents:[{type:'body',parameters:[{type:'text',text:m.body}]}],
      });
      await pool.query(`UPDATE referral_messages SET status='sent',sent_at=NOW(),updated_at=NOW(),last_error=NULL WHERE organization_id=$1 AND id=$2`,[orgId,m.id]);
      sent++;
      if (io && result.message) io.to(`org_${orgId}`).emit(`new_message_${orgId}`,{message:result.message});
    } catch (error) {
      const safeToRetry = ['NO_INBOUND','NO_CONVERSATION','WINDOW_EXPIRED','WHATSAPP_NOT_CONFIGURED','TEMPLATES_NOT_SUPPORTED'].includes(error.code);
      await pool.query('UPDATE referral_messages SET status=$3,last_error=$4,updated_at=NOW() WHERE organization_id=$1 AND id=$2',
        [orgId,m.id,safeToRetry ? 'blocked' : 'uncertain',safeToRetry ? 'Configura la plantilla de referidos y vuelve a aprobar el mensaje' : 'Resultado de envío incierto. Revisa el chat; no se reenviará automáticamente']);
    }
  }
  return { sent };
}
async function run(io) {
  const pool = db.getPool();
  // Tenant discovery only: every business query below is explicitly scoped.
  const { rows } = await pool.query('SELECT organization_id FROM referral_program_settings WHERE rules IS NOT NULL');
  for (const row of rows) {
    const orgId = row.organization_id;
    try {
      const s = await engine.settings(pool,orgId);
      await engine.reconcile(orgId);
      if (!s.enabled) continue;
      if (s.rules.auto_invite) await engine.prepareInvitations(orgId,null,true);
      await reminders(orgId);
      await sendPending(orgId,io);
    } catch (error) { console.error('[Referrals] Automation failed for organization',orgId,error.code || 'REFERRAL_JOB_ERROR'); }
  }
}
let timer, running = false;
function start(io) {
  if (timer) return;
  const tick = async () => { if (running) return; running=true; try { await run(io); } catch { console.error('[Referrals] Job unavailable'); } finally { running=false; } };
  timer = setInterval(tick,60000); timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer=null; }
module.exports = { reminders,approve,sendPending,run,start,stop };
