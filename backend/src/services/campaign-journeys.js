const db = require('../db/database');
const kapso = require('./kapso-whatsapp');
const { activateDivaForAutomatedMessage } = require('./conversation-mode');
const { isCustomerMessagingHour } = require('./outbound-policy');

const ALLOWED_OBJECTIVES = new Set(['promocion', 'reactivacion', 'seguimiento', 'cobranza', 'despacho', 'informativo']);
const ALLOWED_TRIGGERS = new Set(['always', 'no_reply', 'read_no_reply', 'delivered_no_reply']);
const ACTIVE_ORDER_STATUSES = ['nuevo', 'confirmed', 'sent', 'draft', 'pending', 'processing', 'scheduled', 'por_despachar', 'asignado_ruta', 'en_camino', 'no_entregado', 'payment_received'];

function normalizeJourneyInput(input = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw new Error('El nombre de la secuencia es obligatorio y debe tener máximo 120 caracteres');
  const objective = ALLOWED_OBJECTIVES.has(input.objective) ? input.objective : 'promocion';
  const cooldownHours = Math.min(8760, Math.max(0, Number.parseInt(input.cooldownHours, 10) || 48));
  const steps = (Array.isArray(input.steps) ? input.steps : []).map((step, index) => {
    const templateName = String(step?.templateName || '').trim();
    if (!templateName) throw new Error(`El paso ${index + 1} necesita un template`);
    const waitHours = Math.min(8760, Math.max(0, Number.parseInt(step.waitHours, 10) || 0));
    const triggerCondition = index === 0
      ? 'always'
      : (ALLOWED_TRIGGERS.has(step.triggerCondition) ? step.triggerCondition : 'no_reply');
    const variableModes = Array.isArray(step.variableModes) && step.variableModes.length
      ? step.variableModes.slice(0, 20)
      : ['first_name'];
    if (variableModes.some(mode => typeof mode === 'object' && mode?.mode === 'fixed' && !String(mode.value || '').trim())) {
      throw new Error(`El paso ${index + 1} tiene una variable de texto fijo vacía`);
    }
    return { stepOrder: index + 1, templateName, languageCode: step.languageCode || 'es', waitHours, triggerCondition, variableModes };
  });
  if (!steps.length || steps.length > 10) throw new Error('La secuencia debe tener entre 1 y 10 pasos');

  const seen = new Set();
  const recipients = [];
  for (const recipient of Array.isArray(input.recipients) ? input.recipients : []) {
    const phone = db.normalizePhone(String(recipient?.phone || '').replace(/\D/g, ''));
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    recipients.push({ phone, name: String(recipient?.name || recipient?.contactName || 'Cliente').trim() || 'Cliente' });
  }
  if (!recipients.length || recipients.length > 5000) throw new Error('El público debe tener entre 1 y 5.000 contactos válidos');
  return {
    name, objective, cooldownHours, steps, recipients,
    audienceFilters: input.audienceFilters && typeof input.audienceFilters === 'object' ? input.audienceFilters : {},
    stopOnReply: input.stopOnReply !== false,
    stopOnOrder: input.stopOnOrder !== false,
    stopOnHuman: input.stopOnHuman !== false,
  };
}

async function createJourney(orgId, userId, input, pool = db.getPool()) {
  const data = normalizeJourneyInput(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [journey] } = await client.query(`
      INSERT INTO campaign_journeys
        (organization_id,created_by,name,objective,audience_filters,cooldown_hours,stop_on_reply,stop_on_order,stop_on_human)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [orgId, userId, data.name, data.objective, JSON.stringify(data.audienceFilters), data.cooldownHours,
      data.stopOnReply, data.stopOnOrder, data.stopOnHuman]);
    for (const step of data.steps) {
      await client.query(`
        INSERT INTO campaign_journey_steps
          (journey_id,step_order,template_name,language_code,wait_hours,trigger_condition,variable_modes)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [journey.id, step.stepOrder, step.templateName, step.languageCode, step.waitHours,
        step.triggerCondition, JSON.stringify(step.variableModes)]);
    }
    for (const recipient of data.recipients) {
      await client.query(`
        INSERT INTO campaign_journey_enrollments
          (journey_id,organization_id,phone,contact_name,status)
        VALUES ($1,$2,$3,$4,'draft') ON CONFLICT(journey_id,phone) DO NOTHING
      `, [journey.id, orgId, recipient.phone, recipient.name]);
    }
    await client.query(`
      INSERT INTO campaign_journey_events(journey_id,organization_id,event_type,detail)
      VALUES ($1,$2,'created',$3)
    `, [journey.id, orgId, JSON.stringify({ recipients: data.recipients.length, steps: data.steps.length })]);
    await client.query('COMMIT');
    return { ...journey, steps: data.steps, recipientCount: data.recipients.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateDraft(orgId, journeyId, input, pool = db.getPool()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [journey] } = await client.query('SELECT * FROM campaign_journeys WHERE id=$1 AND organization_id=$2 FOR UPDATE', [journeyId, orgId]);
    if (!journey || journey.status !== 'draft') throw new Error('Solo se pueden editar borradores de tu organización');
    const { rows: recipients } = await client.query('SELECT phone,contact_name AS name FROM campaign_journey_enrollments WHERE journey_id=$1', [journeyId]);
    const data = normalizeJourneyInput({ ...input, name: journey.name, recipients });
    const { rows: steps } = await client.query('SELECT * FROM campaign_journey_steps WHERE journey_id=$1 ORDER BY step_order', [journeyId]);
    if (steps.length !== data.steps.length) throw new Error('No se puede cambiar la cantidad de pasos desde este editor');
    for (let i = 0; i < steps.length; i++) {
      await client.query('UPDATE campaign_journey_steps SET template_name=$1,variable_modes=$2 WHERE id=$3 AND journey_id=$4',
        [data.steps[i].templateName, JSON.stringify(data.steps[i].variableModes), steps[i].id, journeyId]);
    }
    await client.query('UPDATE campaign_journeys SET updated_at=NOW() WHERE id=$1', [journeyId]);
    await client.query('COMMIT');
    return { success: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function activateJourney(orgId, journeyId, pool = db.getPool(), options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [journey] } = await client.query(
      `SELECT * FROM campaign_journeys WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [journeyId, orgId]
    );
    if (!journey) throw new Error('Secuencia no encontrada');
    if (options.retryExcluded && journey.status !== 'completed') throw new Error('Solo se pueden reprocesar excluidos de campañas finalizadas');
    if (options.retryExcluded) {
      journey.cooldown_hours = 24;
      await client.query('UPDATE campaign_journeys SET cooldown_hours=24 WHERE id=$1', [journey.id]);
    }
    if (!['draft', 'paused', ...(options.retryExcluded ? ['completed'] : [])].includes(journey.status)) throw new Error('La secuencia no se puede activar desde su estado actual');
    if (journey.status === 'paused') {
      const { rows: [counts] } = await client.query(`
        SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
               COUNT(*) FILTER (WHERE status IN ('stopped','excluded','failed'))::int AS excluded
          FROM campaign_journey_enrollments WHERE journey_id=$1
      `, [journey.id]);
      await client.query(`UPDATE campaign_journeys SET status='active',completed_at=NULL,updated_at=NOW() WHERE id=$1`, [journey.id]);
      await client.query(`INSERT INTO campaign_journey_events(journey_id,organization_id,event_type,detail) VALUES($1,$2,'resumed',$3)`,
        [journey.id, orgId, JSON.stringify({ active: counts.active || 0 })]);
      await client.query('COMMIT');
      return { status: 'active', active: counts.active || 0, excluded: counts.excluded || 0, exclusions: {} };
    }
    const { rows: [firstStep] } = await client.query(
      `SELECT * FROM campaign_journey_steps WHERE journey_id=$1 ORDER BY step_order LIMIT 1`, [journey.id]
    );
    if (!firstStep) throw new Error('La secuencia no tiene pasos');
    const { rows: evaluated } = await client.query(`
      WITH decisions AS (
        SELECT e.id,
          CASE
            WHEN EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id=e.organization_id AND c.phone=e.phone AND c.opt_out=TRUE)
              THEN 'baja_marketing'
            WHEN EXISTS (
              SELECT 1 FROM campaign_journey_enrollments other
              JOIN campaign_journeys oj ON oj.id=other.journey_id
               WHERE other.organization_id=e.organization_id AND other.phone=e.phone AND other.status='active'
                 AND other.journey_id<>e.journey_id AND oj.status='active'
            ) THEN 'otra_secuencia_activa'
            WHEN $4::boolean AND EXISTS (
              SELECT 1 FROM orders o WHERE o.organization_id=e.organization_id AND o.customer_phone=e.phone
                AND COALESCE(o.status,'')=ANY($5::text[])
                AND o.delivered_at IS NULL
              UNION ALL
              SELECT 1 FROM shopify_orders so WHERE so.organization_id=e.organization_id AND so.customer_phone=e.phone
                AND COALESCE(so.crm_status,'nuevo')=ANY($5::text[])
                AND so.delivered_at IS NULL
                AND NOT (COALESCE(so.crm_status,'nuevo') IN ('','nuevo') AND (
                  UPPER(COALESCE(so.fulfillment_status,''))='FULFILLED'
                  OR UPPER(COALESCE(so.financial_status,'')) IN ('VOIDED','REFUNDED')
                  OR NULLIF(so.raw_json->>'cancelledAt','') IS NOT NULL
                  OR (so.shopify_created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '60 days'
                    AND so.delivery_date IS NULL AND COALESCE(so.dispatch_count,0)=0
                    AND so.last_attempt_at IS NULL AND so.last_attempt_status IS NULL
                    AND NULLIF(so.delivery_note,'') IS NULL)
                ))
            ) THEN 'pedido_activo'
            WHEN $6::boolean AND EXISTS (
              SELECT 1 FROM conversations cv WHERE cv.organization_id=e.organization_id AND cv.phone_number=e.phone
                AND cv.agent_mode IN ('human','coordinating')
            ) THEN 'atencion_humana'
            WHEN $4::boolean AND EXISTS (
              SELECT 1 FROM contacts c WHERE c.organization_id=e.organization_id AND c.phone=e.phone
                AND c.last_template_sent_at>NOW()-($3::int*INTERVAL '1 hour')
            ) THEN 'contactado_recientemente'
            ELSE NULL
          END AS reason
        FROM campaign_journey_enrollments e
        WHERE e.journey_id=$1 AND e.organization_id=$2 AND e.status IN ('draft','excluded')
          AND e.current_step=0 AND e.last_message_id IS NULL
          AND (NOT $8::boolean OR e.status='excluded')
      )
      UPDATE campaign_journey_enrollments e
         SET status=CASE WHEN decisions.reason IS NULL OR ($8::boolean AND decisions.reason='contactado_recientemente') THEN 'active' ELSE 'excluded' END,
             stop_reason=CASE WHEN $8::boolean AND decisions.reason='contactado_recientemente' THEN NULL ELSE decisions.reason END,
             next_run_at=CASE WHEN $8::boolean AND decisions.reason='contactado_recientemente' THEN
               GREATEST(NOW()+($7::int*INTERVAL '1 hour'), (SELECT MAX(c.last_template_sent_at)+($3::int*INTERVAL '1 hour') FROM contacts c WHERE c.organization_id=e.organization_id AND c.phone=e.phone))
               WHEN decisions.reason IS NULL THEN NOW()+($7::int*INTERVAL '1 hour') ELSE NULL END,
             enrolled_at=CASE WHEN decisions.reason IS NULL OR ($8::boolean AND decisions.reason='contactado_recientemente') THEN NOW() ELSE enrolled_at END,
             locked_at=NULL,updated_at=NOW()
        FROM decisions WHERE e.id=decisions.id
      RETURNING e.status,e.stop_reason
    `, [journey.id, orgId, journey.cooldown_hours,
      ['promocion', 'reactivacion', 'seguimiento'].includes(journey.objective), ACTIVE_ORDER_STATUSES,
      journey.stop_on_human, firstStep.wait_hours, options.retryExcluded === true]);
    const active = evaluated.filter(row => row.status === 'active').length;
    const exclusions = {};
    evaluated.filter(row => row.stop_reason).forEach(row => { exclusions[row.stop_reason] = (exclusions[row.stop_reason] || 0) + 1; });
    const nextStatus = active ? 'active' : 'completed';
    await client.query(`UPDATE campaign_journeys SET status=$1,activated_at=COALESCE(activated_at,NOW()),completed_at=CASE WHEN $1='completed' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$2`, [nextStatus, journey.id]);
    await client.query(`INSERT INTO campaign_journey_events(journey_id,organization_id,event_type,detail) VALUES($1,$2,'activated',$3)`,
      [journey.id, orgId, JSON.stringify({ active, excluded: evaluated.length - active, exclusions })]);
    await client.query('COMMIT');
    return { status: nextStatus, active, excluded: evaluated.length - active, exclusions };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function continuationReason(enrollment, journey, pool) {
  const since = enrollment.last_sent_at || enrollment.enrolled_at;
  const { rows: [state] } = await pool.query(`
    SELECT
      EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id=$1 AND c.phone=$2 AND c.opt_out=TRUE) AS opted_out,
      EXISTS (
        SELECT 1 FROM conversations cv JOIN messages m ON m.conversation_id=cv.id
         WHERE cv.organization_id=$1 AND cv.phone_number=$2 AND m.direction='inbound' AND m.created_at>$3
      ) AS replied,
      EXISTS (
        SELECT 1 FROM orders o WHERE o.organization_id=$1 AND o.customer_phone=$2 AND o.created_at>$3 AND COALESCE(o.status,'')<>'cancelled'
        UNION ALL
        SELECT 1 FROM shopify_orders so WHERE so.organization_id=$1 AND so.customer_phone=$2
          AND COALESCE(so.shopify_created_at,so.synced_at)>$3 AND COALESCE(so.crm_status,'')<>'cancelled'
      ) AS ordered,
      EXISTS (SELECT 1 FROM conversations cv WHERE cv.organization_id=$1 AND cv.phone_number=$2 AND cv.agent_mode IN ('human','coordinating')) AS human_mode,
      EXISTS (
        SELECT 1 FROM conversations cv JOIN messages m ON m.conversation_id=cv.id
         WHERE cv.organization_id=$1 AND cv.phone_number=$2 AND m.direction='outbound' AND m.type='template'
           AND m.created_at>$3 AND m.whatsapp_message_id IS DISTINCT FROM $4
      ) AS later_template
  `, [journey.organization_id, enrollment.phone, since, enrollment.last_message_id]);
  if (state.opted_out) return 'baja_marketing';
  if (state.replied && journey.stop_on_reply) return 'respondio';
  if (state.ordered && journey.stop_on_order) return 'hizo_pedido';
  if (state.human_mode && journey.stop_on_human) return 'atencion_humana';
  if (state.later_template) return 'otro_envio_posterior';
  return null;
}

function getTemplateBody(template) {
  return (template?.components || []).find(component => String(component.type).toUpperCase() === 'BODY')?.text || '';
}

function variableValue(mode, contact, enrollment) {
  const config = typeof mode === 'object' && mode ? mode : { mode };
  const key = config.mode || 'first_name';
  let value;
  if (key === 'fixed') value = String(config.value || '');
  else if (key === 'full_name') value = String(contact?.name || enrollment.contact_name || 'Cliente').trim();
  else if (key === 'phone') value = enrollment.phone;
  else if (key === 'city') value = String(contact?.city || '').trim();
  else if (key === 'total_orders') value = contact?.total_orders == null ? '' : String(contact.total_orders);
  else if (key === 'last_order_date') value = contact?.last_order_at ? new Date(contact.last_order_at).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' }) : '';
  else if (key === 'days_since_order') value = contact?.last_order_at ? String(Math.max(0, Math.floor((Date.now() - new Date(contact.last_order_at).getTime()) / 86400000))) : '';
  else value = String(contact?.name || enrollment.contact_name || 'Cliente').trim().split(/\s+/)[0] || 'Cliente';
  value = value || String(config.fallback || '');
  return value ? `${config.prefix || ''}${value}${config.suffix || ''}` : '';

}

function componentsForStep(step, templateBody, contact, enrollment) {
  const variableNumbers = [...new Set([...String(templateBody).matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  if (!variableNumbers.length) return [];
  const modes = Array.isArray(step.variable_modes) ? step.variable_modes : ['first_name'];
  const parameters = variableNumbers.map((number, index) => {
    const value = variableValue(modes[index] ?? modes[0] ?? 'first_name', contact, enrollment);
    if (!value) throw new Error(`Falta valor para {{${number}}}`);
    return { type: 'text', text: value };
  });
  return [{ type: 'body', parameters }];
}

function renderBody(body, components) {
  const parameters = components?.find(component => component.type === 'body')?.parameters || [];
  let index = 0;
  return String(body || '').replace(/\{\{\d+\}\}/g, () => String(parameters[index++]?.text || ''));
}

async function deliveryTriggerReady(enrollment, step, pool) {
  if (enrollment.current_step === 0 || step.trigger_condition === 'always' || step.trigger_condition === 'no_reply') return { ready: true };
  const { rows: [message] } = await pool.query(`SELECT status FROM messages WHERE whatsapp_message_id=$1 ORDER BY id DESC LIMIT 1`, [enrollment.last_message_id]);
  const status = String(message?.status || '').toLowerCase();
  if (status === 'failed') return { ready: false, terminal: true, reason: 'mensaje_anterior_fallido' };
  if (step.trigger_condition === 'read_no_reply') return { ready: status === 'read' };
  return { ready: ['delivered', 'read'].includes(status) };
}

async function stopEnrollment(pool, enrollment, reason) {
  await pool.query(`UPDATE campaign_journey_enrollments SET status='stopped',stop_reason=$1,next_run_at=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$2`, [reason, enrollment.id]);
  await pool.query(`INSERT INTO campaign_journey_events(journey_id,enrollment_id,organization_id,event_type,step_order,detail) VALUES($1,$2,$3,'stopped',$4,$5)`,
    [enrollment.journey_id, enrollment.id, enrollment.organization_id, enrollment.current_step, JSON.stringify({ reason })]);
}

async function runJourneyEnrollments(io = null, now = new Date(), pool = db.getPool(), scope = {}) {
  if (!isCustomerMessagingHour(now)) return { processed: 0, reason: 'outside_customer_hours' };
  const { rows: due } = await pool.query(`
    UPDATE campaign_journey_enrollments e
       SET locked_at=NOW(),updated_at=NOW()
     WHERE e.id IN (
       SELECT candidate.id FROM campaign_journey_enrollments candidate
       JOIN campaign_journeys j ON j.id=candidate.journey_id
        WHERE candidate.status='active' AND j.status='active' AND candidate.next_run_at<=NOW()
          AND ($1::int IS NULL OR j.organization_id=$1) AND ($2::int IS NULL OR j.id=$2)
          AND (candidate.locked_at IS NULL OR candidate.locked_at<NOW()-INTERVAL '15 minutes')
        ORDER BY candidate.next_run_at,candidate.id FOR UPDATE SKIP LOCKED LIMIT 50
     ) RETURNING e.*
  `, [scope.orgId || null, scope.journeyId || null]);
  const templateCache = new Map();
  const campaignCache = new Map();
  let processed = 0;
  for (const enrollment of due) {
    try {
      const { rows: [journey] } = await pool.query(`SELECT * FROM campaign_journeys WHERE id=$1 AND organization_id=$2`, [enrollment.journey_id, enrollment.organization_id]);
      if (!journey || journey.status !== 'active') {
        await stopEnrollment(pool, enrollment, 'secuencia_no_activa');
        continue;
      }
      const { rows: steps } = await pool.query(`SELECT * FROM campaign_journey_steps WHERE journey_id=$1 ORDER BY step_order`, [journey.id]);
      const step = steps.find(candidate => Number(candidate.step_order) === Number(enrollment.current_step) + 1);
      if (!step) {
        await pool.query(`UPDATE campaign_journey_enrollments SET status='completed',next_run_at=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1`, [enrollment.id]);
        continue;
      }
      const stopReason = await continuationReason(enrollment, journey, pool);
      if (stopReason) {
        await stopEnrollment(pool, enrollment, stopReason);
        continue;
      }
      const trigger = await deliveryTriggerReady(enrollment, step, pool);
      if (!trigger.ready) {
        if (trigger.terminal) await stopEnrollment(pool, enrollment, trigger.reason);
        else await pool.query(`UPDATE campaign_journey_enrollments SET next_run_at=NOW()+INTERVAL '6 hours',locked_at=NULL,updated_at=NOW() WHERE id=$1`, [enrollment.id]);
        continue;
      }

      let templates = templateCache.get(journey.organization_id);
      let wc;
      if (!templates) {
        wc = await db.getWhatsappConfig(journey.organization_id);
        if (!wc || !['kapso', 'meta'].includes(wc.provider)) throw new Error('WhatsApp oficial no está configurado para templates');
        templates = await kapso.getTemplates(wc);
        templateCache.set(journey.organization_id, templates);
      } else {
        wc = await db.getWhatsappConfig(journey.organization_id);
      }
      const template = templates.find(candidate => candidate.name === step.template_name);
      if (!template) throw new Error(`Template ${step.template_name} no disponible`);
      const body = getTemplateBody(template);
      const contact = await db.getContact(journey.organization_id, enrollment.phone);
      const components = componentsForStep(step, body, contact, enrollment);

      const campaignKey = `${journey.id}:${step.step_order}`;
      let campaign = campaignCache.get(campaignKey);
      if (!campaign) {
        const { rows: [created] } = await pool.query(`
          INSERT INTO broadcast_campaigns(organization_id,created_by,template_name,total_count,status,sending_provider)
          VALUES($1,$2,$3,$4,'processing',$5) RETURNING *
        `, [journey.organization_id, journey.created_by, step.template_name,
          due.filter(item => item.journey_id === journey.id && Number(item.current_step) + 1 === Number(step.step_order)).length, wc.provider]);
        campaign = created;
        campaignCache.set(campaignKey, campaign);
      }

      const sent = await kapso.sendTemplate(enrollment.phone, step.template_name, step.language_code || 'es', components, wc);
      const messageId = sent?.messages?.[0]?.id || null;
      await pool.query(`
        INSERT INTO broadcast_campaign_recipients
          (campaign_id,organization_id,destination_phone,original_phone,contact_name,template_name,language_code,template_components,result_status,whatsapp_message_id)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,'accepted',$8)
      `, [campaign.id, journey.organization_id, enrollment.phone, contact?.name || enrollment.contact_name,
        step.template_name, step.language_code || 'es', JSON.stringify(components), messageId]);
      const rendered = renderBody(body, components);
      const content = `[Template: ${step.template_name}]\n\n${rendered}`;
      const conv = await db.upsertConversation(journey.organization_id, enrollment.phone, contact?.name || enrollment.contact_name || 'Cliente');
      const saved = await db.saveMessage({
        conversationId: conv.id, whatsappMessageId: messageId || `journey_${journey.id}_${enrollment.id}_${step.step_order}`,
        content, direction: 'outbound', type: 'template', sentBy: 'ai', agentType: 'campaign_journey', status: 'pending',
      });
      await db.updateConversationLastMessage(conv.id, content);
      await activateDivaForAutomatedMessage(conv.id, db);
      await db.updatePipelineState(conv.id, 'template_sent');
      await pool.query(`UPDATE contacts SET last_template_sent_at=NOW() WHERE organization_id=$1 AND phone=$2`, [journey.organization_id, enrollment.phone]);
      if (saved) io?.to(`org_${journey.organization_id}`).emit(`new_message_${journey.organization_id}`, { message: saved, conversation: conv });

      const nextStep = steps.find(candidate => Number(candidate.step_order) === Number(step.step_order) + 1);
      await pool.query(`
        UPDATE campaign_journey_enrollments
           SET current_step=$1,last_sent_at=NOW(),last_message_id=$2,last_campaign_id=$3,
               status=$4,next_run_at=CASE WHEN $4='active' THEN NOW()+($5::int*INTERVAL '1 hour') ELSE NULL END,
               failure_count=0,locked_at=NULL,updated_at=NOW()
         WHERE id=$6
      `, [step.step_order, messageId, campaign.id, nextStep ? 'active' : 'completed', nextStep?.wait_hours || 0, enrollment.id]);
      await pool.query(`INSERT INTO campaign_journey_events(journey_id,enrollment_id,organization_id,event_type,step_order,detail) VALUES($1,$2,$3,'sent',$4,$5)`,
        [journey.id, enrollment.id, journey.organization_id, step.step_order, JSON.stringify({ templateName: step.template_name, campaignId: campaign.id, messageId })]);
      processed++;
    } catch (error) {
      const failures = Number(enrollment.failure_count || 0) + 1;
      await pool.query(`
        UPDATE campaign_journey_enrollments
           SET failure_count=$1,status=CASE WHEN $1>=3 THEN 'failed' ELSE 'active' END,
               stop_reason=$2,next_run_at=CASE WHEN $1>=3 THEN NULL ELSE NOW()+INTERVAL '1 hour' END,
               locked_at=NULL,updated_at=NOW() WHERE id=$3
      `, [failures, error.message, enrollment.id]);
      await pool.query(`INSERT INTO campaign_journey_events(journey_id,enrollment_id,organization_id,event_type,step_order,detail) VALUES($1,$2,$3,'send_failed',$4,$5)`,
        [enrollment.journey_id, enrollment.id, enrollment.organization_id, Number(enrollment.current_step) + 1, JSON.stringify({ error: error.message, failures })]);
    }
  }
  for (const campaign of campaignCache.values()) {
    await pool.query(`UPDATE broadcast_campaigns SET status='completed',completed_at=NOW() WHERE id=$1`, [campaign.id]);
  }
  await pool.query(`
    UPDATE campaign_journeys j SET status='completed',completed_at=NOW(),updated_at=NOW()
     WHERE j.status='active' AND NOT EXISTS (
       SELECT 1 FROM campaign_journey_enrollments e WHERE e.journey_id=j.id AND e.status='active'
     )
  `);
  return { processed, examined: due.length };
}

async function listJourneys(orgId, pool = db.getPool()) {
  const { rows } = await pool.query(`
    SELECT j.*,
      COUNT(e.id)::int AS audience_count,
      COUNT(e.id) FILTER (WHERE e.status='active')::int AS active_count,
      COUNT(e.id) FILTER (WHERE e.status='completed')::int AS completed_count,
      COUNT(e.id) FILTER (WHERE e.status IN ('stopped','excluded','failed'))::int AS excluded_count,
      (SELECT COUNT(*)::int FROM campaign_journey_steps s WHERE s.journey_id=j.id) AS step_count
    FROM campaign_journeys j LEFT JOIN campaign_journey_enrollments e ON e.journey_id=j.id
    WHERE j.organization_id=$1 GROUP BY j.id ORDER BY j.created_at DESC LIMIT 100
  `, [orgId]);
  return rows;
}

async function journeyDetail(orgId, journeyId, pool = db.getPool()) {
  const { rows: [journey] } = await pool.query(`SELECT * FROM campaign_journeys WHERE id=$1 AND organization_id=$2`, [journeyId, orgId]);
  if (!journey) return null;
  const [{ rows: steps }, { rows: enrollments }, { rows: events }] = await Promise.all([
    pool.query(`SELECT * FROM campaign_journey_steps WHERE journey_id=$1 ORDER BY step_order`, [journey.id]),
    pool.query(`SELECT * FROM campaign_journey_enrollments WHERE journey_id=$1 ORDER BY id LIMIT 5000`, [journey.id]),
    pool.query(`SELECT * FROM campaign_journey_events WHERE journey_id=$1 ORDER BY created_at DESC LIMIT 200`, [journey.id]),
  ]);
  return { ...journey, steps, enrollments, events };
}

async function setJourneyStatus(orgId, journeyId, status, pool = db.getPool()) {
  if (!['paused', 'cancelled'].includes(status)) throw new Error('Estado inválido');
  const { rows: [journey] } = await pool.query(`
    UPDATE campaign_journeys SET status=$1,updated_at=NOW(),completed_at=CASE WHEN $1='cancelled' THEN NOW() ELSE completed_at END
     WHERE id=$2 AND organization_id=$3 AND status IN ('active','paused','draft') RETURNING *
  `, [status, journeyId, orgId]);
  return journey || null;
}

async function getThreadContext(orgId, phone, pool = db.getPool()) {
  const normalized = db.normalizePhone(String(phone || '').replace(/\D/g, ''));
  const { rows: [row] } = await pool.query(`
    SELECT j.name,j.objective,j.stop_on_reply,e.current_step,e.last_sent_at,e.status,
           (SELECT COUNT(*)::int FROM campaign_journey_steps s WHERE s.journey_id=j.id) AS total_steps,
           (SELECT template_name FROM campaign_journey_steps s WHERE s.journey_id=j.id AND s.step_order=e.current_step) AS last_template
      FROM campaign_journey_enrollments e JOIN campaign_journeys j ON j.id=e.journey_id
     WHERE e.organization_id=$1 AND e.phone=$2 AND e.status='active' AND j.status='active'
     ORDER BY e.updated_at DESC LIMIT 1
  `, [orgId, normalized]);
  return row || null;
}

async function activeJourneyForPhone(orgId, phone, pool = db.getPool()) {
  const normalized = db.normalizePhone(String(phone || '').replace(/\D/g, ''));
  const { rows: [row] } = await pool.query(`
    SELECT j.id,j.name,j.objective,e.current_step
      FROM campaign_journey_enrollments e JOIN campaign_journeys j ON j.id=e.journey_id
     WHERE e.organization_id=$1 AND e.phone=$2 AND e.status='active' AND j.status='active'
     ORDER BY e.updated_at DESC LIMIT 1
  `, [orgId, normalized]);
  return row || null;
}

async function registerInbound(orgId, phone, pool = db.getPool()) {
  const normalized = db.normalizePhone(String(phone || '').replace(/\D/g, ''));
  const { rows: [context] } = await pool.query(`
    SELECT e.id AS enrollment_id,e.journey_id,e.current_step,e.last_sent_at,
           j.name,j.objective,j.stop_on_reply,
           (SELECT COUNT(*)::int FROM campaign_journey_steps s WHERE s.journey_id=j.id) AS total_steps,
           (SELECT template_name FROM campaign_journey_steps s WHERE s.journey_id=j.id AND s.step_order=e.current_step) AS last_template
      FROM campaign_journey_enrollments e JOIN campaign_journeys j ON j.id=e.journey_id
     WHERE e.organization_id=$1 AND e.phone=$2 AND e.status='active' AND j.status='active'
     ORDER BY e.updated_at DESC LIMIT 1
  `, [orgId, normalized]);
  if (!context) return null;
  if (context.stop_on_reply) {
    await pool.query(`UPDATE campaign_journey_enrollments SET status='stopped',stop_reason='respondio',next_run_at=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1`, [context.enrollment_id]);
    await pool.query(`INSERT INTO campaign_journey_events(journey_id,enrollment_id,organization_id,event_type,step_order,detail) VALUES($1,$2,$3,'stopped',$4,$5)`,
      [context.journey_id, context.enrollment_id, orgId, context.current_step, JSON.stringify({ reason: 'respondio', immediate: true })]);
  }
  return { ...context, automationStopped: !!context.stop_on_reply };
}

function startJourneyRunner(io = null) {
  setTimeout(() => runJourneyEnrollments(io).catch(error => console.error('[CampaignJourneys]', error.message)), 4 * 60 * 1000);
  const timer = setInterval(() => runJourneyEnrollments(io).catch(error => console.error('[CampaignJourneys]', error.message)), 10 * 60 * 1000);
  timer.unref?.();
}

module.exports = {
  ALLOWED_OBJECTIVES, ALLOWED_TRIGGERS, normalizeJourneyInput, createJourney, updateDraft, activateJourney,
  runJourneyEnrollments, listJourneys, journeyDetail, setJourneyStatus, getThreadContext,
  activeJourneyForPhone, registerInbound, componentsForStep, renderBody, startJourneyRunner,
};
