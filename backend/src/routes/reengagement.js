/**
 * reengagement.js — Pronóstico de compra con IA
 *
 * GET  /api/reengagement/candidates   → Claude analiza comportamiento de cada cliente
 *                                       y predice cuándo comprará próximamente
 * POST /api/reengagement/generate     → mensaje personalizado para un cliente
 * POST /api/reengagement/send         → envía WhatsApp
 * POST /api/reengagement/send-bulk    → envía a varios clientes
 */

const express   = require('express');
const router    = express.Router();
const db             = require('../db/database');
const { getPool }    = require('../db/database');
const shopifyApi = require('../services/shopify-api');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runBacktesting, applyCalibration } = require('../services/reengagement-calibration');
const { activateDivaForAutomatedMessage } = require('../services/conversation-mode');
const campaignGuard = require('../services/broadcast-campaign-guard');
const { buildCustomerIdentityMap, consolidateCustomerCandidates, loadCustomerIdentityMap } = require('../services/customer-identity');
const {
  getBodyComponent,
  getMissingBodyParameters,
  recoverBodyTemplateComponent,
  renderTemplate,
  renderTemplateFromComponents,
} = require('../utils/template-renderer.mjs');

router.use(requireAuth, requireRole('owner', 'admin', 'supervisor'));

const SERVER_QUEUE = Symbol('serverQueue');
let io;
let broadcastRecoveryStarted = false;
function setSocketIO(socketIO) {
  io = socketIO;
  require('../services/broadcast-worker').start(async job => {
    const response = { status: 200, body: {} };
    await sendBulk({ orgId: job.organization_id, [SERVER_QUEUE]: true,
      body: { campaignId: job.campaign_id, items: [job.item] } }, {
      status(code) { response.status = code; return this; },
      json(body) { response.body = body; return this; },
    });
    return response;
  });
  if (broadcastRecoveryStarted) return;
  broadcastRecoveryStarted = true;
  const timer = setTimeout(async () => {
    try {
      const { rows } = await getPool().query(
        `SELECT DISTINCT w.organization_id
           FROM webhook_inbox w
           LEFT JOIN messages m
             ON m.whatsapp_message_id = w.payload #>> '{message,id}'
           LEFT JOIN broadcast_campaign_recipients r
             ON r.whatsapp_message_id = w.payload #>> '{message,id}'
          WHERE w.provider = 'kapso'
            AND w.payload #>> '{message,type}' = 'template'
            AND w.payload #>> '{message,kapso,origin}' = 'cloud_api'
            AND w.created_at > NOW() - INTERVAL '30 days'
            AND (
              m.id IS NULL
              OR (r.id IS NULL AND EXISTS (
                SELECT 1 FROM broadcast_campaigns c
                 WHERE c.organization_id = w.organization_id
                   AND c.created_at <= w.created_at
                   AND c.created_at > w.created_at - INTERVAL '5 minutes'
              ))
            )`
      );
      for (const row of rows) {
        await reconcileAcceptedBroadcastMessages(row.organization_id);
      }
    } catch (error) {
      console.warn('[SendBulk] No se pudo ejecutar la recuperación inicial:', error.message);
    }
  }, 3000);
  timer.unref?.();
}

function describeBroadcastError(err) {
  const data = err?.response?.data;
  const provider = data?.error || (typeof data === 'object' ? data : null);
  const code = provider?.code != null ? String(provider.code) : null;
  const providerDetail = provider?.error_data?.details || provider?.message;
  const friendlyByCode = {
    '130429': 'WhatsApp limitó temporalmente la cantidad de mensajes enviados.',
    '131026': 'WhatsApp no pudo entregar el mensaje a ese número.',
    '131042': 'La cuenta de WhatsApp tiene un problema de facturación o método de pago.',
    '131047': 'La ventana de atención venció y WhatsApp rechazó el tipo de mensaje.',
    '131048': 'WhatsApp limitó el envío por calidad o volumen para evitar spam.',
    '131049': 'Meta omitió el mensaje para proteger la experiencia del usuario.',
    '132000': 'La cantidad de variables no coincide con el template aprobado.',
    '132001': 'El template o su idioma no existe para esta cuenta de WhatsApp.',
    '132012': 'Una variable tiene un formato que no coincide con el template.',
    '132015': 'Meta pausó el template por baja calidad.',
    '132016': 'Meta deshabilitó el template.',
  };
  return {
    code,
    message: friendlyByCode[code] || providerDetail || err?.message || 'Error desconocido al enviar',
    detail: data && typeof data === 'object' ? data : (err?.message ? { message: err.message } : null),
  };
}

async function getBroadcastCampaign(orgId, campaignId) {
  if (!campaignId) return null;
  const { rows } = await getPool().query(
    'SELECT * FROM broadcast_campaigns WHERE id = $1 AND organization_id = $2',
    [campaignId, orgId]
  );
  return rows[0] || null;
}

async function recordBroadcastRecipient(orgId, campaignId, item, result) {
  if (!campaignId) return;
  await getPool().query(
    `INSERT INTO broadcast_campaign_recipients
       (campaign_id, organization_id, destination_phone, original_phone, contact_name,
        template_name, language_code, template_components, result_status,
        error_code, error_message, error_detail, whatsapp_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [campaignId, orgId, item.phone || null, item.originalPhone || item.phone || null,
      item.contactName || null, item.templateName || null, item.languageCode || 'es',
      item.components ? JSON.stringify(item.components) : null, result.status,
      result.errorCode || null, result.errorMessage || null,
      result.errorDetail ? JSON.stringify(result.errorDetail) : null,
      result.whatsappMessageId || null]
  );
}

/**
 * Recupera la auditoría de campañas cuyos mensajes sí quedaron en el chat,
 * pero cuyo INSERT de destinatarios falló en versiones anteriores. Sólo lee
 * mensajes ya existentes: nunca vuelve a enviar al cliente.
 */
async function recoverCampaignRecipientsFromSavedMessages(orgId) {
  const { rowCount } = await getPool().query(
    `WITH candidates AS (
       SELECT m.id AS message_id, m.whatsapp_message_id, cv.phone_number,
              cv.contact_name, c.id AS campaign_id, c.template_name,
              c.total_count,
              (SELECT COUNT(*) FROM broadcast_campaign_recipients existing
                WHERE existing.campaign_id = c.id) AS existing_count,
              ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY m.created_at, m.id) AS candidate_rank,
              ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY c.created_at DESC) AS campaign_rank
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id
         JOIN broadcast_campaigns c
           ON c.organization_id = cv.organization_id
          AND c.created_at <= m.created_at
          AND c.created_at > m.created_at - INTERVAL '30 minutes'
          AND m.content LIKE '[Template: ' || c.template_name || ']%'
        WHERE cv.organization_id = $1
          AND c.created_at > NOW() - INTERVAL '30 days'
          AND m.direction = 'outbound'
          AND m.type = 'template'
          AND m.whatsapp_message_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_campaign_recipients linked
             WHERE linked.organization_id = $1
               AND linked.whatsapp_message_id = m.whatsapp_message_id
          )
     ), attributable AS (
       SELECT * FROM candidates
        WHERE campaign_rank = 1
          AND candidate_rank <= GREATEST(total_count - existing_count, 0)
     )
     INSERT INTO broadcast_campaign_recipients
       (campaign_id, organization_id, destination_phone, original_phone,
        contact_name, template_name, language_code, result_status,
        whatsapp_message_id)
     SELECT campaign_id, $1, phone_number, phone_number,
            COALESCE(contact_name, 'Cliente'), template_name, 'es', 'accepted',
            whatsapp_message_id
       FROM attributable
     ON CONFLICT DO NOTHING`,
    [orgId]
  );
  if (rowCount) console.log(`[SendBulk] ${rowCount} destinatarios reconstruidos desde chats de org ${orgId}`);
  return rowCount || 0;
}

async function finalizeAcceptedBroadcast({ orgId, campaignId, item, sentResult, savedContent, isTemplate, channelId = null }) {
  const whatsappMessageId = sentResult?.messages?.[0]?.id || sentResult?.messageId || sentResult?.key?.id || null;

  // Estas escrituras no deben mantener la pantalla esperando después de que
  // WhatsApp ya aceptó el mensaje. El webhook durable también puede reconstruir
  // el chat si el proceso se reinicia durante esta fase.
  const auditTasks = [recordBroadcastRecipient(orgId, campaignId, item, {
    status: 'accepted', whatsappMessageId,
    errorDetail: channelId ? { savedContent, channelId, provider: 'evolution' } : null,
  })];
  if (item.templateName && !channelId) auditTasks.push(markTemplateSent(orgId, item.phone));
  const auditResults = await Promise.allSettled(auditTasks);
  auditResults.filter(result => result.status === 'rejected').forEach(result => {
    console.error('[SendBulk] No se pudo completar la auditoría posterior:', result.reason?.message || result.reason);
  });

  const bulkCached = analysisCache.get(orgId);
  const bulkClientData = bulkCached?.data?.find(entry => entry.phone === item.phone);
  const bulkContactName = bulkClientData?.name ? toTitleCase(bulkClientData.name) : 'Cliente';
  const bulkConv = await db.upsertConversation(orgId, item.phone, item.contactName || bulkContactName, channelId);
  const convId = bulkConv?.id;
  if (!convId) throw new Error('No se pudo crear la conversación del destinatario');

  const savedMsg = await db.saveMessage({
    conversationId: convId,
    whatsappMessageId: whatsappMessageId || `reeng_${Date.now()}`,
    content: savedContent,
    direction: 'outbound',
    type: isTemplate ? 'template' : 'text',
    sentBy: 'ai',
  });
  await db.updateConversationLastMessage(convId, savedContent);
  if (isTemplate) {
    await activateDivaForAutomatedMessage(convId, db);
    await db.updatePipelineState(convId, 'template_sent');
  }
  const updated = await db.getConversationById(convId);
  io?.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message: savedMsg, conversation: updated });
  return { conversationId: convId };
}

/**
 * Reconstruye en el chat los templates que Meta aceptó pero que no alcanzaron
 * a guardarse localmente (por ejemplo, si Railway reinició el proceso justo
 * después de la aceptación). No vuelve a enviar nada al cliente.
 */
async function reconcileAcceptedBroadcastMessages(orgId) {
  // Versiones anteriores podían perder el registro local si el proceso se
  // reiniciaba después de que Meta aceptara el mensaje. Los webhooks durables
  // conservan la confirmación real del proveedor y el contenido exacto, por lo
  // que primero reconstruimos esos chats sin volver a enviar nada.
  const providerRows = await getPool().query(
    `WITH provider_events AS (
       SELECT w.payload #>> '{message,id}' AS whatsapp_message_id,
              w.payload #>> '{message,to}' AS phone,
              w.payload #>> '{message,kapso,content}' AS content,
              w.payload #>> '{message,kapso,status}' AS status,
              MIN(w.created_at) OVER (
                PARTITION BY w.payload #>> '{message,id}'
              ) AS first_seen_at,
              ROW_NUMBER() OVER (
                PARTITION BY w.payload #>> '{message,id}' ORDER BY w.created_at DESC
              ) AS latest_rank
         FROM webhook_inbox w
        WHERE w.organization_id = $1
          AND w.provider = 'kapso'
          AND w.payload #>> '{message,type}' = 'template'
          AND w.payload #>> '{message,kapso,origin}' = 'cloud_api'
          AND w.payload #>> '{message,kapso,status}' IN ('sent','delivered','read','failed')
          AND w.created_at > NOW() - INTERVAL '30 days'
     )
     SELECT e.*, m.id AS local_message_id, r.id AS campaign_recipient_id
       FROM provider_events e
       LEFT JOIN messages m ON m.whatsapp_message_id = e.whatsapp_message_id
       LEFT JOIN broadcast_campaign_recipients r ON r.whatsapp_message_id = e.whatsapp_message_id
      WHERE e.latest_rank = 1
        AND (m.id IS NULL OR r.id IS NULL)
      ORDER BY e.first_seen_at
      LIMIT 500`,
    [orgId]
  );

  let recovered = 0;
  for (const providerMessage of providerRows.rows) {
    const phone = db.normalizePhone(providerMessage.phone);
    if (!phone || !providerMessage.whatsapp_message_id) continue;

    // Asociar sólo cuando existe una campaña iniciada pocos minutos antes.
    // Esto recupera el contador histórico sin atribuir envíos manuales lejanos.
    const campaignResult = await getPool().query(
      `SELECT c.id, c.template_name
         FROM broadcast_campaigns c
         LEFT JOIN broadcast_campaign_recipients r
           ON r.campaign_id = c.id
          AND r.destination_phone = $3
          AND r.result_status = 'unknown'
        WHERE c.organization_id = $1
          AND c.created_at <= $2
          AND c.created_at > $2 - INTERVAL '24 hours'
          AND (r.id IS NOT NULL OR c.created_at > $2 - INTERVAL '5 minutes')
        ORDER BY (r.id IS NOT NULL) DESC, c.created_at DESC
        LIMIT 1`,
      [orgId, providerMessage.first_seen_at, phone]
    );
    const campaign = campaignResult.rows[0] || null;
    const contactResult = await getPool().query(
      'SELECT name FROM contacts WHERE organization_id = $1 AND phone = $2 LIMIT 1',
      [orgId, phone]
    );
    const contactName = contactResult.rows[0]?.name || 'Cliente';
    const prefix = campaign?.template_name
      ? `[Template: ${campaign.template_name}]`
      : '[Template recuperado]';
    const savedContent = providerMessage.content
      ? `${prefix}\n\n${providerMessage.content}`
      : prefix;
    const conversation = await db.upsertConversation(orgId, phone, contactName);
    if (!conversation?.id) continue;
    const savedMessage = providerMessage.local_message_id ? null : await db.saveMessage({
        conversationId: conversation.id,
        whatsappMessageId: providerMessage.whatsapp_message_id,
        content: savedContent,
        direction: 'outbound',
        type: 'template',
        status: providerMessage.status,
        sentBy: 'ai',
      });

    if (campaign) {
      // Si la llamada HTTP quedó incierta, el webhook es la confirmación
      // definitiva. Actualizamos ese mismo registro en vez de duplicarlo.
      const recoveredRecipient = await getPool().query(
        `UPDATE broadcast_campaign_recipients
            SET result_status = 'accepted', whatsapp_message_id = $1,
                error_code = NULL, error_message = NULL, error_detail = NULL
          WHERE id = (
            SELECT id FROM broadcast_campaign_recipients
             WHERE campaign_id = $2 AND organization_id = $3
               AND destination_phone = $4 AND result_status = 'unknown'
             ORDER BY id DESC LIMIT 1
          )
        RETURNING id`,
        [providerMessage.whatsapp_message_id, campaign.id, orgId, phone]
      );
      await getPool().query(
        `INSERT INTO broadcast_campaign_recipients
           (campaign_id, organization_id, destination_phone, original_phone,
            contact_name, template_name, language_code, result_status,
            whatsapp_message_id)
         SELECT $1,$2,$3,$3,$4,$5,'es','accepted',$6
          WHERE NOT EXISTS (
            SELECT 1 FROM broadcast_campaign_recipients
             WHERE organization_id = $2 AND whatsapp_message_id = $6
          ) AND $7::boolean = FALSE`,
        [campaign.id, orgId, phone, contactName, campaign.template_name,
          providerMessage.whatsapp_message_id, recoveredRecipient.rowCount > 0]
      );
    }

    if (savedMessage) {
      await db.updateConversationLastMessage(conversation.id, savedContent);
      await activateDivaForAutomatedMessage(conversation.id, db);
      await db.updatePipelineState(conversation.id, 'template_sent');
      await markTemplateSent(orgId, phone);
      const updated = await db.getConversationById(conversation.id);
      io?.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message: savedMessage, conversation: updated });
      recovered++;
    }
  }

  const { rows } = await getPool().query(
    `SELECT r.*, bc.sending_provider, bc.sending_channel_id
       FROM broadcast_campaign_recipients r
       JOIN broadcast_campaigns bc ON bc.id = r.campaign_id AND bc.organization_id = r.organization_id
       LEFT JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
      WHERE r.organization_id = $1
        AND r.result_status = 'accepted'
        AND r.whatsapp_message_id IS NOT NULL
        AND m.id IS NULL
        AND r.created_at > NOW() - INTERVAL '30 days'
      ORDER BY r.id
      LIMIT 500`,
    [orgId]
  );
  if (!rows.length) return recovered;

  let templatesByName = new Map();
  try {
    const wc = await db.getWhatsappConfig(orgId);
    if (wc) {
      const templates = await require('../services/kapso-whatsapp').getTemplates(wc);
      templatesByName = new Map(templates.map(template => [template.name, template]));
    }
  } catch (error) {
    console.warn('[SendBulk] No se pudo recuperar el cuerpo de los templates:', error.message);
  }

  for (const recipient of rows) {
    const phone = db.normalizePhone(recipient.destination_phone || recipient.original_phone);
    if (!phone) continue;
    if (recipient.sending_provider === 'evolution') {
      // Restore only the exact persisted message, to its original channel. Never resend.
      const content = recipient.error_detail?.savedContent;
      const channelId = recipient.sending_channel_id;
      if (typeof content !== 'string' || !content.trim() || !channelId) continue;
      const conversation = await db.upsertConversation(orgId, phone, recipient.contact_name, channelId);
      const message = await db.saveMessage({ conversationId: conversation.id,
        whatsappMessageId: recipient.whatsapp_message_id, content, direction: 'outbound', type: 'text', sentBy: 'ai' });
      await db.updateConversationLastMessage(conversation.id, content);
      const updated = await db.getConversationById(conversation.id, orgId);
      io?.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message, conversation: updated });
      if (message) recovered++;
      continue;
    }
    const template = templatesByName.get(recipient.template_name);
    const body = getBodyComponent(template)?.text || '';
    const rendered = body
      ? renderTemplateFromComponents(body, recipient.template_components || [])
      : '';
    const savedContent = rendered
      ? `[Template: ${recipient.template_name}]\n\n${rendered}`
      : `[Template: ${recipient.template_name}]`;
    const conversation = await db.upsertConversation(
      orgId,
      phone,
      recipient.contact_name || 'Cliente'
    );
    if (!conversation?.id) continue;
    const savedMessage = await db.saveMessage({
      conversationId: conversation.id,
      whatsappMessageId: recipient.whatsapp_message_id,
      content: savedContent,
      direction: 'outbound',
      type: 'template',
      sentBy: 'ai',
    });
    if (!savedMessage) continue;
    await db.updateConversationLastMessage(conversation.id, savedContent);
    await activateDivaForAutomatedMessage(conversation.id, db);
    await db.updatePipelineState(conversation.id, 'template_sent');
    await markTemplateSent(orgId, phone);
    const updated = await db.getConversationById(conversation.id);
    io?.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message: savedMessage, conversation: updated });
    recovered++;
  }
  if (recovered) console.log(`[SendBulk] ${recovered} mensajes aceptados reconstruidos en los chats de org ${orgId}`);
  return recovered;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cache en memoria: sesión actual (respaldo al cache de DB)
const analysisCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;
const CUSTOMER_IDENTITY_VERSION = 3;

/* ─────────────────────────────────────────────────────────────────────
   ESTADÍSTICAS POR CLIENTE
   Agrupa órdenes de Shopify por teléfono y calcula métricas de
   comportamiento para alimentar el modelo predictivo de la IA.
───────────────────────────────────────────────────────────────────── */
/**
 * Normaliza teléfono al formato canónico: 56XXXXXXXXX (sin +)
 * Este es el mismo formato que usan contacts, conversations y shopify_orders.
 * contacts.phone actúa como ID único del contacto en todo el sistema.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  let p = raw.replace(/\s+/g, '').replace(/[^+\d]/g, '');
  // Quitar + inicial si lo tiene
  if (p.startsWith('+')) p = p.slice(1);
  // 9 dígitos → agregar 56
  if (/^9\d{8}$/.test(p)) p = '56' + p;
  return p.length >= 8 ? p : null;
}

function buildCustomerStats(orders, identityMap = new Map()) {
  const map = new Map();
  const DOW = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  for (const order of orders) {
    const rawPhone =
      order.customer?.phone ||
      order.shippingAddress?.phone ||
      order.billingAddress?.phone ||
      null;

    const normalizedPhone = normalizePhone(rawPhone);
    const phone = identityMap.get(normalizedPhone) || normalizedPhone;
    if (!phone) continue;

    const name =
      order.customer?.displayName ||
      order.customer?.name ||
      (order.shippingAddress
        ? `${order.shippingAddress.firstName || ''} ${order.shippingAddress.lastName || ''}`.trim()
        : null) ||
      (order.billingAddress
        ? `${order.billingAddress.firstName || ''} ${order.billingAddress.lastName || ''}`.trim()
        : null) ||
      phone;

    const date  = new Date(order.createdAt);
    const price = parseFloat(order.totalPrice) || 0;
    const items = (order.lineItems || []).map(li => li.title).filter(Boolean);

    if (!map.has(phone)) {
      map.set(phone, {
        phone,
        name,
        email:     order.customer?.email || null,
        orders:    [],
        dowCounts: [0,0,0,0,0,0,0],
      });
    }
    const s = map.get(phone);
    if (name.length > s.name.length) s.name = name;
    s.orders.push({ date, price, items, orderName: order.name });
    s.dowCounts[date.getDay()]++;
    items.forEach(i => {
      if (!s.products) s.products = new Set();
      s.products.add(i);
    });
  }

  const now = Date.now();
  const stats = [];

  for (const [, s] of map) {
    if (!s.orders.length) continue;
    s.orders.sort((a, b) => a.date - b.date);

    const last         = s.orders[s.orders.length - 1];
    const daysInactive = Math.round((now - last.date.getTime()) / 86400000);
    const totalSpent   = s.orders.reduce((t, o) => t + o.price, 0);
    const avgOrderVal  = Math.round(totalSpent / s.orders.length);

    const gaps = [];
    for (let i = 1; i < s.orders.length; i++) {
      gaps.push(Math.round((s.orders[i].date - s.orders[i-1].date) / 86400000));
    }
    const avgFreqDays = gaps.length
      ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
      : null;

    let freqStdDev = null;
    if (gaps.length >= 2) {
      const mean = avgFreqDays;
      const variance = gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length;
      freqStdDev = Math.round(Math.sqrt(variance));
    }

    const maxDow  = s.dowCounts.indexOf(Math.max(...s.dowCounts));
    const favDay  = DOW[maxDow];

    let spendTrend = 'estable';
    if (s.orders.length >= 3) {
      const first = s.orders.slice(0, Math.ceil(s.orders.length / 2)).reduce((t, o) => t + o.price, 0);
      const latter = s.orders.slice(Math.ceil(s.orders.length / 2)).reduce((t, o) => t + o.price, 0);
      const ratio = latter / (first || 1);
      if (ratio > 1.2) spendTrend = 'creciente';
      else if (ratio < 0.8) spendTrend = 'decreciente';
    }

    const recentOrders = s.orders.slice(-5).map(o => ({
      date: o.date.toISOString().slice(0,10),
      daysAgo: Math.round((now - o.date.getTime()) / 86400000),
      price: Math.round(o.price),
      items: o.items.slice(0, 2).join(', '),
    }));

    stats.push({
      phone:        s.phone,
      name:         s.name,
      email:        s.email,
      totalOrders:  s.orders.length,
      totalSpent:   Math.round(totalSpent),
      avgOrderVal,
      daysInactive,
      lastOrderDate: last.date.toISOString().slice(0, 10),
      lastProducts: (last.items || []).slice(0, 3).join(', '),
      avgFreqDays,
      freqStdDev,
      favDay,
      spendTrend,
      recentOrders,
      dowCounts: s.dowCounts,
    });
  }

  return stats;
}

/* ─────────────────────────────────────────────────────────────────────
   PREDICCIÓN MATEMÁTICA DE RESPALDO
   Usada cuando la IA falla o para clientes con ciclo claro.
   Returns { predictedDays, confidence, aiReason, source }
───────────────────────────────────────────────────────────────────── */
function heuristicPredict(c) {
  if (!c.avgFreqDays) {
    // Solo 1 pedido: clasificar por tiempo inactivo sin asumir ciclo corto
    // Un cliente con 1 compra que lleva mucho tiempo inactivo → contactar pronto
    const inactive = c.daysInactive || 0;
    let d, conf, reason;

    if (inactive <= 7) {
      // Compra reciente — esperar un poco
      d = 14; conf = 35; reason = '1 compra reciente, muy pronto para re-enganchar';
    } else if (inactive <= 30) {
      // 1-4 semanas → contactar esta semana
      d = 3; conf = 50; reason = `1 compra, ${inactive}d inactivo, momento ideal`;
    } else if (inactive <= 90) {
      // 1-3 meses → urgente
      d = 1; conf = 55; reason = `1 compra, ${inactive}d sin volver, alta prioridad`;
    } else {
      // Más de 3 meses → difícil de recuperar pero vale intentarlo
      d = 1; conf = 35; reason = `1 compra hace ${inactive}d, recuperación difícil`;
    }
    return { predictedDays: d, confidence: conf, aiReason: reason, source: 'heuristic' };
  }

  const d    = c.avgFreqDays - c.daysInactive;  // negativo = ya venció
  const cv   = c.freqStdDev != null ? c.freqStdDev / c.avgFreqDays : 1;
  // Confianza: baja si coeficiente de variación > 0.5, alta si < 0.2
  let conf = 75 - Math.round(cv * 50);
  // Más pedidos → más confianza
  conf += Math.min(15, c.totalOrders * 2);
  conf = Math.max(25, Math.min(85, conf));

  return { predictedDays: d, confidence: conf, aiReason: `ciclo ${c.avgFreqDays}d`, source: 'heuristic' };
}

/* ─────────────────────────────────────────────────────────────────────
   MODELO PREDICTIVO DE IA
   Batches pequeños (20) con max_tokens alto para evitar truncamiento.
   Si el JSON llega cortado, se recuperan las entradas completas.
───────────────────────────────────────────────────────────────────── */
async function predictWithAI(customers, todayDow) {
  const D = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const now      = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const todayD   = D[todayDow];

  const T = c => c.spendTrend === 'creciente' ? '↑' : c.spendTrend === 'decreciente' ? '↓' : '=';
  const nextDate = c => c.avgFreqDays
    ? new Date(now.getTime() + (c.avgFreqDays - c.daysInactive) * 86400000).toISOString().slice(5,10)
    : '?';

  const rows = customers.map((c, i) => {
    const freq   = c.avgFreqDays ? `${c.avgFreqDays}±${c.freqStdDev ?? '?'}` : '?';
    const ov     = c.avgFreqDays && c.daysInactive > c.avgFreqDays ? `!${c.daysInactive - c.avgFreqDays}` : '';
    const dates  = c.recentOrders.slice(-3).map(o => o.date.slice(5)).join(',');
    return `${i+1}|${c.phone}|${c.daysInactive}${ov}|${freq}|${nextDate(c)}|${c.favDay}|${c.totalOrders}|${T(c)}|${dates}`;
  }).join('\n');

  const prompt =
`Analiza clientes recurrentes y predice días hasta próxima compra. HOY:${todayISO}(${todayD})
Cols: #|tel|inac(días,!vencidoDías)|freq±dev|próxEst(MM-DD)|favDía|nPedidos|trend|últ3compras(MM-DD)
${rows}
Reglas:
- d = días hasta próxima compra (negativo si ya venció el ciclo)
- inac>freq → d negativo (ya debería haber comprado)
- dev pequeño (<5) → conf alta (patrón muy regular)
- 1 pedido → usar ciclo 7-30d según categoría, conf 40-50
- trend↑ → reducir d levemente
- c = 0-100 (confianza basada en regularidad del patrón)
RESPONDER SOLO JSON (sin texto extra): [{"t":"TEL_EXACTO","d":DIAS_INT,"c":CONF_INT,"r":"razon max 6 palabras"}]
Incluir TODOS los ${customers.length} clientes. Ordenar por d ascendente.`;

  let raw = '';
  try {
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages:   [{ role: 'user', content: prompt }],
    });
    raw = response.content[0]?.text?.trim() || '[]';
  } catch (apiErr) {
    console.error('[Reengagement] Error llamando a IA:', apiErr.message);
    return [];
  }

  // Intentar extraer JSON completo
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('[Reengagement] AI no devolvió JSON válido:', raw.slice(0, 300));
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]);
    console.log(`[Reengagement] IA devolvió ${parsed.length}/${customers.length} predicciones`);
    return parsed.map(r => ({
      phone:         r.t,
      predictedDays: typeof r.d === 'number' ? r.d : null,
      confidence:    typeof r.c === 'number' ? r.c : 50,
      aiReason:      r.r || null,
      source:        'ai',
    }));
  } catch {
    // JSON truncado: recuperar entradas completas con regex
    console.warn('[Reengagement] JSON truncado, recuperando entradas parciales...');
    const entries = [];
    const entryRx = /\{"t"\s*:\s*"([^"]+)"\s*,\s*"d"\s*:\s*(-?\d+)\s*,\s*"c"\s*:\s*(\d+)\s*,\s*"r"\s*:\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = entryRx.exec(raw)) !== null) {
      entries.push({ phone: m[1], predictedDays: parseInt(m[2]), confidence: parseInt(m[3]), aiReason: m[4], source: 'ai' });
    }
    console.log(`[Reengagement] Recuperadas ${entries.length} entradas de JSON truncado`);
    return entries;
  }
}

/* ─────────────────────────────────────────────────────────────────────
   Set de orgs cuyo análisis corre en segundo plano
───────────────────────────────────────────────────────────────────── */
const bgProcessing = new Set();

/* ── Helper: convierte "JUAN PEREZ" → "Juan Perez", extrae primer nombre ── */
function toTitleCase(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
function extractFirstName(rawName, phone) {
  if (!rawName || rawName === phone) return '';
  const titled = toTitleCase(rawName);
  return titled.split(' ')[0] || '';
}

/* ─────────────────────────────────────────────────────────────────────
   ANÁLISIS COMPLETO — función standalone reutilizable
   Devuelve { enriched, diagnostico } o null si no hay datos.
───────────────────────────────────────────────────────────────────── */
async function runFullAnalysis(orgId, ds) {
  const today = new Date().toISOString().slice(0, 10);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { getPool } = require('../db/database');
  const pool = getPool();

  // ── Leer pedidos desde ambas tablas locales ────────────────────────
  console.log(`[Reengagement] Leyendo órdenes desde DB local (org ${orgId})...`);
  const { rows: dbRows } = await pool.query(
    `-- Pedidos de Shopify (webhook/sync)
     SELECT customer_phone, customer_name, customer_email,
            total_price::DECIMAL          AS total_price,
            items                         AS items,
            shopify_created_at            AS order_date,
            shopify_name                  AS order_name,
            financial_status
     FROM shopify_orders
     WHERE organization_id = $1
       AND customer_phone IS NOT NULL AND customer_phone <> ''
       AND shopify_created_at IS NOT NULL
       AND (financial_status IS NULL
            OR UPPER(financial_status) NOT IN ('VOIDED','REFUNDED'))

     UNION ALL

     -- Pedidos CRM creados por el bot (solo confirmados)
     SELECT customer_phone, customer_name, NULL AS customer_email,
            NULLIF(total_price, '')::DECIMAL     AS total_price,
            CASE WHEN items IS NOT NULL AND items <> '' AND items <> '[]'
                 THEN items::JSONB ELSE '[]'::JSONB END AS items,
            created_at                           AS order_date,
            shopify_order_id                     AS order_name,
            status                               AS financial_status
     FROM orders
     WHERE organization_id = $1
       AND customer_phone IS NOT NULL AND customer_phone <> ''
       AND status NOT IN ('cancelled')

     ORDER BY order_date ASC`,
    [orgId]
  );
  console.log(`[Reengagement] Total órdenes en DB: ${dbRows.length}`);
  if (!dbRows.length) return null;

  // Convertir filas DB al formato que espera buildCustomerStats
  const allOrders = dbRows.map(r => {
    const rawItems = Array.isArray(r.items) ? r.items : [];
    return {
      customer: {
        phone: r.customer_phone,
        name:  r.customer_name || r.customer_phone,
        email: r.customer_email || null,
      },
      totalPrice: parseFloat(r.total_price) || 0,
      createdAt:  r.order_date,
      name:       r.order_name || null,
      lineItems:  rawItems.map(i => ({
        title: typeof i === 'string' ? i : (i.name || i.title || ''),
      })),
    };
  });

  const { rows: identityContacts } = await pool.query(
    `SELECT phone, name, email, address, address1, city, shopify_id, last_order_at
       FROM contacts WHERE organization_id = $1`,
    [orgId]
  );
  const identityMap = buildCustomerIdentityMap([
    ...identityContacts,
    ...dbRows.map(row => ({
      phone: row.customer_phone,
      name: row.customer_name,
      email: row.customer_email,
      orderDate: row.order_date,
    })),
  ]);
  const allStats = buildCustomerStats(allOrders, identityMap);
  console.log(`[Reengagement] Clientes únicos con teléfono: ${allStats.length}`);
  if (!allStats.length) return null;

  // ── Scoring basado en días inactivo vs frecuencia promedio ─────────
  // overdueRatio = daysInactive / avgFreqDays
  // >1 → ya venció el ciclo (candidato urgente)
  // Clientes con 1 solo pedido usan heurística de tiempo inactivo
  const todayDow = new Date().getDay();
  let aiResults  = [];
  const BATCH = 20;
  for (let i = 0; i < allStats.length; i += BATCH) {
    const batch  = allStats.slice(i, i + BATCH);
    const result = await predictWithAI(batch, todayDow);
    aiResults = aiResults.concat(result);
    console.log(`[Reengagement] Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(allStats.length/BATCH)}: ${result.length}/${batch.length}`);
    if (i + BATCH < allStats.length) await sleep(400);
  }
  console.log(`[Reengagement] AI: ${aiResults.length}/${allStats.length} predicciones`);

  const aiMap = new Map(aiResults.map(r => [r.phone, r]));

  let calibration = await db.getCalibration(orgId);
  if (!calibration) {
    try {
      const bt = runBacktesting(allOrders, normalizePhone);
      await db.saveCalibration(orgId, bt);
      console.log(`[Reengagement] Backtesting: factor=${bt.calibrationFactor}, accuracy=${Math.round(bt.accuracyRate*100)}%`);
      calibration = await db.getCalibration(orgId);
    } catch (e) { console.warn('[Reengagement] Backtesting error:', e.message); }
  }

  let aiHits = 0, heuristicHits = 0;

  const enriched = consolidateCustomerCandidates(allStats.map(c => {
    const aiEntry = aiMap.get(c.phone);
    let predictedDays, confidenceRaw, aiReason, predSource;

    if (aiEntry && aiEntry.predictedDays !== null && aiEntry.predictedDays !== undefined) {
      predictedDays = aiEntry.predictedDays;
      confidenceRaw = aiEntry.confidence || 50;
      aiReason      = aiEntry.aiReason || null;
      predSource    = 'ai';
      aiHits++;
    } else {
      const h       = heuristicPredict(c);
      predictedDays = h.predictedDays;
      confidenceRaw = h.confidence;
      aiReason      = h.aiReason;
      predSource    = 'heuristic';
      heuristicHits++;
    }

    const confidence = applyCalibration(confidenceRaw, calibration);

    // overdueRatio: cuántas veces el ciclo normal ya venció sin compra
    // null si solo tiene 1 pedido (no hay frecuencia calculada)
    const overdueRatio = c.avgFreqDays
      ? Math.round((c.daysInactive / c.avgFreqDays) * 100) / 100
      : null;

    let buyWindow, urgency;
    if      (predictedDays <= 1)   { buyWindow = 'hoy';    urgency = 4; }
    else if (predictedDays <= 7)   { buyWindow = 'semana'; urgency = 3; }
    else if (predictedDays <= 30)  { buyWindow = 'mes';    urgency = 2; }
    else                           { buyWindow = 'lejano'; urgency = 1; }

    return { ...c, predictedDays, confidenceRaw, confidence, aiReason, predSource, buyWindow, urgency, overdueRatio,
      identityVersion: CUSTOMER_IDENTITY_VERSION };
  })
  .filter(c => c.predictedDays <= 365)
  .sort((a, b) => a.predictedDays - b.predictedDays));

  console.log(`[Reengagement] Resultado: IA=${aiHits} | heurística=${heuristicHits} | total=${enriched.length}`);

  try {
    await db.saveDailyCache(orgId, today, enriched);
    await db.savePredictions(orgId, enriched, today);
    console.log(`[Reengagement] Cache guardado: ${today} (${enriched.length} candidatos)`);
  } catch (e) { console.warn('[Reengagement] Error guardando cache:', e.message); }

  analysisCache.set(orgId, { data: enriched, ts: Date.now() });

  ['hoy','semana','mes','lejano'].forEach(w => {
    const g = enriched.filter(c => c.buyWindow === w);
    if (g.length) console.log(`  ${w.toUpperCase()}: ${g.length} clientes`);
  });

  const diagnostico = {
    totalOrdenes:      dbRows.length,
    clientesConTel:    allStats.length,
    fuenteDatos:       'db_local',
    conPrediccionAI:   aiHits,
    conPrediccionHeur: heuristicHits,
    enVentana:         enriched.length,
  };
  console.log(`[Reengagement] Diag: ${JSON.stringify(diagnostico)}`);

  return { enriched, diagnostico };
}

/* ─────────────────────────────────────────────────────────────────────
   Helpers para anti-duplicate template sending
───────────────────────────────────────────────────────────────────── */

/**
 * Enriquece los candidatos con last_template_sent_at en vivo desde contacts.
 * Siempre se consulta en tiempo real (no cacheado) para reflejar envíos recientes.
 */
async function enrichCandidatesWithTemplateSent(candidates, orgId) {
  if (!candidates || !candidates.length) return candidates;
  try {
    const { getPool } = require('../db/database');
    const pool = getPool();
    const phones = candidates.map(c => c.phone).filter(Boolean);
    const { rows } = await pool.query(
      `SELECT phone, last_template_sent_at
       FROM contacts
       WHERE organization_id = $1 AND phone = ANY($2::text[])
         AND last_template_sent_at IS NOT NULL`,
      [orgId, phones]
    );
    const sentMap = {};
    for (const r of rows) sentMap[r.phone] = r.last_template_sent_at;
    return candidates.map(c => ({ ...c, last_template_sent_at: sentMap[c.phone] || null }));
  } catch { return candidates; }
}

/**
 * Marca un contacto como "template enviado ahora" en la tabla contacts.
 */
async function markTemplateSent(orgId, phone) {
  try {
    const { getPool } = require('../db/database');
    const pool = getPool();
    await pool.query(
      `UPDATE contacts SET last_template_sent_at = NOW()
       WHERE organization_id = $1 AND phone = $2`,
      [orgId, phone]
    );
  } catch (e) { console.error('[markTemplateSent]', e.message); }
}

/**
 * ¿El cliente respondió explícitamente "no quiero" en las últimas 48 horas?
 * Si es así, no enviarle re-engagement.
 */
const DECLINE_PATTERNS = [
  /no\s+(quiero|me\s+interesa|estoy\s+interesado|gracias|necesito)/i,
  /ya\s+(no\s+quiero|te\s+dije|chao|gracias)/i,
  /no\s+por\s+ahora/i,
  /d[eé]jame\s+en\s+paz/i,
  /\bno\s+gracias\b/i,
  /\bno\s+me\s+mand/i,
  /\bya\s+chao\b/i,
];

async function customerRecentlyDeclined(orgId, phone) {
  try {
    const { getPool } = require('../db/database');
    const pool = getPool();
    // Buscar últimos 5 mensajes entrantes del cliente en las últimas 48 horas
    const { rows } = await pool.query(
      `SELECT m.content
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.organization_id = $1
         AND c.phone_number = $2
         AND m.direction = 'inbound'
         AND m.content IS NOT NULL
         AND m.created_at > NOW() - INTERVAL '48 hours'
       ORDER BY m.created_at DESC
       LIMIT 5`,
      [orgId, phone]
    );
    return rows.some(r => DECLINE_PATTERNS.some(p => p.test(r.content)));
  } catch { return false; }
}

/**
 * ¿Ya se envió un template hoy a este teléfono?
 */
async function templateSentToday(orgId, phone, channelId = null) {
  const { rows } = await getPool().query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.organization_id = $1 AND c.phone_number = $2
         AND c.whatsapp_channel_id IS NOT DISTINCT FROM $3::integer
         AND m.direction = 'outbound' AND m.type = 'template'
         AND m.status IS DISTINCT FROM 'failed'
         AND m.created_at >= DATE_TRUNC('day', NOW())
     ) OR EXISTS (
       SELECT 1 FROM broadcast_campaign_recipients r
       JOIN broadcast_campaigns bc ON bc.id = r.campaign_id AND bc.organization_id = r.organization_id
       WHERE r.organization_id = $1 AND r.destination_phone = $2
         AND bc.sending_channel_id IS NOT DISTINCT FROM $3::integer
         AND r.result_status IN ('accepted', 'unknown')
         AND r.created_at >= DATE_TRUNC('day', NOW())
     )`, [orgId, phone, channelId]);
  return rows.length > 0;
}

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/candidates?refresh=false
───────────────────────────────────────────────────────────────────── */
router.get('/candidates', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, data: [], total: 0 });
    const pool = getPool();

    const refresh = req.query.refresh === 'true';
    const today   = new Date().toISOString().slice(0, 10);

    // ── 1. Cache en memoria ──────────────────────────────────────────
    const memCached = analysisCache.get(req.orgId);
    const memoryIdentityCurrent = memCached?.data?.every(item => item.identityVersion === CUSTOMER_IDENTITY_VERSION);
    if (!refresh && memCached && memoryIdentityCurrent && Date.now() - memCached.ts < CACHE_TTL) {
      const identityMap = await loadCustomerIdentityMap(pool, req.orgId, memCached.data);
      const enrichedMem = await enrichCandidatesWithTemplateSent(consolidateCustomerCandidates(memCached.data, identityMap), req.orgId);
      return res.json({ success: true, data: enrichedMem, total: enrichedMem.length, fromCache: true, cacheSource: 'memory' });
    }

    // ── 2. Refresh solicitado → iniciar en SEGUNDO PLANO y retornar ──
    if (refresh) {
      if (bgProcessing.has(req.orgId)) {
        // Ya está corriendo — devolver caché anterior si existe
        const dbCached = await db.getDailyCache(req.orgId, today);
        if (dbCached) {
          const rawData = Array.isArray(dbCached) ? dbCached : JSON.parse(dbCached);
          const identityMap = await loadCustomerIdentityMap(pool, req.orgId, rawData);
          const data = consolidateCustomerCandidates(rawData, identityMap);
          return res.json({ success: true, data, total: data.length, fromCache: true, cacheSource: 'db_stale', refreshing: true });
        }
        return res.json({ success: true, data: [], total: 0, refreshing: true, message: 'Análisis en progreso...' });
      }

      // Limpiar caché y arrancar
      try { await db.saveDailyCache(req.orgId, today, null); } catch {}
      analysisCache.delete(req.orgId);
      bgProcessing.add(req.orgId);
      runFullAnalysis(req.orgId, ds).finally(() => bgProcessing.delete(req.orgId));

      // Retornar inmediatamente sin esperar
      return res.json({
        success: true, data: [], total: 0, refreshing: true,
        message: 'Análisis iniciado en segundo plano. Recarga la página en 3-5 minutos.',
      });
    }

    // ── 3. Cache en DB (mismo día) ───────────────────────────────────
    const dbCached = await db.getDailyCache(req.orgId, today);
    if (dbCached && (Array.isArray(dbCached) ? dbCached.length > 0 : JSON.parse(dbCached).length > 0)) {
      const rawCandidates = Array.isArray(dbCached) ? dbCached : JSON.parse(dbCached);
      const identityMap = await loadCustomerIdentityMap(pool, req.orgId, rawCandidates);
      const candidates = consolidateCustomerCandidates(rawCandidates, identityMap);
      const identityCurrent = candidates.every(item => item.identityVersion === CUSTOMER_IDENTITY_VERSION);
      if (!identityCurrent) {
        if (!bgProcessing.has(req.orgId)) {
          try { await db.saveDailyCache(req.orgId, today, null); } catch {}
          analysisCache.delete(req.orgId);
          bgProcessing.add(req.orgId);
          runFullAnalysis(req.orgId, ds).finally(() => bgProcessing.delete(req.orgId));
        }
        const stale = await enrichCandidatesWithTemplateSent(candidates, req.orgId);
        return res.json({ success: true, data: stale, total: stale.length, fromCache: true,
          cacheSource: 'db_stale', cacheDate: today, refreshing: true });
      }
      analysisCache.set(req.orgId, { data: candidates, ts: Date.now() });
      const enriched = await enrichCandidatesWithTemplateSent(candidates, req.orgId);
      return res.json({ success: true, data: enriched, total: enriched.length, fromCache: true, cacheSource: 'db', cacheDate: today });
    }

    // ── 4. Análisis completo (primera carga del día) ─────────────────
    bgProcessing.add(req.orgId);
    const result = await runFullAnalysis(req.orgId, ds).finally(() => bgProcessing.delete(req.orgId));

    if (!result) return res.json({ success: true, data: [], total: 0, message: 'Sin órdenes o teléfonos en Shopify' });

    const enrichedFresh = await enrichCandidatesWithTemplateSent(result.enriched, req.orgId);
    res.json({
      success:     true,
      data:        enrichedFresh,
      total:       enrichedFresh.length,
      fromCache:   false,
      diagnostico: result.diagnostico,
    });

  } catch (err) {
    console.error('[Reengagement] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/generate
───────────────────────────────────────────────────────────────────── */
router.post('/generate', async (req, res) => {
  try {
    const { phone } = req.body;
    const cached    = analysisCache.get(req.orgId);
    const c         = cached?.data?.find(x => x.phone === phone) || {};

    const prompt = `Eres el asistente de ventas de una tienda de productos frescos del campo (huevos, aceitunas, quesos, miel y más).

Cliente: ${c.name || phone}
Última compra: hace ${c.daysInactive || '?'} días (${c.lastOrderDate || '—'})
Productos que compra: ${c.lastProducts || 'productos frescos'}
${c.avgFreqDays ? `Compra habitualmente cada ~${c.avgFreqDays} días` : ''}
${c.predictedDays <= 1 ? 'La IA predice que comprará HOY o MAÑANA.' : c.predictedDays <= 7 ? `La IA predice que comprará en ~${c.predictedDays} días.` : ''}
${c.aiReason ? `Contexto: ${c.aiReason}` : ''}

Escribe un mensaje de WhatsApp CORTO (máximo 3 líneas) y cálido.
- Tono cercano, como si fuera de un amigo que le recuerda los productos frescos
- Menciona su producto habitual si es relevante
- Si está próximo a su ciclo de compra, puedes insinuarlo sutilmente
- Máximo 2 emojis
- Termina con una pregunta o invitación suave
- Escribe SOLO el mensaje, nada más

PROHIBIDO — no incluyas nada de esto:
- Stock limitado, últimas unidades, "se acaban", "pocas quedan" → no tienes esa info real
- Fechas de entrega inventadas ("mañana en tu zona", "hoy") → no las conoces
- "Gallinas llegadas del campo" ni eventos especiales → vendes HUEVOS, no gallinas
- Urgencia fabricada de cualquier tipo
- Más de 3 líneas`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ success: true, message: response.content[0]?.text?.trim() || '', phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/fill-template-vars
   La IA lee el texto del template, identifica las variables {{N}}, y las
   rellena con los datos del cliente de forma natural.

   Body: { phone, templateBody }
   Response: { vars: { "1": "Juan", "2": "huevos", ... } }
───────────────────────────────────────────────────────────────────── */
router.post('/fill-template-vars', async (req, res) => {
  try {
    const { phone, templateBody } = req.body;
    if (!phone || !templateBody) {
      return res.status(400).json({ success: false, error: 'phone y templateBody requeridos' });
    }

    // Buscar datos del cliente en el caché de análisis
    const cached = analysisCache.get(req.orgId);
    const c = { ...(cached?.data?.find(x => x.phone === phone) || {}) };

    // Priorizar nombre de WhatsApp sobre el de Shopify
    try {
      const pool = getPool();
      const digits = phone.replace(/\D/g, '');
      const variants = [phone];
      if (/^569\d{8}$/.test(digits)) variants.push(digits.slice(2));
      if (/^9\d{8}$/.test(digits))   variants.push('56' + digits);
      const { rows } = await pool.query(
        `SELECT contact_name FROM conversations
         WHERE organization_id = $1 AND phone_number = ANY($2)
           AND contact_name IS NOT NULL AND contact_name <> ''
           AND LOWER(contact_name) NOT IN ('cliente','sin nombre')
         ORDER BY last_message_at DESC LIMIT 1`,
        [req.orgId, variants]
      );
      if (rows[0]?.contact_name) c.name = rows[0].contact_name;
    } catch (_) {}

    // Extraer variables del template
    const varNums = [...new Set([...templateBody.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))].sort();
    if (varNums.length === 0) {
      return res.json({ success: true, vars: {} });
    }

    const daysLabel = c.daysInactive != null
      ? `${c.daysInactive} días`
      : 'unos días';

    const prompt =
`Eres un asistente de ventas. Debes rellenar las variables de un template de WhatsApp con los datos reales de un cliente.

TEMPLATE:
"${templateBody}"

DATOS DEL CLIENTE:
- Nombre: ${c.name || phone}
- Teléfono: ${phone}
- Última compra: hace ${daysLabel} (${c.lastOrderDate || '—'})
- Productos habituales: ${c.lastProducts || 'productos frescos'}
- Frecuencia de compra: ${c.avgFreqDays ? `cada ~${c.avgFreqDays} días` : 'variable'}
- La IA predice que compraría: ${c.predictedDays != null ? `en ~${c.predictedDays} días` : 'pronto'}
${c.aiReason ? `- Contexto IA: ${c.aiReason}` : ''}

Variables a rellenar: ${varNums.map(v => `{{${v}}}`).join(', ')}

Reglas:
- {{1}} normalmente es el nombre del cliente (usa solo su primer nombre)
- Usa los datos del cliente de forma natural, sin inventar información
- Textos cortos (máximo 1-3 palabras por variable, a menos que sea claramente un texto largo)
- Si no hay dato, usa un valor genérico apropiado

Responde SOLO con un objeto JSON, sin explicaciones:
{${varNums.map(v => `"${v}": "..."`).join(', ')}}`;

    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw   = response.content[0]?.text?.trim() || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[Reengagement/fill-vars] No JSON en respuesta:', raw);
      return res.json({ success: true, vars: {} });
    }

    const vars = JSON.parse(match[0]);
    res.json({ success: true, vars });
  } catch (err) {
    console.error('[Reengagement/fill-vars]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/ai-pick-template
   La IA elige el mejor template para el cliente Y rellena sus variables
   en un solo paso.

   Body:    { phone, templates: [{ name, language, components }] }
   Returns: { templateName, languageCode, vars, previewText, reason }
───────────────────────────────────────────────────────────────────── */
router.post('/ai-pick-template', async (req, res) => {
  try {
    const { phone, templates } = req.body;
    if (!phone || !Array.isArray(templates) || templates.length === 0) {
      return res.status(400).json({ success: false, error: 'phone y templates requeridos' });
    }

    // Datos del cliente desde el caché de análisis
    const cached = analysisCache.get(req.orgId);
    const c = { ...(cached?.data?.find(x => x.phone === phone) || {}) };

    // Priorizar el nombre de WhatsApp (conversations) sobre el de Shopify
    // porque en Shopify puede haber pedidos a nombre de otra persona
    try {
      const pool = getPool();
      const variants = [phone];
      const digits = phone.replace(/\D/g, '');
      if (/^569\d{8}$/.test(digits)) variants.push(digits.slice(2));
      if (/^9\d{8}$/.test(digits))   variants.push('56' + digits);
      const { rows } = await pool.query(
        `SELECT contact_name FROM conversations
         WHERE organization_id = $1 AND phone_number = ANY($2)
           AND contact_name IS NOT NULL AND contact_name <> ''
           AND LOWER(contact_name) NOT IN ('cliente','sin nombre')
         ORDER BY last_message_at DESC LIMIT 1`,
        [req.orgId, variants]
      );
      if (rows[0]?.contact_name) c.name = rows[0].contact_name;
    } catch (_) {}


    // Contexto de la tienda (catálogo + info de entrega) para mejorar las variables
    const storeCtx = await db.getSetting(req.orgId, 'store_context') || '';
    const deliveryRaw = await db.getSetting(req.orgId, 'delivery_info');
    let catalogSection = '';
    if (storeCtx) {
      // Solo usar las primeras 800 chars para no sobrepasar tokens
      catalogSection = `\nCATÁLOGO / CONTEXTO DE LA TIENDA (usa para rellenar variables con productos reales):\n${storeCtx.slice(0, 800)}`;
    }
    if (deliveryRaw) {
      try {
        const d = JSON.parse(deliveryRaw);
        const lines = [];
        if (d.schedule)       lines.push(`Horarios: ${d.schedule}`);
        if (d.zone)           lines.push(`Zona: ${d.zone}`);
        if (d.minimum)        lines.push(`Mínimo: ${d.minimum}`);
        if (d.paymentMethods) lines.push(`Pagos: ${d.paymentMethods}`);
        if (lines.length) catalogSection += `\nINFO DE ENTREGA: ${lines.join(' · ')}`;
      } catch {}
    }

    // Construir descripción de cada template con contexto completo por variable
    const tplDescriptions = templates.map((t, i) => {
      const body   = (t.components || []).find(comp => comp.type === 'BODY');
      const header = (t.components || []).find(comp => comp.type === 'HEADER');
      const footer = (t.components || []).find(comp => comp.type === 'FOOTER');

      // Extraer variables con su contexto (palabras antes y después)
      let varContexts = '';
      if (body?.text) {
        const varNums = [...new Set([...body.text.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))].sort();
        if (varNums.length > 0) {
          varContexts = '\n   Variables con contexto:\n' + varNums.map(v => {
            // Extraer ~5 palabras antes y después de la variable para mostrar contexto
            const regex = new RegExp(`(.{0,40})\\{\\{${v}\\}\\}(.{0,40})`);
            const m = body.text.match(regex);
            const before = m?.[1]?.replace(/.*\n/,'').trim() || '';
            const after  = m?.[2]?.split('\n')[0].trim() || '';
            return `     {{${v}}} → "...${before}[AQUÍ]${after}..." (el valor reemplazará [AQUÍ])`;
          }).join('\n');
        }
      }

      const parts = [];
      if (header?.text) parts.push(`Encabezado: "${header.text}"`);
      if (body?.text)   parts.push(`Cuerpo completo: "${body.text}"`);
      if (footer?.text) parts.push(`Pie: "${footer.text}"`);
      return `${i + 1}. Template: "${t.name}" (${t.category || 'MARKETING'})\n   ${parts.join('\n   ')}${varContexts}`;
    }).join('\n\n');

    const daysLabel = c.daysInactive != null ? `${c.daysInactive} días sin comprar` : 'inactivo por un tiempo';
    const freqLabel = c.avgFreqDays ? `compra cada ~${c.avgFreqDays} días` : 'frecuencia variable';
    const predLabel = c.predictedDays != null
      ? (c.predictedDays <= 0 ? `lleva ${Math.abs(c.predictedDays)}d de retraso en su ciclo` : `se predice que comprará en ~${c.predictedDays} días`)
      : 'pronto';

    // Preprocesar nombre: de "JUAN PEREZ" a "Juan", para evitar variables en mayúsculas
    const clientFirstName = extractFirstName(c.name, phone);
    const clientDisplayName = c.name ? toTitleCase(c.name) : phone;

    const prompt =
`Eres un experto en marketing para una tienda. Debes elegir el mejor template de WhatsApp para este cliente y rellenar sus variables.
${catalogSection}

PERFIL DEL CLIENTE:
- Nombre completo: ${clientDisplayName}
- Primer nombre: ${clientFirstName || '(desconocido)'}
- Estado: ${daysLabel} (${freqLabel})
- Última compra: ${c.lastOrderDate || '—'}
- Productos habituales: ${c.lastProducts || 'productos frescos'}
- Historial: ${c.totalOrders || 0} pedidos, $${Math.round(c.totalSpent || 0).toLocaleString('es-CL')} total gastado
- Predicción: ${predLabel}
${c.aiReason ? `- Análisis: ${c.aiReason}` : ''}

TEMPLATES DISPONIBLES:
${tplDescriptions}

PROCESO OBLIGATORIO:
1. Elige el template más apropiado para este cliente.
2. Completa en "vars" exactamente todas las variables numeradas presentes en el cuerpo.
3. Verifica que al reemplazarlas no queden palabras repetidas ni frases sin sentido.

REGLAS CRÍTICAS para las variables:
- Cada variable reemplaza EXACTAMENTE su marcador {{N}} — nada más, nada menos.
- Lee las palabras que ya están ANTES y DESPUÉS de cada variable en el template para no repetirlas.
- Si el template dice "Tenemos {{3}} frescos", el valor de {{3}} NO puede incluir "frescos".
- {{1}} suele ser el saludo personal → usa el "Primer nombre" del perfil arriba (ej: "${clientFirstName || 'amigo/a'}"). NUNCA uses el nombre completo ni mayúsculas. Si el primer nombre parece un apellido o es inusual, usa "amigo/a".
- Valores cortos y naturales (1-4 palabras máximo).

Responde SOLO con JSON válido (sin texto extra, sin markdown):
{
  "templateName": "nombre_exacto_del_template",
  "reason": "por qué este template es el mejor (1 oración corta)",
  "vars": { "1": "valor", "2": "valor", ... }
}`;

    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw   = response.content[0]?.text?.trim() || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[ai-pick-template] No JSON en respuesta:', raw);
      return res.status(500).json({ success: false, error: 'La IA no devolvió JSON válido' });
    }

    const picked = JSON.parse(match[0]);
    const tplFinal = templates.find(t => t.name === picked.templateName) || templates[0];
    picked.templateName = tplFinal.name; // normalizar por si la IA devolvió nombre incorrecto

    const vars = picked.vars || {};
    const previewText = renderTemplate(getBodyComponent(tplFinal)?.text || '', vars);

    res.json({
      success:      true,
      templateName: tplFinal.name,
      languageCode: tplFinal.language,
      vars,
      previewText,
      reason:       picked.reason || '',
    });

  } catch (err) {
    console.error('[ai-pick-template]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/templates
   Lista los templates aprobados de WhatsApp Business para esta org.
───────────────────────────────────────────────────────────────────── */
router.get('/templates', async (req, res) => {
  try {
    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
      return res.json({ success: true, data: [], message: 'Templates solo disponibles para Kapso o Meta' });
    }

    const kapsoService = require('../services/kapso-whatsapp');
    const templates = await kapsoService.getTemplates(wc);

    // Normalizar y filtrar solo APPROVED
    const normalized = (Array.isArray(templates) ? templates : []).filter(t =>
      !t.status || t.status === 'APPROVED' || t.status === 'approved'
    ).map(t => ({
      name:       t.name,
      language:   t.language,
      status:     t.status,
      category:   t.category,
      components: t.components || [],
    }));

    res.json({ success: true, data: normalized, total: normalized.length });
  } catch (err) {
    console.error('[Reengagement/templates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
/**
 * GET /api/reengagement/store-context
 * Devuelve el contexto de la tienda.
 * Prioridad: 1) DB (edits del usuario) → 2) Shopify en tiempo real
 */
router.get('/store-context', async (req, res) => {
  try {
    const orgId = req.orgId;

    // ── 1. Contexto guardado por el usuario en DB ────────────────────
    const savedContext = await db.getSetting(orgId, 'store_context');
    if (savedContext) {
      return res.json({
        success: true,
        hasShopify: false,
        context: savedContext,
        products: [],
        shopName: '',
        fromDb: true,
      });
    }

    // ── 2. Sin contexto guardado → construir desde Shopify y guardar ─
    const ds = await db.getPrimaryDataSource(orgId);
    if (!ds) {
      return res.json({ success: true, hasShopify: false, context: '', products: [], shopName: '' });
    }

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const org = await db.getOrgById(orgId);
    const orgName = org?.name || shop.replace('.myshopify.com', '').replace(/-/g, ' ');

    const context = await shopifyApi.buildFullStoreContext(shop, token, orgName);

    // Guardar en DB para la próxima carga
    if (context) await db.setSetting(orgId, 'store_context', context);

    return res.json({
      success: true,
      hasShopify: true,
      shopName: orgName,
      products: [],
      context,
    });
  } catch (err) {
    console.error('[store-context]', err.message);
    res.json({ success: false, hasShopify: false, context: '', products: [], shopName: '' });
  }
});

/**
 * POST /api/reengagement/store-context
 * Guarda el contexto editado de la tienda en DB.
 * Este contexto se usa para: generación de templates + agente de conversaciones.
 */
router.post('/store-context', async (req, res) => {
  try {
    const { context } = req.body;
    if (typeof context !== 'string') {
      return res.status(400).json({ success: false, error: 'context (string) requerido' });
    }
    await db.setSetting(req.orgId, 'store_context', context.trim());
    res.json({ success: true });
  } catch (err) {
    console.error('[store-context POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/reengagement/delivery-info
 * Devuelve la info de entrega estructurada (horarios, zona, mínimo, pagos).
 */
router.get('/delivery-info', async (req, res) => {
  try {
    const raw  = await db.getSetting(req.orgId, 'delivery_info');
    const info = raw ? JSON.parse(raw) : {};
    res.json({ success: true, info });
  } catch (err) {
    console.error('[delivery-info GET]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reengagement/delivery-info
 * Guarda la info de entrega estructurada.
 * Body: { schedule, zone, minimum, paymentMethods }
 */
router.post('/delivery-info', async (req, res) => {
  try {
    const { schedule = '', zone = '', minimum = '', paymentMethods = '' } = req.body;
    const info = { schedule, zone, minimum, paymentMethods };
    await db.setSetting(req.orgId, 'delivery_info', JSON.stringify(info));
    res.json({ success: true });
  } catch (err) {
    console.error('[delivery-info POST]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reengagement/store-context/sync
 * Re-sincroniza el contexto completo desde Shopify:
 * shop info + todas las páginas publicadas + todas las políticas + productos.
 * Sobreescribe cualquier edición manual en DB.
 */
router.post('/store-context/sync', async (req, res) => {
  try {
    const orgId = req.orgId;
    const ds    = await db.getPrimaryDataSource(orgId);
    if (!ds) return res.status(400).json({ success: false, error: 'Shopify no conectado' });

    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const org = await db.getOrgById(orgId);
    const orgName = org?.name || shop.replace('.myshopify.com', '').replace(/-/g, ' ');

    const context = await shopifyApi.buildFullStoreContext(shop, token, orgName);
    await db.setSetting(orgId, 'store_context', context);

    res.json({ success: true, context });
  } catch (err) {
    console.error('[store-context/sync]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reengagement/generate-templates
 * Usa IA para generar 5 templates de re-engagement personalizados para la tienda.
 * Body (opcional): { storeContext: "texto libre con contexto de la tienda" }
 */
router.post('/generate-templates', async (req, res) => {
  try {
    const orgId = req.orgId;
    const { storeContext: providedContext } = req.body || {};
    const db    = require('../db/database.js');
    const shopifyApi = require('../services/shopify-api.js');
    const Anthropic  = require('@anthropic-ai/sdk');

    // Usar contexto provisto por el usuario, o intentar Shopify
    let storeContext = '';
    let shopName = 'la tienda';

    if (providedContext && providedContext.trim()) {
      // El frontend ya hizo el enriquecimiento con Shopify o el usuario escribió su contexto
      storeContext = providedContext.trim();
    } else {
      // Fallback: intentar Shopify directamente
      const ds = await db.getPrimaryDataSource(orgId);
      if (ds) {
        try {
          const { shop, token } = shopifyApi.credentialsFrom(ds);
          shopName = shop.replace('.myshopify.com', '').replace(/-/g, ' ');
          const raw = await shopifyApi.getProducts(shop, token, { limit: 15 });
          const prods = (raw?.products || []).slice(0, 10);
          const org = await db.getOrgById(orgId);
          const orgName = org?.name || shopName;
          const productLines = prods.map(p => {
            const price = p.priceMin > 0
              ? ` ($${p.priceMin.toLocaleString('es-CL')} ${p.currency})`
              : '';
            return `  - ${p.title}${price}`;
          });
          storeContext = [
            `Tienda: ${orgName}`,
            `Dominio Shopify: ${shop}`,
            prods.length
              ? `Productos del catálogo:\n${productLines.join('\n')}`
              : 'Sin productos cargados aún',
          ].join('\n');
        } catch (e) {
          console.warn('[generate-templates] Error obteniendo datos Shopify:', e.message);
          storeContext = 'Tienda online latinoamericana';
        }
      } else {
        storeContext = 'Tienda online latinoamericana';
      }
    }

    const client = new Anthropic();
    const prompt = `Eres un experto en marketing de WhatsApp para e-commerce latinoamericano.

Contexto de la tienda:
${storeContext}

Genera exactamente 5 templates de WhatsApp Business para re-engagement. Los templates se envían a Meta para aprobación.

OBJETIVO ESTRATÉGICO — MUY IMPORTANTE:
WhatsApp cobra por cada template enviado, pero cuando el cliente RESPONDE (cualquier respuesta),
se abre una ventana GRATUITA de 24 horas donde el bot puede conversar sin costo.
Por eso, cada template debe estar diseñado para PROVOCAR UNA RESPUESTA del cliente.
El bot luego toma esa respuesta y guía al cliente hacia una compra.

REGLA CLAVE — PREGUNTA DE CIERRE:
Cada template DEBE terminar con UNA pregunta simple que el cliente quiera responder.
La pregunta debe ser:
- De respuesta corta: Sí/No, una palabra, un número
- Que genere curiosidad o sea difícil de ignorar
- Que conecte naturalmente con mostrar productos o hacer una venta
Ejemplos buenos: "¿Te muestro lo nuevo?", "¿Quieres que te guarde uno?", "¿Cuándo fue la última vez que pediste?"

REGLAS TÉCNICAS — CRÍTICAS (Meta rechaza si no se cumplen):
- name: SOLO letras a-z, números 0-9 y guiones bajos. SIN acentos, SIN ñ, SIN espacios. Máx 40 chars. Ejemplos válidos: "reenganche_general", "novedad_productos", "oferta_exclusiva"
- category: siempre "MARKETING"
- language: "es"
- El BODY debe tener máximo 1024 caracteres
- Usa {{1}} para nombre del cliente (siempre la primera variable)
- Si mencionas un producto específico usa {{2}}
- El footer siempre: "Responde STOP para no recibir mensajes"
- NO incluir URLs ni emojis en el headerText
- PROHIBIDO: el body NO puede empezar ni terminar con una variable {{N}}. Siempre debe haber texto antes y después de cualquier variable. Incorrecto: "{{1}}, tu pedido llegó". Correcto: "Hola {{1}}, tu pedido llegó"
- Tono cálido, cercano, latinoamericano
- Menciona productos reales del catálogo cuando sea posible

Los 5 templates (cada uno con un gancho diferente para provocar respuesta):
1. Re-engagement emocional — "Te extrañamos" + pregunta sobre qué necesitan esta semana
2. Novedad irresistible — "Llegó algo que creo que te va a encantar" + ¿quieres verlo?
3. Recordatorio de producto favorito — menciona el último producto que compraron + ¿lo repetimos?
4. Oferta exclusiva con urgencia — descuento/beneficio especial + ¿lo activo para ti?
5. Post-compra con upsell — seguimiento de pedido anterior + ¿qué más necesitas?

Responde SOLO con JSON válido (sin markdown ni texto extra):
{
  "templates": [
    {
      "name": "nombre_snake_case",
      "displayName": "Nombre legible",
      "category": "MARKETING",
      "language": "es",
      "headerText": "Texto del header (sin variables, max 60 chars, sin emojis ni URLs)",
      "body": "Cuerpo del mensaje con {{1}} para nombre... termina con una pregunta simple.",
      "footer": "Responde STOP para no recibir mensajes",
      "variables": ["nombre del cliente", "descripción de variable 2 si existe"],
      "closingQuestion": "La pregunta de cierre del template (para mostrar en la UI)",
      "useCase": "Cuándo usar este template (1 línea)"
    }
  ]
}`;

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 3500,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw = msg.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { templates: [] };
    }

    return res.json({ success: true, templates: parsed.templates || [] });
  } catch (err) {
    console.error('[generate-templates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Sanitiza el nombre del template para cumplir reglas de Meta:
 * solo letras minúsculas a-z, números 0-9 y guiones bajos.
 * Convierte ñ→n, á→a, é→e, etc. y reemplaza cualquier otro char inválido con _.
 */
function sanitizeTemplateName(name) {
  return (name || 'template_reenganche')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics: ñ→n, á→a, é→e…
    .replace(/[^a-z0-9_]/g, '_')       // any remaining invalid char → _
    .replace(/_+/g, '_')               // collapse consecutive underscores
    .replace(/^_+|_+$/g, '')           // trim leading/trailing underscores
    .slice(0, 512) || 'template_reenganche';
}

/**
 * Meta no permite que el body empiece o termine con una variable {{N}}.
 * Si la IA genera eso, añadimos texto neutro para cumplir la regla.
 */
function fixBodyVariables(body) {
  if (!body) return body;
  let b = body.trim();
  // Empieza con {{N}} → agregar saludo antes
  if (/^\{\{\d+\}\}/.test(b)) b = 'Hola, ' + b;
  // Termina con {{N}} o {{N}}. o {{N}}! → agregar texto después
  if (/\{\{\d+\}\}[.!?]?\s*$/.test(b)) b = b.replace(/(\{\{\d+\}\}[.!?]?\s*)$/, '$1 ¿Te ayudamos?');
  return b;
}

/**
 * POST /api/reengagement/submit-templates
 * Envía templates a Meta via Kapso para revisión.
 * Body: { templates: [{name, category, language, headerText, body, footer}] }
 */
router.post('/submit-templates', async (req, res) => {
  try {
    const orgId    = req.orgId;
    const { templates } = req.body;
    if (!Array.isArray(templates) || templates.length === 0) {
      return res.status(400).json({ success: false, error: 'templates array requerido' });
    }

    const db           = require('../db/database.js');
    const kapsoService = require('../services/kapso-whatsapp.js');

    const wc = await db.getWhatsappConfig(orgId);
    if (!wc || (wc.provider !== 'kapso' && wc.provider !== 'meta')) {
      return res.status(400).json({ success: false, error: 'Requiere proveedor Kapso o Meta' });
    }

    const results = [];
    for (const t of templates) {
      try {
        // ── Sanitizar nombre y body antes de enviar a Meta ───────────
        const safeName = sanitizeTemplateName(t.name);
        const safeBody = fixBodyVariables(t.body);

        // Construir componentes Meta
        const components = [];
        const headerText = t.headerText || t.header || '';
        if (headerText) {
          components.push({ type: 'HEADER', format: 'TEXT', text: headerText });
        }
        const bodyComp = { type: 'BODY', text: safeBody };
        // Agregar ejemplos de variables si las hay
        const varMatches = [...(safeBody || '').matchAll(/\{\{(\d+)\}\}/g)];
        if (varMatches.length > 0) {
          const exampleValues = (t.variables || []).map((v, i) => v || `Ejemplo ${i+1}`);
          bodyComp.example = { body_text: [exampleValues.slice(0, varMatches.length)] };
        }
        components.push(bodyComp);
        if (t.footer) {
          components.push({ type: 'FOOTER', text: t.footer });
        }

        const payload = {
          name:       safeName,
          language:   t.language || 'es',
          category:   t.category || 'MARKETING',
          components,
        };

        const apiResult = await kapsoService.createTemplate(payload, wc);
        results.push({ name: safeName, success: true, status: 'submitted', id: apiResult?.id });
      } catch (err) {
        const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        results.push({ name: sanitizeTemplateName(t.name), success: false, status: 'error', error: errMsg });
      }
    }

    const allOk    = results.every(r => r.success);
    const someOk   = results.some(r => r.success);
    res.json({
      success: someOk,
      results,
      message: allOk
        ? `${results.length} templates enviados a Meta. Revisión en 1-3 días hábiles.`
        : `${results.filter(r => r.status === 'submitted').length}/${results.length} templates enviados. Algunos fallaron.`,
    });
  } catch (err) {
    console.error('[submit-templates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   Historial auditable de campañas masivas
───────────────────────────────────────────────────────────────────── */
router.get('/sending-methods', async (req, res) => {
  try { res.json({ methods: await require('../services/broadcast-sender').sendingMethods(req.orgId) }); }
  catch (error) { res.status(503).json({ error: 'No se pudieron consultar las conexiones' }); }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { templateName, total, testMode = false, testPhone = null, sendingProvider = 'kapso', sendingChannelId = null } = req.body || {};
    if (req.body?.sendingProvider) await require('../services/broadcast-sender').resolveSender(req.orgId, sendingProvider, sendingChannelId);
    const pacing = sendingProvider === 'evolution' ? require('../services/broadcast-sender').pacingSettings(req.body.pacingSettings) : null;
    const totalCount = Number(total);
    if (!templateName) return res.status(400).json({ success: false, error: 'templateName requerido' });
    if (!Number.isInteger(totalCount) || totalCount < 1 || totalCount > 5000) {
      return res.status(400).json({ success: false, error: 'Cantidad de destinatarios inválida' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO broadcast_campaigns
         (organization_id, created_by, template_name, total_count, test_mode, test_phone, sending_provider, sending_channel_id, pacing_settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.orgId, req.userId, templateName, totalCount, !!testMode,
        testPhone ? db.normalizePhone(testPhone) : null, sendingProvider, sendingChannelId, pacing ? JSON.stringify(pacing) : null]
    );
    res.json({ success: true, campaign: rows[0] });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/campaigns/:id/start', async (req, res) => {
  let client;
  try {
    const campaign = await getBroadcastCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (campaign.server_managed) return res.json({ success: true, campaign });
    if (campaign.sending_provider !== 'evolution' || campaign.status !== 'processing') return res.status(409).json({ error: 'Campaña no disponible para envío en segundo plano' });
    await require('../services/broadcast-sender').resolveSender(req.orgId, 'evolution', campaign.sending_channel_id);
    const items = req.body.items;
    if (!Array.isArray(items) || items.length !== Number(campaign.total_count) || items.length > 5000) return res.status(400).json({ error: 'Destinatarios inválidos' });
    const phones = new Set();
    const prepared = items.map(item => {
      const phone = db.normalizePhone(item.phone);
      const message = String(item.templateName ? item.previewText || '' : item.message || '').trim();
      if (!/^[0-9]{8,15}$/.test(phone) || !message || message.length > 4096 || phones.has(phone)) throw Object.assign(new Error('Revisa los teléfonos y mensajes del lote; no debe haber destinatarios repetidos'), { status: 400 });
      phones.add(phone);
      return { phone, message, contactName: item.contactName || null, originalPhone: item.originalPhone || phone };
    });
    client = await getPool().connect();
    await client.query('BEGIN');
    const locked = (await client.query('SELECT * FROM broadcast_campaigns WHERE id = $1 AND organization_id = $2 FOR UPDATE', [campaign.id, req.orgId])).rows[0];
    if (!locked || locked.status !== 'processing') throw Object.assign(new Error('Campaña detenida'), { status: 409 });
    if (!locked.server_managed) {
      const existing = await client.query('SELECT 1 FROM broadcast_campaign_recipients WHERE campaign_id = $1 LIMIT 1', [campaign.id]);
      if (existing.rows.length) throw Object.assign(new Error('La campaña ya comenzó; crea una nueva con los pendientes'), { status: 409 });
      await client.query(`INSERT INTO broadcast_jobs (campaign_id, organization_id, position, item)
        SELECT $1, $2, ordinality::integer, value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY`,
        [campaign.id, req.orgId, JSON.stringify(prepared)]);
      await client.query('UPDATE broadcast_campaigns SET server_managed = TRUE WHERE id = $1', [campaign.id]);
    }
    await client.query('COMMIT');
    res.json({ success: true, campaign: { ...campaign, server_managed: true } });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    res.status(error.status || 500).json({ error: error.message });
  } finally { client?.release(); }
});

router.post('/campaigns/:id/stop', async (req, res) => {
  try {
    const { rows } = await getPool().query(`UPDATE broadcast_campaigns
      SET status = CASE WHEN status = 'processing' THEN 'interrupted' ELSE status END,
        completed_at = COALESCE(completed_at, NOW())
      WHERE id = $1 AND organization_id = $2 AND server_managed RETURNING *`, [req.params.id, req.orgId]);
    if (!rows[0]) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ success: true, campaign: rows[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/campaigns/:id/finish', async (req, res) => {
  try {
    const requested = req.body?.status;
    const status = requested === 'paused_payment'
      ? 'paused_payment'
      : (requested === 'interrupted' ? 'interrupted' : 'completed');
    const { rows } = await getPool().query(
      `UPDATE broadcast_campaigns
          SET status = CASE WHEN status = 'paused_payment' THEN status ELSE $1 END,
              completed_at = COALESCE(completed_at, NOW())
       WHERE id = $2 AND organization_id = $3 AND NOT server_managed RETURNING *`,
      [status, req.params.id, req.orgId]
    );
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    res.json({ success: true, campaign: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/campaigns', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    // Red de seguridad: si el webhook de pago llegó antes de que la auditoría
    // del destinatario terminara, la lectura del historial abre igualmente el
    // cortacircuito y deja la causa persistida.
    await getPool().query(
      `UPDATE broadcast_campaigns c
          SET status = 'paused_payment', pause_code = '131042',
              pause_reason = 'Meta bloqueó los envíos por un problema de pago o elegibilidad',
              paused_at = COALESCE(paused_at, NOW()),
              completed_at = COALESCE(completed_at, NOW())
        WHERE c.organization_id = $1 AND c.status <> 'paused_payment'
          AND EXISTS (
            SELECT 1 FROM broadcast_campaign_recipients r
            JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
             WHERE r.campaign_id = c.id AND m.status = 'failed'
               AND m.delivery_error->>'code' = '131042'
          )`,
      [req.orgId]
    );
    // Si el proceso fue reiniciado durante un envío, cerrar campañas sin
    // actividad reciente para que nunca queden en "procesando" eternamente.
    await getPool().query(
      `UPDATE broadcast_campaigns c
          SET status = 'interrupted', completed_at = COALESCE(completed_at, NOW())
        WHERE c.organization_id = $1
          AND c.status = 'processing' AND NOT c.server_managed
          AND c.created_at < NOW() - INTERVAL '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_campaign_recipients r
             WHERE r.campaign_id = c.id
               AND r.created_at > NOW() - CASE WHEN c.sending_provider = 'evolution' THEN INTERVAL '15 minutes' ELSE INTERVAL '5 minutes' END
          )`,
      [req.orgId]
    );
    const recoveredRecipients = await recoverCampaignRecipientsFromSavedMessages(req.orgId);
    const recoveredChats = await reconcileAcceptedBroadcastMessages(req.orgId);
    const { rows } = await getPool().query(
      `SELECT c.*,
         (SELECT COUNT(*)::int FROM broadcast_jobs j WHERE j.campaign_id = c.id AND j.state = 'unknown') AS queue_unknown_count,
         COUNT(r.id)::int AS processed_count,
         GREATEST(c.total_count - COUNT(r.id), 0)::int AS pending_count,
         COUNT(*) FILTER (WHERE r.result_status = 'skipped')::int AS skipped_count,
         COUNT(*) FILTER (WHERE r.result_status = 'failed' OR m.status = 'failed')::int AS failed_count,
         COUNT(*) FILTER (WHERE r.result_status = 'unknown')::int AS unknown_count,
         COUNT(*) FILTER (WHERE r.result_status = 'accepted' AND m.status = 'read')::int AS read_count,
         COUNT(*) FILTER (WHERE r.result_status = 'accepted' AND m.status = 'delivered')::int AS delivered_count,
         COUNT(*) FILTER (WHERE r.result_status = 'accepted' AND COALESCE(m.status, 'sent') IN ('pending','sent'))::int AS accepted_count
       FROM broadcast_campaigns c
       LEFT JOIN broadcast_campaign_recipients r ON r.campaign_id = c.id
       LEFT JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
       WHERE c.organization_id = $1
       GROUP BY c.id ORDER BY c.created_at DESC LIMIT $2`,
      [req.orgId, limit]
    );
    const ids = rows.map(row => row.id);
    let reasons = [];
    if (ids.length) {
      const result = await getPool().query(
        `WITH campaign_reasons AS (
           SELECT r.campaign_id, r.result_status, r.error_code, r.error_message
             FROM broadcast_campaign_recipients r
            WHERE r.campaign_id = ANY($1::bigint[])
              AND r.result_status IN ('failed','skipped','unknown')
           UNION ALL
           SELECT r.campaign_id, 'failed' AS result_status,
                  m.delivery_error->>'code' AS error_code,
                  CASE WHEN m.delivery_error->>'code' = '131042'
                       THEN 'Meta bloqueó el envío por un problema de pago o elegibilidad'
                       ELSE COALESCE(m.delivery_error->>'message', 'WhatsApp informó un fallo de entrega')
                  END AS error_message
             FROM broadcast_campaign_recipients r
             JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
            WHERE r.campaign_id = ANY($1::bigint[])
              AND r.result_status = 'accepted' AND m.status = 'failed'
         )
         SELECT campaign_id, result_status, error_code, error_message, COUNT(*)::int AS total
           FROM campaign_reasons
          GROUP BY campaign_id, result_status, error_code, error_message
          ORDER BY total DESC`,
        [ids]
      );
      reasons = result.rows;
    }
    res.json({ success: true, recoveredChats, recoveredRecipients, campaigns: rows.map(row => ({
      ...row,
      reasons: reasons.filter(reason => String(reason.campaign_id) === String(row.id)),
    })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await getBroadcastCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    const { rows } = await getPool().query(
      `SELECT r.*,
         CASE
           WHEN r.result_status <> 'accepted' THEN r.result_status
           WHEN m.status IS NOT NULL THEN m.status
           ELSE 'sent'
         END AS current_status,
         m.delivery_error,
         COALESCE(r.error_code, m.delivery_error->>'code') AS display_error_code,
         COALESCE(r.error_message,
           CASE WHEN m.delivery_error->>'code' = '131042'
                THEN 'Meta bloqueó el envío por un problema de pago o elegibilidad'
                ELSE m.delivery_error->>'message' END) AS display_error_message
       FROM broadcast_campaign_recipients r
       LEFT JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
       WHERE r.campaign_id = $1 AND r.organization_id = $2
       ORDER BY r.id`,
      [req.params.id, req.orgId]
    );
    if (campaign.server_managed) {
      const uncertain = await getPool().query(`SELECT 'job-' || j.id AS id,
        j.item->>'phone' AS destination_phone, j.item->>'contactName' AS contact_name,
        'unknown' AS result_status, 'unknown' AS current_status,
        COALESCE(j.result->>'error', j.result->>'warning', 'Envío pendiente de revisión; no reenviar sin confirmar') AS display_error_message
        FROM broadcast_jobs j WHERE j.campaign_id = $1 AND j.organization_id = $2 AND j.state = 'unknown'
          AND NOT EXISTS (SELECT 1 FROM broadcast_campaign_recipients r WHERE r.campaign_id = j.campaign_id
            AND r.destination_phone = j.item->>'phone') ORDER BY j.position`, [req.params.id, req.orgId]);
      rows.push(...uncertain.rows);
    }
    res.json({ success: true, campaign, recipients: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/campaigns/:id/reconcile-statuses', async (req, res) => {
  try {
    const campaign = await getBroadcastCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    const result = await require('../services/broadcast-status-reconciliation').reconcileCampaignStatuses(
      req.orgId,
      campaign.id,
      { force: req.body?.force === true }
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CampaignStatus]', err.message);
    res.status(500).json({ success: false, error: 'No se pudieron verificar los estados con Meta' });
  }
});

router.get('/campaigns/:id/payment-retry-preview', async (req, res) => {
  try {
    const campaign = await getBroadcastCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });
    const templates = await require('../services/kapso-whatsapp').getTemplates(wc);
    const template = templates.find(candidate => candidate.name === campaign.template_name);
    if (!template) return res.status(409).json({ success: false, error: `El template ${campaign.template_name} ya no está disponible en Meta` });
    const templateBody = getBodyComponent(template)?.text || '';
    const { rows } = await getPool().query(
      `SELECT r.*, m.content AS saved_content, m.conversation_id
         FROM broadcast_campaign_recipients r
         LEFT JOIN messages m ON m.whatsapp_message_id = r.whatsapp_message_id
        WHERE r.campaign_id = $1 AND r.organization_id = $2
          AND (r.error_code = '131042' OR m.delivery_error->>'code' = '131042')
          AND (r.result_status = 'failed' OR m.status = 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM messages newer
             WHERE m.conversation_id IS NOT NULL
               AND newer.conversation_id = m.conversation_id
               AND newer.created_at > m.created_at
               AND newer.direction = 'outbound' AND newer.type = 'template'
               AND newer.status <> 'failed'
               AND newer.content LIKE '[Template: ' || r.template_name || ']%'
          )
        ORDER BY r.id`,
      [campaign.id, req.orgId]
    );
    const items = [];
    const excluded = [];
    for (const recipient of rows) {
      const phone = db.normalizePhone(recipient.destination_phone || recipient.original_phone);
      const previewText = String(recipient.saved_content || '')
        .replace(/^\[Template:\s*[^\]]+\](?:\r?\n){0,2}/, '');
      const components = recipient.template_components?.length
        ? recipient.template_components
        : recoverBodyTemplateComponent(templateBody, previewText);
      if (!phone || !components.length || getMissingBodyParameters(templateBody, components).length) {
        excluded.push({ id: recipient.id, name: recipient.contact_name || 'Cliente', reason: phone ? 'No se pudieron recuperar las variables exactas' : 'Número inválido' });
        continue;
      }
      items.push({
        phone,
        originalPhone: recipient.original_phone || phone,
        contactName: recipient.contact_name || 'Cliente',
        templateName: campaign.template_name,
        languageCode: recipient.language_code || template.language || 'es',
        components,
        previewText: previewText || renderTemplateFromComponents(templateBody, components),
        force: true,
      });
    }
    res.json({ success: true, campaign, template, items, excluded });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/campaigns/:id/follow-up-preview', async (req, res) => {
  try {
    const campaign = await getBroadcastCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    if (campaign.sending_provider === 'evolution') return res.status(409).json({ error: 'El seguimiento programado sólo está disponible para campañas Kapso' });
    const audience = await require('../services/campaign-follow-up').getFollowUpAudience(req.orgId, req.params.id);
    const eligible = audience.filter(item => item.eligible);
    const excluded = audience.filter(item => !item.eligible);
    const { rows: [job] } = await getPool().query(
      `SELECT * FROM broadcast_followup_jobs
        WHERE organization_id=$1 AND source_campaign_id=$2 AND status <> 'cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [req.orgId, campaign.id]
    );
    const reasonCounts = {};
    excluded.flatMap(item => item.reasons).forEach(reason => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; });
    res.json({
      success: true,
      campaign,
      summary: { read: audience.length, eligible: eligible.length, excluded: excluded.length, reasons: reasonCounts },
      job: job || null,
      scheduled: Boolean(job && ['scheduled','processing','completed'].includes(job.status)),
      recipients: audience.map(item => ({
        phone: item.phone,
        contactName: item.contact_name,
        eligible: item.eligible,
        reasons: item.reasons,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/campaigns/:id/follow-up', async (req, res) => {
  try {
    const campaign = await getBroadcastCampaign(req.orgId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    if (campaign.sending_provider === 'evolution') return res.status(409).json({ error: 'El seguimiento programado sólo está disponible para campañas Kapso' });
    const audience = await require('../services/campaign-follow-up').getFollowUpAudience(req.orgId, req.params.id);
    const eligible = audience.filter(item => item.eligible).length;
    if (!eligible) return res.status(400).json({ success: false, error: 'No hay personas elegibles para seguimiento' });
    const templateName = String(req.body?.templateName || campaign.template_name || '').trim();
    if (!templateName) return res.status(400).json({ success: false, error: 'Falta el template de seguimiento' });
    const { rows: [job] } = await getPool().query(`
      INSERT INTO broadcast_followup_jobs
        (organization_id,source_campaign_id,template_name,language_code,scheduled_for,conditions,created_by)
      VALUES ($1,$2,$3,$4,
        (date_trunc('day',NOW() AT TIME ZONE 'America/Santiago') + INTERVAL '1 day 10 hours') AT TIME ZONE 'America/Santiago',
        $5,$6)
      ON CONFLICT(source_campaign_id,scheduled_for) DO UPDATE
        SET template_name=EXCLUDED.template_name,language_code=EXCLUDED.language_code,
            conditions=EXCLUDED.conditions,created_by=EXCLUDED.created_by,
            status='scheduled',last_error=NULL,completed_at=NULL
      RETURNING *
    `, [req.orgId, campaign.id, templateName, req.body?.languageCode || 'es',
      require('../services/campaign-follow-up').DEFAULT_CONDITIONS, req.userId]);
    res.json({ success: true, job, eligible });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/send
   Soporta dos modos:
     A) Texto libre:  { phone, message }
     B) Template:     { phone, templateName, languageCode?, components? }
───────────────────────────────────────────────────────────────────── */
router.post('/send', async (req, res) => {
  try {
    let { phone, message, templateName, languageCode, components } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone requerido' });
    // Normalizar: con código de país, sin "+"
    phone = db.normalizePhone(phone);

    const isTemplate = !!templateName;
    if (!isTemplate && !message) {
      return res.status(400).json({ success: false, error: 'message o templateName requerido' });
    }

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    let sentResult;
    let savedContent;

    if (isTemplate) {
      // ── Modo Template ───────────────────────────────────────────
      if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
        return res.status(400).json({ success: false, error: 'Templates solo disponibles con Kapso o Meta' });
      }
      const kapsoService = require('../services/kapso-whatsapp');
      const templates = await kapsoService.getTemplates(wc);
      const template = templates.find(item => item.name === templateName);
      if (!template) return res.status(400).json({ success: false, error: `Template ${templateName} no encontrado` });
      const body = getBodyComponent(template)?.text || '';
      const missing = getMissingBodyParameters(body, components || []);
      if (missing.length) return res.status(400).json({ success: false, error: `Faltan valores para ${missing.map(number => `{{${number}}}`).join(', ')}` });
      const rendered = renderTemplateFromComponents(body, components || []);
      sentResult = await kapsoService.sendTemplate(
        phone, templateName, languageCode || 'es', components || [], wc
      );
      savedContent = rendered
        ? `[Template: ${templateName}]\n\n${rendered}`
        : `[Template: ${templateName}]`;
    } else {
      // ── Modo Texto libre ─────────────────────────────────────────
      if (wc.provider === 'twilio') {
        sentResult = await require('../services/twilio-whatsapp').sendTextMessage(phone, message, wc);
      } else if (wc.provider === 'kapso') {
        sentResult = await require('../services/kapso-whatsapp').sendTextMessage(phone, message, wc);
      } else {
        sentResult = await require('../services/whatsapp').sendTextMessage(phone, message, wc);
      }
      savedContent = message;
    }

    // Buscar o crear conversación para este contacto
    const cached = analysisCache.get(req.orgId);
    const clientData = cached?.data?.find(x => x.phone === phone);
    const contactName = clientData?.name ? toTitleCase(clientData.name) : 'Cliente';
    const conv = await db.upsertConversation(req.orgId, phone, contactName);
    const convId = conv?.id;

    if (convId) {
      const savedMsg = await db.saveMessage({
        conversationId:    convId,
        whatsappMessageId: sentResult?.messages?.[0]?.id || `reeng_${Date.now()}`,
        content:           savedContent,
        direction:         'outbound',
        type:              isTemplate ? 'template' : 'text',
        sentBy:            'ai',
      });
      await db.updateConversationLastMessage(convId, savedContent);
      if (isTemplate) {
        await activateDivaForAutomatedMessage(convId, db);
      }
      const updated = await db.getConversationById(convId);
      io?.to(`org_${req.orgId}`).emit(`new_message_${req.orgId}`, { message: savedMsg, conversation: updated });
      // Marcar conversación como "esperando respuesta a template"
      if (isTemplate) {
        await db.updatePipelineState(convId, 'template_sent');
      }
    }

    // Registrar envío para prevenir duplicados el mismo día
    if (isTemplate) await markTemplateSent(req.orgId, phone);

    res.json({ success: true, phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/send-broadcast
   Crea una campaña asíncrona nativa en Kapso para uno o más clientes.
   Kapso conserva la cola aunque el navegador se cierre.
──────────────────────────────────────────────────────────────────── */
router.post('/send-broadcast', async (req, res) => {
  const { items, campaignId = null } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ success: false, error: 'items[] requerido' });
  }
  const campaign = campaignId ? await getBroadcastCampaign(req.orgId, campaignId) : null;
  if (campaignId && !campaign) {
    return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
  }
  const templateNames = [...new Set(items.map(item => item.templateName).filter(Boolean))];
  if (templateNames.length !== 1 || items.some(item => !item.templateName)) {
    return res.status(400).json({ success: false, error: 'La campaña debe usar un único template aprobado' });
  }

  const wc = await db.getWhatsappConfig(req.orgId);
  if (!wc || wc.provider !== 'kapso') {
    return res.status(400).json({ success: false, error: 'Broadcast requiere una conexión activa con Kapso' });
  }
  const marketingPermitted = await require('../services/commercial').permitted(req.orgId, 'marketing');
  if (!marketingPermitted) {
    return res.status(403).json({ success: false, error: 'Contrato no disponible' });
  }

  const results = [];
  const eligible = [];
  for (const rawItem of items) {
    const item = { ...rawItem, phone: db.normalizePhone(rawItem.phone) };
    if (!item.phone) {
      await recordBroadcastRecipient(req.orgId, campaignId, item, { status: 'failed', errorMessage: 'Número inválido' });
      results.push({ phone: rawItem.phone, success: false, error: 'Número inválido' });
      continue;
    }
    if (await templateSentToday(req.orgId, item.phone)) {
      await recordBroadcastRecipient(req.orgId, campaignId, item, { status: 'skipped', errorMessage: 'Ya recibió un template hoy' });
      results.push({ phone: item.phone, success: false, skipped: true, error: 'Ya recibió un template hoy' });
      continue;
    }
    if (await customerRecentlyDeclined(req.orgId, item.phone)) {
      await recordBroadcastRecipient(req.orgId, campaignId, item, { status: 'skipped', errorMessage: 'Cliente declinó recientemente' });
      results.push({ phone: item.phone, success: false, skipped: true, error: 'Cliente declinó recientemente' });
      continue;
    }
    eligible.push(item);
  }

  if (!eligible.length) {
    return res.json({ success: true, sent: 0, skipped: results.length, pending: 0, failed: 0, results });
  }

  const kapso = require('../services/kapso-whatsapp');
  let providerBroadcastId = null;
  try {
    const templates = await kapso.getTemplates(wc);
    const language = eligible[0].languageCode || 'es';
    const template = templates.find(candidate => candidate.name === templateNames[0]
      && (!candidate.language || candidate.language === language || candidate.language_code === language));
    const templateId = template?.meta_template_id || template?.id;
    if (!templateId) throw new Error(`No se encontró el template aprobado ${templateNames[0]} (${language})`);

    const label = `${templateNames[0]} ${new Date().toISOString()} CRM-${campaignId || 'manual'}`;
    const providerBroadcast = await kapso.createBroadcast(label, templateId, wc);
    providerBroadcastId = providerBroadcast?.id;
    if (!providerBroadcastId) throw new Error('Kapso no devolvió el identificador del broadcast');

    const providerRecipients = eligible.map(item => ({
      phone_number: `+${item.phone}`,
      components: item.components || [],
    }));
    const added = await kapso.addBroadcastRecipients(providerBroadcastId, providerRecipients, wc);
    if (Number(added?.added || 0) < 1) {
      throw new Error(added?.errors?.join(' · ') || 'Kapso no aceptó ningún destinatario');
    }
    const rejectedIndexes = new Set((added?.errors || []).flatMap(message => {
      const match = String(message).match(/Recipient\s+(\d+)/i);
      return match ? [Math.max(Number(match[1]) - 1, 0)] : [];
    }));
    const queued = eligible.filter((item, index) => !rejectedIndexes.has(index));
    const rejected = eligible.filter((item, index) => rejectedIndexes.has(index));
    await kapso.startBroadcast(providerBroadcastId, wc);

    if (campaignId) {
      await getPool().query(
        'UPDATE broadcast_campaigns SET provider_broadcast_id = $1 WHERE id = $2 AND organization_id = $3',
        [providerBroadcastId, campaignId, req.orgId]
      );
    }
    await Promise.all(queued.map(item => recordBroadcastRecipient(req.orgId, campaignId, item, {
      status: 'unknown',
      errorMessage: 'Broadcast iniciado; esperando confirmación individual de WhatsApp',
      errorDetail: { providerBroadcastId },
    })));
    await Promise.all(rejected.map(item => recordBroadcastRecipient(req.orgId, campaignId, item, {
      status: 'failed', errorMessage: 'Kapso rechazó los datos de este destinatario',
      errorDetail: { providerBroadcastId, errors: added?.errors || [] },
    })));
    queued.forEach(item => results.push({
      phone: item.phone, success: false, pending: true,
      error: 'Broadcast iniciado; esperando confirmación individual de WhatsApp',
    }));
    rejected.forEach(item => results.push({
      phone: item.phone, success: false, error: 'Kapso rechazó los datos de este destinatario',
    }));
    return res.status(202).json({
      success: true, providerBroadcastId, sent: 0,
      skipped: results.filter(result => result.skipped).length,
      pending: queued.length, failed: rejected.length, results,
    });
  } catch (err) {
    const timedOut = err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(String(err?.message || ''));
    const failure = describeBroadcastError(err);
    const status = timedOut && providerBroadcastId ? 'unknown' : 'failed';
    await Promise.all(eligible.map(item => recordBroadcastRecipient(req.orgId, campaignId, item, {
      status,
      errorCode: failure.code,
      errorMessage: timedOut && providerBroadcastId
        ? 'Kapso recibió la campaña, pero aún no confirmó su inicio. No la reenvíes.'
        : failure.message,
      errorDetail: { providerBroadcastId, provider: failure.detail },
    })));
    if (timedOut && providerBroadcastId) {
      eligible.forEach(item => results.push({ phone: item.phone, success: false, pending: true, error: 'Resultado por confirmar' }));
      return res.status(202).json({ success: true, providerBroadcastId, sent: 0, skipped: 0, pending: eligible.length, failed: 0, results });
    }
    eligible.forEach(item => results.push({ phone: item.phone, success: false, error: failure.message, errorCode: failure.code }));
    return res.status(502).json({ success: false, error: failure.message, providerBroadcastId, results });
  }
});

/* ────────────────────────────────────────────────────────────────────
   POST /api/reengagement/send-bulk
   Soporta dos modos por ítem:
     A) Texto libre:  { phone, message }
     B) Template:     { phone, templateName, languageCode?, components? }
───────────────────────────────────────────────────────────────────── */
async function sendBulk(req, res) {
  const { items, campaignId = null } = req.body;
  let pacing = req.body.pacingSettings || {};
  let sendingProvider = req.body.sendingProvider || null;
  let sendingChannelId = req.body.sendingChannelId || null;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ success: false, error: 'items[] requerido' });
  }

  if (campaignId) {
    const campaign = await getBroadcastCampaign(req.orgId, campaignId);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
    if (campaign.server_managed && (!req[SERVER_QUEUE] || campaign.status !== 'processing')) {
      return res.status(409).json({ error: 'Esta campaña se controla desde el servidor' });
    }
    if ((sendingProvider && sendingProvider !== (campaign.sending_provider || 'kapso'))
      || (sendingChannelId && Number(sendingChannelId) !== Number(campaign.sending_channel_id))) {
      return res.status(409).json({ error: 'El método de envío no coincide con la campaña' });
    }
    pacing = campaign.pacing_settings || {};
    sendingProvider = campaign.sending_provider || 'kapso';
    sendingChannelId = campaign.sending_channel_id || null;
    if (campaign.status === 'paused_payment') {
      return res.status(409).json({
        success: false,
        campaignPaused: true,
        errorCode: campaign.pause_code || campaignGuard.META_PAYMENT_ERROR,
        error: campaign.pause_reason || 'Campaña detenida por un problema de pago de Meta',
      });
    }
  }

  const direct = sendingProvider === 'evolution';
  if (direct && items.length !== 1) return res.status(400).json({ error: 'El envío directo procesa un destinatario a la vez' });
  let wc;
  try {
    wc = sendingProvider
      ? await require('../services/broadcast-sender').resolveSender(req.orgId, sendingProvider, sendingChannelId)
      : await db.getWhatsappConfig(req.orgId);
  } catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
  if (!wc) {
    await Promise.all(items.map(item => recordBroadcastRecipient(req.orgId, campaignId, item, {
      status: 'failed', errorMessage: 'WhatsApp no configurado',
    })));
    return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });
  }

  const marketingPermitted = await require('../services/commercial').permitted(req.orgId, 'marketing');
  if (!marketingPermitted) {
    const results = items.map(item => ({ phone: item.phone, success: false, error: 'Contrato no disponible' }));
    await Promise.all(items.map(item => recordBroadcastRecipient(req.orgId, campaignId, item, {
      status: 'failed', errorMessage: 'Contrato no disponible',
    })));
    return res.json({ success: true, sent: 0, skipped: 0, failed: results.length, results });
  }

  const results = [];
  for (const item of items) {
    // Normalizar teléfono: con código de país, sin "+"
    item.phone = db.normalizePhone(item.phone);
    let acceptedByProvider = false;
    let acceptedMessageId = null;
    try {
      const isTemplate = !!item.templateName && !direct;
      if (direct) {
        const contact = await db.getContact(req.orgId, item.phone);
        if (contact?.opt_out) {
          await recordBroadcastRecipient(req.orgId, campaignId, item, { status: 'skipped', errorMessage: 'Contacto dado de baja' });
          results.push({ phone: item.phone, success: false, skipped: true, error: 'Contacto dado de baja' });
          continue;
        }
        if (!String(item.templateName ? item.previewText || '' : item.message || '').trim()) throw new Error('El mensaje directo está vacío');
      }

      // ── Anti-duplicado: saltar si ya recibió un template hoy ─────
      if ((isTemplate || direct) && !item.force) {
        const alreadySent = await templateSentToday(req.orgId, item.phone, direct ? sendingChannelId : null);
        if (alreadySent) {
          const result = { phone: item.phone, success: false, skipped: true, error: 'Ya recibió una campaña hoy por este canal' };
          await recordBroadcastRecipient(req.orgId, campaignId, item, {
            status: 'skipped', errorMessage: result.error,
          });
          results.push(result);
          continue;
        }
      }

      // ── No molestar: saltar si el cliente declinó en las últimas 48h ─
      if (!item.force) {
        const declined = await customerRecentlyDeclined(req.orgId, item.phone);
        if (declined) {
          const result = { phone: item.phone, success: false, skipped: true, error: 'Cliente declinó recientemente' };
          await recordBroadcastRecipient(req.orgId, campaignId, item, {
            status: 'skipped', errorMessage: result.error,
          });
          results.push(result);
          continue;
        }
      }
      let sentResult;
      let savedContent;

      if (direct) {
        const permit = await require('../services/broadcast-sender').claimDirectSlot(req.orgId, sendingChannelId, pacing, campaignId);
        if (!permit.allowed) return res.status(429).json({ rateLimited: true, retryAfterSeconds: permit.retryAfterSeconds, error: 'Pausa entre mensajes directos' });
        savedContent = String(item.templateName ? item.previewText : item.message).trim();
        sentResult = await require('../services/evolution-whatsapp').sendTextMessage(item.phone, savedContent, wc);
        if (!sentResult?.messageId && !sentResult?.key?.id) {
          const error = new Error('Evolution no confirmó el mensaje; revisa su estado antes de reenviar');
          error.code = 'ETIMEDOUT';
          throw error;
        }
      } else if (isTemplate) {
        const kapsoService = require('../services/kapso-whatsapp');
        // La interfaz ya obtuvo el template aprobado para construir components.
        // Consultarlo otra vez antes de cada envío duplicaba una llamada externa
        // lenta. Meta valida nombre, idioma y variables al aceptar el mensaje.
        const rendered = String(item.previewText || '').trim();
        sentResult = await kapsoService.sendTemplate(
          item.phone, item.templateName, item.languageCode || 'es', item.components || [], wc
        );
        console.log(`[SendBulk] Kapso response for ${item.phone} / ${item.templateName}:`, JSON.stringify(sentResult));
        savedContent = rendered
          ? `[Template: ${item.templateName}]\n\n${rendered}`
          : `[Template: ${item.templateName}]`;
      } else {
        if (wc.provider === 'twilio') {
          sentResult = await require('../services/twilio-whatsapp').sendTextMessage(item.phone, item.message, wc);
        } else if (wc.provider === 'kapso') {
          sentResult = await require('../services/kapso-whatsapp').sendTextMessage(item.phone, item.message, wc);
        } else {
          sentResult = await require('../services/whatsapp').sendTextMessage(item.phone, item.message, wc);
        }
        savedContent = item.message;
      }

      acceptedMessageId = sentResult?.messages?.[0]?.id || sentResult?.messageId || sentResult?.key?.id || null;
      acceptedByProvider = true;
      const persistAccepted = () => finalizeAcceptedBroadcast({
        orgId: req.orgId, campaignId, item: { ...item }, sentResult, savedContent,
        isTemplate, channelId: direct ? sendingChannelId : null,
      });
      if (direct) {
        const saved = await persistAccepted();
        results.push({ phone: item.phone, success: true, whatsappMessageId: acceptedMessageId,
          conversationId: saved.conversationId });
      } else {
        results.push({ phone: item.phone, success: true, whatsappMessageId: acceptedMessageId });
        setImmediate(() => persistAccepted().catch(error => {
          console.error('[SendBulk] Falló el guardado posterior:', error.message);
        }));
      }
    } catch (err) {
      if (acceptedByProvider) {
        console.error(`[SendBulk] WhatsApp aceptó ${item.phone}, pero falló el guardado local:`, err.message);
        results.push({ phone: item.phone, success: true, whatsappMessageId: acceptedMessageId, persistencePending: true, warning: 'Aceptado por WhatsApp, pero el chat no pudo guardarse. Se detuvo el lote; no reenvíes este mensaje. Abre Historial para recuperar el registro' });
        continue;
      }
      const providerTimedOut = err?.code === 'ECONNABORTED'
        || err?.code === 'ETIMEDOUT'
        || /timeout/i.test(String(err?.message || ''));
      if (providerTimedOut) {
        // Kapso puede aceptar el mensaje y demorar o perder la respuesta HTTP.
        // El webhook durable confirmará después el estado real. Marcarlo como
        // fallido induciría al administrador a reenviarlo y duplicarlo.
        const pendingResult = {
          phone: item.phone,
          success: false,
          pending: true,
          error: 'WhatsApp aún no confirmó el resultado. No reenvíes; el historial se actualizará automáticamente.',
        };
        await recordBroadcastRecipient(req.orgId, campaignId, item, {
          status: 'unknown', errorMessage: pendingResult.error,
          errorDetail: { code: err?.code || null, message: err?.message || null },
        });
        results.push(pendingResult);
        continue;
      }
      const failure = describeBroadcastError(err);
      let pausedCampaign = null;
      if (failure.code === campaignGuard.META_PAYMENT_ERROR && campaignId) {
        pausedCampaign = await campaignGuard.pauseForPaymentFailure(req.orgId, {
          campaignId,
          errors: [{ code: failure.code }],
        });
        if (pausedCampaign) {
          io?.to(`org_${req.orgId}`).emit(`broadcast_campaign_paused_${req.orgId}`, {
            campaignId: pausedCampaign.id,
            code: failure.code,
            reason: pausedCampaign.pause_reason,
            processed: pausedCampaign.processed_count,
            total: pausedCampaign.total_count,
          });
        }
      }
      await recordBroadcastRecipient(req.orgId, campaignId, item, {
        status: 'failed', errorCode: failure.code,
        errorMessage: failure.message, errorDetail: failure.detail,
      });
      results.push({
        phone: item.phone, success: false, error: failure.message, errorCode: failure.code,
        campaignPaused: failure.code === campaignGuard.META_PAYMENT_ERROR,
      });
    }

    if (items.indexOf(item) < items.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const sent    = results.filter(r => r.success).length;
  const skipped = results.filter(r => r.skipped).length;
  const pending = results.filter(r => r.pending).length;
  const failed  = results.filter(r => !r.success && !r.skipped && !r.pending).length;
  const campaignPaused = results.some(result => result.campaignPaused);
  res.json({ success: true, sent, skipped, pending, failed, campaignPaused, results });
}
router.post('/send-bulk', sendBulk);

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/calibrate
   Corre backtesting completo con historial de Shopify y guarda
   el factor de calibración en DB. Se puede llamar manualmente
   o automáticamente cuando no existe calibración previa.
───────────────────────────────────────────────────────────────────── */
router.post('/calibrate', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.status(400).json({ success: false, error: 'Sin fuente de datos configurada' });

    const { shop, token } = shopifyApi.credentialsFrom(ds);

    console.log(`[Calibration] Org ${req.orgId}: descargando historial para backtesting...`);

    // Descargar todas las órdenes (mismo flujo que /candidates)
    const sleepCal = ms => new Promise(r => setTimeout(r, ms));
    let calibOrders = [];
    let calibCursor = null;
    let calibPage   = 0;
    while (true) {
      calibPage++;
      const page = await shopifyApi.getOrders(shop, token, { limit: 250, cursor: calibCursor, status: 'any' });
      const validas = (page.orders || []).filter(o => {
        const fs = (o.financialStatus || '').toUpperCase();
        return fs !== 'VOIDED' && fs !== 'REFUNDED';
      });
      calibOrders = calibOrders.concat(validas);
      if (!page.hasNextPage || !page.endCursor || calibPage >= 50) break;
      calibCursor = page.endCursor;
      await sleepCal(300);
    }

    console.log(`[Calibration] Órdenes descargadas: ${calibOrders.length}`);

    if (calibOrders.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Historial insuficiente para calibración (necesitas al menos 20 órdenes)',
      });
    }

    // Correr backtesting
    const btResult = runBacktesting(calibOrders, normalizePhone);

    // Guardar en DB
    await db.saveCalibration(req.orgId, btResult);

    // Invalidar cache para que la próxima carga use la nueva calibración
    analysisCache.delete(req.orgId);

    console.log(`[Calibration] Org ${req.orgId}: factor=${btResult.calibrationFactor}, accuracy=${Math.round(btResult.accuracyRate*100)}%, simuladas=${btResult.totalPredictions}`);

    res.json({ success: true, data: btResult });
  } catch (err) {
    console.error('[Calibration]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/calibration
   Devuelve el estado actual de la calibración sin recalcular.
───────────────────────────────────────────────────────────────────── */
router.get('/calibration', async (req, res) => {
  try {
    const calibration = await db.getCalibration(req.orgId);
    res.json({ success: true, data: calibration });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/accuracy
   Estadísticas de accuracy de predicciones pasadas (outcomes reales).
───────────────────────────────────────────────────────────────────── */
router.get('/accuracy', async (req, res) => {
  try {
    const stats = await db.getAccuracyStats(req.orgId);
    const calibration = await db.getCalibration(req.orgId);
    res.json({ success: true, data: { outcomes: stats, calibration } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;

