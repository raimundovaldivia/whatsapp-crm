const db = require('../db/database');
const kapso = require('./kapso-whatsapp');
const { activateDivaForAutomatedMessage } = require('./conversation-mode');
const { isCustomerMessagingHour } = require('./outbound-policy');

const DEFAULT_CONDITIONS = Object.freeze({
  status: 'read',
  noInboundReply: true,
  noOrderAfterMessage: true,
  noLaterTemplate: true,
  respectOptOut: true,
});

function normalizedPhoneSql(column) {
  return `RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 9)`;
}

async function getFollowUpAudience(orgId, campaignId, pool = db.getPool()) {
  const { rows } = await pool.query(`
    SELECT r.*, m.status AS delivery_status, m.created_at AS message_created_at
      FROM broadcast_campaign_recipients r
      JOIN broadcast_campaigns c ON c.id=r.campaign_id AND c.organization_id=r.organization_id
      JOIN messages m ON m.whatsapp_message_id=r.whatsapp_message_id
     WHERE r.organization_id=$1 AND r.campaign_id=$2
       AND r.result_status='accepted' AND m.status='read'
     ORDER BY r.id
  `, [orgId, campaignId]);

  const evaluated = [];
  for (const row of rows) {
    const sentAt = row.message_created_at || row.created_at;
    const phone = row.destination_phone || row.original_phone;
    const { rows: [checks] } = await pool.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM contacts ct
           WHERE ct.organization_id=$1
             AND ${normalizedPhoneSql('ct.phone')}=${normalizedPhoneSql('$2')}
             AND ct.opt_out=TRUE
        ) AS opted_out,
        EXISTS (
          SELECT 1 FROM conversations cv JOIN messages mi ON mi.conversation_id=cv.id
           WHERE cv.organization_id=$1
             AND ${normalizedPhoneSql('cv.phone_number')}=${normalizedPhoneSql('$2')}
             AND mi.direction='inbound' AND mi.created_at>$3
        ) AS replied,
        EXISTS (
          SELECT 1 FROM orders o
           WHERE o.organization_id=$1
             AND ${normalizedPhoneSql('o.customer_phone')}=${normalizedPhoneSql('$2')}
             AND o.created_at>$3 AND COALESCE(o.status,'') <> 'cancelled'
          UNION ALL
          SELECT 1 FROM shopify_orders so
           WHERE so.organization_id=$1
             AND ${normalizedPhoneSql('so.customer_phone')}=${normalizedPhoneSql('$2')}
             AND COALESCE(so.shopify_created_at,so.synced_at)>$3
             AND COALESCE(so.crm_status,'') <> 'cancelled'
        ) AS ordered,
        EXISTS (
          SELECT 1 FROM conversations cv JOIN messages mo ON mo.conversation_id=cv.id
           WHERE cv.organization_id=$1
             AND ${normalizedPhoneSql('cv.phone_number')}=${normalizedPhoneSql('$2')}
             AND mo.direction='outbound' AND mo.type='template' AND mo.created_at>$3
             AND mo.whatsapp_message_id IS DISTINCT FROM $4
        ) AS later_template
    `, [orgId, phone, sentAt, row.whatsapp_message_id]);
    const reasons = [];
    if (checks.opted_out) reasons.push('opt_out');
    if (checks.replied) reasons.push('respondio');
    if (checks.ordered) reasons.push('hizo_pedido');
    if (checks.later_template) reasons.push('recibio_otro_template');
    evaluated.push({ ...row, phone, eligible: reasons.length === 0, reasons });
  }
  return evaluated;
}

function componentsForRecipient(recipient, templateBody) {
  if (Array.isArray(recipient.template_components) && recipient.template_components.length) {
    return recipient.template_components;
  }
  const variables = [...new Set([...String(templateBody || '').matchAll(/\{\{(\d+)\}\}/g)].map(match => match[1]))];
  if (variables.length === 0) return [];
  if (variables.length === 1) {
    const firstName = String(recipient.contact_name || 'Cliente').trim().split(/\s+/)[0] || 'Cliente';
    return [{ type: 'body', parameters: [{ type: 'text', text: firstName }] }];
  }
  throw new Error('No se conservaron los valores de las variables de este destinatario');
}

async function processFollowUpJob(job, io = null) {
  const pool = db.getPool();
  const audience = await getFollowUpAudience(job.organization_id, job.source_campaign_id, pool);
  const wc = await db.getWhatsappConfig(job.organization_id);
  if (!wc || wc.provider !== 'kapso') throw new Error('WhatsApp con Kapso no está configurado');
  if (!await require('./commercial').permitted(job.organization_id, 'marketing')) {
    throw new Error('El módulo de marketing no está disponible');
  }
  const templates = await kapso.getTemplates(wc);
  const template = templates.find(item => item.name === job.template_name);
  if (!template) throw new Error(`Template ${job.template_name} no encontrado`);
  const templateBody = (template.components || []).find(item => String(item.type).toUpperCase() === 'BODY')?.text || '';

  const { rows: [campaign] } = await pool.query(`
    INSERT INTO broadcast_campaigns
      (organization_id, created_by, template_name, total_count, status)
    VALUES ($1,$2,$3,$4,'processing') RETURNING *
  `, [job.organization_id, job.created_by, job.template_name, audience.length]);
  await pool.query('UPDATE broadcast_followup_jobs SET target_campaign_id=$1 WHERE id=$2', [campaign.id, job.id]);

  for (const recipient of audience) {
    if (!recipient.eligible) {
      await pool.query(`
        INSERT INTO broadcast_campaign_recipients
          (campaign_id,organization_id,destination_phone,original_phone,contact_name,
           template_name,language_code,result_status,error_code,error_message)
        VALUES ($1,$2,$3,$3,$4,$5,$6,'skipped','followup_condition',$7)
      `, [campaign.id, job.organization_id, recipient.phone, recipient.contact_name,
        job.template_name, job.language_code, recipient.reasons.join(', ')]);
      continue;
    }
    try {
      const components = componentsForRecipient(recipient, templateBody);
      const sent = await kapso.sendTemplate(recipient.phone, job.template_name, job.language_code, components, wc);
      const messageId = sent?.messages?.[0]?.id || null;
      await pool.query(`
        INSERT INTO broadcast_campaign_recipients
          (campaign_id,organization_id,destination_phone,original_phone,contact_name,
           template_name,language_code,template_components,result_status,whatsapp_message_id)
        VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'accepted',$8)
      `, [campaign.id, job.organization_id, recipient.phone, recipient.contact_name,
        job.template_name, job.language_code, JSON.stringify(components), messageId]);
      try {
        const content = `[Template: ${job.template_name}]\n\n${templateBody}`;
        const conv = await db.upsertConversation(job.organization_id, recipient.phone, recipient.contact_name || 'Cliente');
        const saved = await db.saveMessage({
          conversationId: conv.id,
          whatsappMessageId: messageId || `followup_${job.id}_${recipient.id}`,
          content,
          direction: 'outbound', type: 'template', sentBy: 'ai', agentType: 'follow_up', status: 'pending',
        });
        await db.updateConversationLastMessage(conv.id, content);
        await activateDivaForAutomatedMessage(conv.id, db);
        await db.updatePipelineState(conv.id, 'template_sent');
        await pool.query('UPDATE contacts SET last_template_sent_at=NOW() WHERE organization_id=$1 AND phone=$2', [job.organization_id, recipient.phone]);
        if (saved) io?.to(`org_${job.organization_id}`).emit(`new_message_${job.organization_id}`, { message: saved, conversation: conv });
      } catch (localError) {
        console.error(`[CampaignFollowUp] WhatsApp aceptó ${recipient.phone}, pero falló el guardado local:`, localError.message);
      }
    } catch (error) {
      await pool.query(`
        INSERT INTO broadcast_campaign_recipients
          (campaign_id,organization_id,destination_phone,original_phone,contact_name,
           template_name,language_code,result_status,error_message,error_detail)
        VALUES ($1,$2,$3,$3,$4,$5,$6,'failed',$7,$8)
      `, [campaign.id, job.organization_id, recipient.phone, recipient.contact_name,
        job.template_name, job.language_code, error.message, JSON.stringify({ followupJobId: job.id })]);
    }
  }
  await pool.query("UPDATE broadcast_campaigns SET status='completed',completed_at=NOW() WHERE id=$1", [campaign.id]);
  await pool.query("UPDATE broadcast_followup_jobs SET status='completed',completed_at=NOW() WHERE id=$1", [job.id]);
}

async function runCampaignFollowUps(io = null, now = new Date()) {
  if (!isCustomerMessagingHour(now)) return { processed: 0, reason: 'outside_customer_hours' };
  const pool = db.getPool();
  const { rows: jobs } = await pool.query(`
    UPDATE broadcast_followup_jobs
       SET status='processing',last_error=NULL
     WHERE id IN (
       SELECT id FROM broadcast_followup_jobs
        WHERE status='scheduled' AND scheduled_for<=NOW()
        ORDER BY scheduled_for FOR UPDATE SKIP LOCKED LIMIT 10
     )
     RETURNING *
  `);
  for (const job of jobs) {
    try {
      await processFollowUpJob(job, io);
    } catch (error) {
      await pool.query("UPDATE broadcast_followup_jobs SET status='failed',last_error=$1,completed_at=NOW() WHERE id=$2", [error.message, job.id]);
      console.error(`[CampaignFollowUp] job ${job.id}:`, error.message);
    }
  }
  return { processed: jobs.length };
}

function startCampaignFollowUpJob(io = null) {
  setTimeout(() => runCampaignFollowUps(io), 3 * 60 * 1000);
  setInterval(() => runCampaignFollowUps(io), 10 * 60 * 1000);
}

module.exports = { DEFAULT_CONDITIONS, getFollowUpAudience, runCampaignFollowUps, startCampaignFollowUpJob, componentsForRecipient };
