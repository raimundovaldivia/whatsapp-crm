/**
 * payment-collection.js — Cobranza de pedidos pagados por transferencia
 *
 * Un pedido queda "por cobrar" cuando el repartidor lo marcó como entregado
 * con medio de pago = transferencia, y el cliente todavía no mandó el
 * comprobante aprobado (no hay payment_proof verificado). Si existe un
 * voucher pendiente o pre-verificado, la deuda sigue visible pero se bloquea
 * un nuevo cobro hasta que el equipo lo revise.
 *
 * Este servicio arma y envía el mensaje de cobro. Lo usan dos caminos:
 *   1. Envío manual desde el tab "Por cobrar" del CRM (selección múltiple).
 *   2. Envío automático cuando el repartidor marca transferencia, si está
 *      activado el setting `auto_charge_on_transfer`.
 *
 * En ambos casos se registra charge_requested_at y charge_request_count en el
 * pedido, para no cobrarle dos veces al mismo cliente por error.
 */

const db            = require('../db/database');
const { getPool }   = require('../db/database');
const kapsoService  = require('./kapso-whatsapp');
const twilioService = require('./twilio-whatsapp');
const metaService   = require('./whatsapp');
const evolutionService = require('./evolution-whatsapp');

// Espera mínima entre dos cobros al mismo pedido (evita spam por doble click
// o por reintentos de la app del repartidor).
const MIN_HOURS_BETWEEN_CHARGES = 6;

const DEFAULT_TEMPLATE =
  'Hola {nombre} 👋 Te dejamos el detalle de tu pedido {pedido} por {total}.\n\n' +
  'Nos quedó pendiente el comprobante de la transferencia. Cuando puedas, ' +
  'mándanos la captura por acá y lo damos por pagado. ¡Gracias!';

// ─── Settings de cobranza ────────────────────────────────────────────────────

/**
 * Lee la configuración de cobranza de la org.
 * @returns {{ template: string, bankDetails: string, autoSendOnTransfer: boolean }}
 */
async function getChargeSettings(orgId) {
  let raw = null;
  try {
    raw = await db.getSetting(orgId, 'charge_settings');
  } catch { /* settings no disponible → defaults */ }

  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }

  return {
    template:           parsed.template           || DEFAULT_TEMPLATE,
    bankDetails:        parsed.bankDetails        || '',
    autoSendOnTransfer: parsed.autoSendOnTransfer === true,
    // Template de Meta para cobrar cuando el cliente lleva más de 24 h sin
    // escribir (ahí WhatsApp no deja mandar texto libre). Lo crea el CRM
    // (submitChargeTemplate) y queda PENDING hasta que Meta lo apruebe.
    // Parámetros del body, en orden: {{1}} nombre · {{2}} pedido · {{3}} total · {{4}} datos banco
    waTemplate:            (parsed.waTemplate || '').trim(),
    waTemplateStatus:      parsed.waTemplateStatus || null,      // PENDING | APPROVED | REJECTED | null
    waTemplateReason:      parsed.waTemplateReason || null,
    waTemplateSubmittedAt: parsed.waTemplateSubmittedAt || null,
  };
}

async function saveChargeSettings(orgId, { template, bankDetails, autoSendOnTransfer, waTemplate, waTemplateStatus, waTemplateReason, waTemplateSubmittedAt } = {}) {
  const current = await getChargeSettings(orgId);
  const next = {
    template:              template              ?? current.template,
    bankDetails:           bankDetails           ?? current.bankDetails,
    autoSendOnTransfer:    autoSendOnTransfer    ?? current.autoSendOnTransfer,
    waTemplate:            waTemplate            ?? current.waTemplate,
    waTemplateStatus:      waTemplateStatus      ?? current.waTemplateStatus,
    waTemplateReason:      waTemplateReason      ?? current.waTemplateReason,
    waTemplateSubmittedAt: waTemplateSubmittedAt ?? current.waTemplateSubmittedAt,
  };
  await db.setSetting(orgId, 'charge_settings', JSON.stringify(next));
  return next;
}

// ─── Template de Meta: crear y consultar ─────────────────────────────────────

const CHARGE_TEMPLATE_NAME = 'cobro_transferencia';
const CHARGE_TEMPLATE_BODY =
  'Hola {{1}}, te entregamos tu pedido {{2}} por {{3}} y quedó pendiente el comprobante de la transferencia. ' +
  'Datos: {{4}}. Cuando lo tengas, mándalo por este chat y listo. ¡Gracias!';

function kapsoCreds(wc) {
  return {
    apiKey: wc?.kapso_api_key || process.env.KAPSO_API_KEY,
    wabaId: wc?.business_account_id || process.env.KAPSO_WABA_ID,
  };
}

/**
 * Crea el template de cobranza en Meta (vía Kapso) y lo deja registrado en
 * charge_settings. Idempotente: si Meta dice que ya existe, se adopta y se
 * consulta su estado. Con { resubmit: true } primero lo borra (para reenviar
 * uno rechazado).
 *
 * @returns {{ ok, name, status, reason?, error? }}
 */
async function submitChargeTemplate(orgId, { resubmit = false } = {}) {
  await require('./commercial').assertModule(orgId,'payments');
  const wc = await db.getWhatsappConfig(orgId);
  if (!wc || wc.provider !== 'kapso') return { ok: false, error: 'La creación de templates solo está disponible con Kapso.' };
  const { apiKey, wabaId } = kapsoCreds(wc);
  if (!apiKey) return { ok: false, error: 'Falta la API Key de Kapso (Ajustes → WhatsApp).' };
  if (!wabaId) return { ok: false, error: 'Falta el WABA ID (Ajustes → WhatsApp).' };

  const axios    = require('axios');
  const settings = await getChargeSettings(orgId);
  const oneLine  = v => String(v || '').replace(/\s+/g, ' ').trim();
  const bankSample = oneLine(settings.bankDetails) || 'Banco Ejemplo, Cta. Cte. 123456789, RUT 76.123.456-7';
  const name = CHARGE_TEMPLATE_NAME;
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  const base = `https://api.kapso.ai/meta/whatsapp/v24.0/${wabaId}/message_templates`;

  if (resubmit) {
    try { await axios.delete(`${base}?name=${encodeURIComponent(name)}`, { headers }); }
    catch (e) { console.warn('[Cobranza] no se pudo borrar el template anterior:', e.response?.data ? JSON.stringify(e.response.data) : e.message); }
  }

  const payload = {
    name,
    language: 'es',
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: CHARGE_TEMPLATE_BODY,
      example: { body_text: [[ 'María', '#1042', '$40.000', bankSample.slice(0, 120) ]] },
    }],
  };

  let status = 'PENDING', reason = null;
  try {
    const { data } = await axios.post(base, payload, { headers });
    status = data?.status || 'PENDING';
    console.log(`[Cobranza] 📤 Template "${name}" enviado a Meta — status ${status}`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    if (/already exists|ya existe|duplicate/i.test(detail)) {
      console.log(`[Cobranza] Template "${name}" ya existía en Meta — se adopta`);
      const st = await fetchTemplateStatus(orgId, name).catch(() => null);
      status = st?.status || 'PENDING'; reason = st?.reason || null;
    } else {
      console.error('[Cobranza] createTemplate falló:', detail);
      return { ok: false, error: detail };
    }
  }

  await saveChargeSettings(orgId, {
    waTemplate: name, waTemplateStatus: status, waTemplateReason: reason,
    waTemplateSubmittedAt: new Date().toISOString(),
  });
  return { ok: true, name, status, reason };
}

/** Consulta en Meta el estado actual del template (cualquier estado) y lo guarda. */
async function fetchTemplateStatus(orgId, name = null) {
  const settings = await getChargeSettings(orgId);
  const tplName = name || settings.waTemplate;
  if (!tplName) return { ok: false, error: 'No hay template configurado' };
  const wc = await db.getWhatsappConfig(orgId);
  const { apiKey, wabaId } = kapsoCreds(wc);
  if (!apiKey || !wabaId) return { ok: false, error: 'Kapso no configurado' };

  const axios = require('axios');
  const { data } = await axios.get(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${wabaId}/message_templates?limit=100&name=${encodeURIComponent(tplName)}`,
    { headers: { 'X-API-Key': apiKey } }
  );
  const list = (data?.data || data || []).filter(t => t.name === tplName);
  if (!list.length) {
    await saveChargeSettings(orgId, { waTemplateStatus: 'MISSING' });
    return { ok: true, name: tplName, status: 'MISSING', reason: 'Meta no tiene un template con ese nombre' };
  }
  // Preferir español; si hay varios idiomas, el aprobado
  const t = list.find(x => String(x.language).startsWith('es') && x.status === 'APPROVED') || list.find(x => String(x.language).startsWith('es')) || list[0];
  const reason = t.rejected_reason || t.rejection_reason || t.quality_score?.reasons?.[0] || null;
  await saveChargeSettings(orgId, { waTemplateStatus: t.status || 'PENDING', waTemplateReason: reason });
  return { ok: true, name: tplName, status: t.status || 'PENDING', reason, language: t.language };
}

// ─── Armado del mensaje ──────────────────────────────────────────────────────

function formatCLP(value) {
  const n = Math.round(parseFloat(value) || 0);
  return `$${n.toLocaleString('es-CL')}`;
}

function firstName(name) {
  const clean = (name || '').trim();
  if (!clean || /^\d+$/.test(clean)) return '';
  const first = clean.split(/\s+/)[0];
  // Estandarizar: primera letra mayuscula, resto minuscula (GEORGA -> Georga)
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Reemplaza los placeholders del template con los datos del pedido.
 * Placeholders soportados: {nombre} {pedido} {total} {datos_banco}
 */
function buildChargeMessage(order, settings) {
  const name = firstName(order.customer_name);
  let msg = settings.template
    .replace(/\{nombre\}/g,       name || 'Hola')
    .replace(/\{pedido\}/g,       order.order_label || `#${order.id}`)
    .replace(/\{total\}/g,        formatCLP(order.total_price))
    .replace(/\{datos_banco\}/g,  settings.bankDetails || '');

  // Si el template no usa {datos_banco} pero hay datos configurados, anexarlos.
  if (settings.bankDetails && !/\{datos_banco\}/.test(settings.template)) {
    msg += `\n\n${settings.bankDetails}`;
  }

  // Si el nombre venía vacío, "Hola Hola" queda feo.
  return msg.replace(/^Hola Hola\b/, 'Hola').trim();
}

// ─── Envío ───────────────────────────────────────────────────────────────────

async function sendByProvider(phone, text, wc) {
  if (wc.provider === 'twilio') return twilioService.sendTextMessage(phone, text, wc);
  if (wc.provider === 'kapso') return kapsoService.sendTextMessage(phone, text, wc);
  if (wc.provider === 'evolution') return evolutionService.sendTextMessage(phone, text, wc);
  return metaService.sendTextMessage(phone, text, wc);
}

/**
 * Marca el cobro como enviado en la tabla que corresponda.
 */
async function registerChargeSent(source, orderId, orgId, messageId) {
  const pool = getPool();
  if (source === 'shopify') {
    await pool.query(
      `UPDATE shopify_orders
          SET charge_requested_at  = NOW(),
              charge_message_id = $3,
              charge_request_count = COALESCE(charge_request_count, 0) + 1
        WHERE shopify_order_id = $1 AND organization_id = $2`,
      [String(orderId), orgId, messageId]
    );
  } else {
    await pool.query(
      `UPDATE orders
          SET charge_requested_at  = NOW(),
              charge_message_id = $3,
              charge_request_count = COALESCE(charge_request_count, 0) + 1
        WHERE id = $1 AND organization_id = $2`,
      [parseInt(orderId), orgId, messageId]
    );
  }
}

/**
 * Envía el cobro de UN pedido.
 *
 * @param {number} orgId
 * @param {object} order  - fila de pending-charge: { source, id, customer_name, customer_phone, total_price, order_label, charge_requested_at }
 * @param {object} [opts] - { force: ignora la espera mínima entre cobros, io: socket.io }
 * @returns {{ ok: boolean, reason?: string, message?: string }}
 */
async function sendChargeRequest(orgId, order, opts = {}) {
  if (!order || !['bot','shopify'].includes(order.source)) return { ok: false, reason: 'pedido_invalido' };
  const client = await getPool().connect();
  const lockKey = `charge:${orgId}:${order.source}:${order.id}`;
  let locked = false;
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lockKey]);
    locked = !!lock.locked;
    if (!locked) return { ok: false, reason: 'envio_en_curso' };
    const current = await getOrderForCharge(orgId, order.source, order.id);
    if (!current) return { ok: false, reason: 'no_por_cobrar' };
    return await sendChargeRequestLocked(orgId, current, opts);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
    client.release();
  }
}

async function sendChargeRequestLocked(orgId, order, opts = {}) {
  if (!await require('./commercial').permitted(orgId,'payments')) return { ok:false, reason:'modulo_no_contratado' };
  const { force = false, io = null, templateOverride = null } = opts;

  if (!order?.customer_phone) {
    return { ok: false, reason: 'sin_telefono' };
  }

  // Do not resend unconfirmed attempts. A confirmed failure may retry immediately.
  if (order.charge_status === 'pending' || order.charge_status === 'sent') return { ok: false, reason: 'envio_pendiente', error: 'El envío anterior espera confirmación. No se duplicó.' };
  if (order.charge_requested_at && !order.charge_status) return { ok: false, reason: 'envio_sin_verificar', error: 'El cobro anterior no tiene confirmación verificable. Revisa su historial antes de reenviar.' };
  // Anti-duplicado: no volver a cobrar si se cobró hace poco.
  if (!force && order.charge_status !== 'failed' && order.charge_requested_at) {
    const hours = (Date.now() - new Date(order.charge_requested_at).getTime()) / 3600000;
    if (hours < MIN_HOURS_BETWEEN_CHARGES) {
      return { ok: false, reason: 'cobrado_recien', hoursAgo: Math.round(hours * 10) / 10 };
    }
  }

  let conversation = null;
  let wc = null;
  if (db.getDefaultWhatsappChannel) {
    ({ rows: [conversation] } = await getPool().query(
      `SELECT * FROM conversations WHERE organization_id=$1
        AND regexp_replace(phone_number, '[^0-9]', '', 'g')=regexp_replace($2, '[^0-9]', '', 'g')
        ORDER BY last_message_at DESC LIMIT 1`,
      [orgId, order.customer_phone]
    ));
    if (conversation?.whatsapp_channel_id) wc = await db.getWhatsappChannel(orgId, conversation.whatsapp_channel_id);
    if (!wc && conversation) wc = await db.getWhatsappConfig(orgId);
    if (!wc) wc = await db.getDefaultWhatsappChannel(orgId);
  }
  if (!wc) wc = await db.getWhatsappConfig(orgId);
  if (!wc) return { ok: false, reason: 'whatsapp_no_configurado' };

  const settings = await getChargeSettings(orgId);
  // Template puntual elegido en Despachos para este envío (sobrescribe el de Ajustes).
  if (templateOverride) { settings.waTemplate = templateOverride; settings.waTemplateStatus = 'APPROVED'; }
  const text     = buildChargeMessage(order, settings);

  let sent = null;
  let via  = 'texto';
  try {
    sent = await sendByProvider(order.customer_phone, text, wc);
  } catch (err) {
    if (!err.is24hWindow) return { ok: false, reason: 'error_envio', error: err.message };

    // Fuera de la ventana de 24h solo se pueden mandar templates aprobados.
    // Si la org configuró uno, se usa; si no, queda en "Por cobrar" para reintentar.
    if (!settings.waTemplate || wc.provider !== 'kapso' || ['REJECTED', 'MISSING'].includes(settings.waTemplateStatus)) {
      return { ok: false, reason: 'ventana_24h', message: text };
    }
    try {
      sent = await sendChargeTemplate(order, settings, wc);
      via  = `template:${settings.waTemplate}`;
    } catch (tplErr) {
      const detail = tplErr.response?.data?.error?.message || tplErr.message;
      console.error(`[Cobranza] Template "${settings.waTemplate}" falló:`, detail);
      return { ok: false, reason: 'template_fallo', error: detail, message: text };
    }
  }

  const messageId = sent?.messageId || sent?.messages?.[0]?.id || sent?.sid;
  if (!messageId) return { ok: false, reason: 'sin_confirmacion', error: 'El proveedor no confirmó la aceptación del mensaje.' };

  // Dejar el mensaje en el hilo de la conversación, para que quede trazabilidad
  // en el CRM y el bot vea el contexto.
  try {
    const conv = await db.upsertConversation(
      orgId, order.customer_phone, order.customer_name,
      wc.provider === 'evolution' ? wc.id : null
    );
    if (conv?.id) {
      const outMsg = await db.saveMessage({
        conversationId:    conv.id,
        whatsappMessageId: messageId,
        direction:         'outbound',
        content:           via.startsWith('template:') ? `[Template: ${settings.waTemplate}] ${text}` : text,
        sentBy:            'system',
        agentType:         'cobranza',
        status:            'pending',
      });
      await db.updateConversationLastMessage(conv.id, text);
      if (io && outMsg) {
        const finalConv = await db.getConversationById(conv.id);
        io.to(`org_${orgId}`).emit(`new_message_${orgId}`, { message: outMsg, conversation: finalConv });
      }
    }
  } catch (err) {
    console.error('[Cobranza] Mensaje enviado pero no se pudo guardar en el hilo:', err.message);
  }

  await registerChargeSent(order.source, order.id, orgId, messageId);
  console.log(`[Cobranza] 💸 Cobro enviado a ${order.customer_phone} — pedido ${order.order_label} (${via})`);

  return { ok: true, status: 'pending', message: text, via };
}

/**
 * Envía el cobro como template aprobado (cliente fuera de la ventana de 24 h).
 * Prueba con 4 parámetros (nombre, pedido, total, datos banco) y, si Meta
 * responde que el template tiene menos (código 132000), reintenta con 3 y
 * luego con 1, igual que el template de despacho.
 */
async function sendChargeTemplate(order, settings, wc) {
  const kapso = require('./kapso-whatsapp');
  // Los parámetros de template no admiten saltos de línea ni tabs.
  const oneLine = v => String(v || '').replace(/\s+/g, ' ').trim();
  const params = [
    oneLine(firstName(order.customer_name) || 'Hola'),
    oneLine(order.order_label || `#${order.id}`),
    oneLine(formatCLP(order.total_price)),
    oneLine(settings.bankDetails || '-'),
  ];
  const attempt = n => kapso.sendTemplate(order.customer_phone, settings.waTemplate, 'es', [{
    type: 'body',
    parameters: params.slice(0, n).map(text => ({ type: 'text', text })),
  }], wc);

  for (const n of [4, 3, 1]) {
    try { return await attempt(n); }
    catch (err) {
      if (err.response?.data?.error?.code === 132000 && n > 1) continue;
      throw err;
    }
  }
}

// ─── Consulta: pedidos por cobrar ────────────────────────────────────────────

/**
 * Pedidos entregados, marcados como transferencia, sin comprobante válido.
 *
 * Une pedidos del bot (orders) y de Shopify (shopify_orders) en una sola lista.
 * Solo un comprobante 'verified' cierra la deuda. Los 'pending' y
 * 'pre_verified' siguen por cobrar, pero se exponen para que el equipo revise
 * el voucher en vez de volver a enviarle un cobro al cliente.
 */
async function getPendingCharges(orgId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT 'bot'                        AS source,
            o.id::text                   AS id,
            COALESCE(NULLIF(o.customer_name, ''), c.contact_name) AS customer_name,
            COALESCE(NULLIF(o.customer_phone, ''), c.phone_number) AS customer_phone,
            c.id::text                    AS conversation_id,
            COALESCE(customer_contact.client_type, 'personal') AS client_type,
            CASE WHEN COALESCE(customer_contact.client_type, 'personal') = 'empresa'
                 THEN 'factura' ELSE 'boleta' END AS tax_document_type,
            'not_issued'                  AS tax_document_status,
            o.total_price::text          AS total_price,
            CONCAT('#', o.id::text)      AS order_label,
            o.status                     AS order_status,
            o.created_at                 AS created_at,
            o.delivered_at               AS delivered_at,
            o.items::text                AS items,
            o.payment_marked_at          AS payment_marked_at,
            o.charge_requested_at        AS charge_requested_at,
            o.charge_message_id AS charge_message_id,
            (SELECT m.status FROM messages m JOIN conversations mc ON mc.id=m.conversation_id WHERE m.whatsapp_message_id=o.charge_message_id AND mc.organization_id=o.organization_id) AS charge_status,
            COALESCE(o.charge_request_count, 0) AS charge_request_count,
            (SELECT pp.id FROM payment_proofs pp
              WHERE pp.organization_id = o.organization_id
                AND pp.order_id = o.id AND pp.status IN ('pending', 'pre_verified')
              ORDER BY pp.created_at DESC LIMIT 1) AS proof_id,
            (SELECT pp.status FROM payment_proofs pp
              WHERE pp.organization_id = o.organization_id
                AND pp.order_id = o.id AND pp.status IN ('pending', 'pre_verified')
              ORDER BY pp.created_at DESC LIMIT 1) AS proof_status,
            (SELECT COUNT(*) FROM payment_proofs pp
              WHERE pp.organization_id = o.organization_id
                AND pp.order_id = o.id
                AND pp.status IN ('pending', 'pre_verified'))::int AS proofs_pending,
            (SELECT COUNT(*) FROM payment_proofs pp
              WHERE pp.organization_id = o.organization_id
                AND pp.order_id = o.id
                AND pp.status = 'pre_verified')::int AS proofs_pre_verified
            ,(SELECT COUNT(*) FROM payment_proofs pp
              WHERE pp.organization_id = o.organization_id
                AND pp.order_id = o.id
                AND pp.status = 'rejected')::int AS proofs_rejected
       FROM orders o
       LEFT JOIN conversations c ON c.id = o.conversation_id
       LEFT JOIN LATERAL (
         SELECT co.client_type
           FROM contacts co
          WHERE co.organization_id = o.organization_id
            AND regexp_replace(co.phone, '[^0-9]', '', 'g') = regexp_replace(COALESCE(NULLIF(o.customer_phone, ''), c.phone_number, ''), '[^0-9]', '', 'g')
          ORDER BY co.updated_at DESC NULLS LAST
          LIMIT 1
       ) customer_contact ON TRUE
      WHERE o.organization_id = $1
        AND o.payment_method = 'transferencia'
        AND o.status = 'entregado'
        AND COALESCE(NULLIF(o.total_price::text, ''), '0')::numeric > 0
        AND NOT EXISTS (
          SELECT 1 FROM payment_proofs pp
           WHERE pp.organization_id = o.organization_id
             AND pp.order_id = o.id
             AND pp.status = 'verified'
        )

      UNION ALL

     SELECT 'shopify'                    AS source,
            s.shopify_order_id           AS id,
            s.customer_name              AS customer_name,
            s.customer_phone             AS customer_phone,
            (SELECT c.id::text FROM conversations c
              WHERE c.organization_id = s.organization_id
                AND regexp_replace(c.phone_number, '[^0-9]', '', 'g') = regexp_replace(COALESCE(s.customer_phone, ''), '[^0-9]', '', 'g')
              ORDER BY c.updated_at DESC NULLS LAST, c.id DESC LIMIT 1) AS conversation_id,
            COALESCE(customer_contact.client_type, 'personal') AS client_type,
            CASE WHEN COALESCE(customer_contact.client_type, 'personal') = 'empresa'
                 THEN 'factura' ELSE 'boleta' END AS tax_document_type,
            'not_issued'                  AS tax_document_status,
            s.total_price::text          AS total_price,
            COALESCE(NULLIF(s.shopify_name, ''), CONCAT('#', s.shopify_order_id)) AS order_label,
            s.crm_status                 AS order_status,
            s.shopify_created_at         AS created_at,
            s.delivered_at               AS delivered_at,
            s.items::text                AS items,
            s.payment_marked_at          AS payment_marked_at,
            s.charge_requested_at        AS charge_requested_at,
            s.charge_message_id AS charge_message_id,
            (SELECT m.status FROM messages m JOIN conversations mc ON mc.id=m.conversation_id WHERE m.whatsapp_message_id=s.charge_message_id AND mc.organization_id=s.organization_id) AS charge_status,
            COALESCE(s.charge_request_count, 0) AS charge_request_count,
            NULL::int                       AS proof_id,
            NULL::text                      AS proof_status,
            0                            AS proofs_pending,
            0                            AS proofs_pre_verified,
            0                            AS proofs_rejected
       FROM shopify_orders s
       LEFT JOIN LATERAL (
         SELECT co.client_type
           FROM contacts co
          WHERE co.organization_id = s.organization_id
            AND regexp_replace(co.phone, '[^0-9]', '', 'g') = regexp_replace(COALESCE(s.customer_phone, ''), '[^0-9]', '', 'g')
          ORDER BY co.updated_at DESC NULLS LAST
          LIMIT 1
       ) customer_contact ON TRUE
      WHERE s.organization_id = $1
        AND s.payment_method = 'transferencia'
        AND s.crm_status = 'entregado'
        AND s.financial_status IS DISTINCT FROM 'paid'
        AND COALESCE(NULLIF(s.total_price::text, ''), '0')::numeric > 0

      ORDER BY payment_marked_at DESC NULLS LAST, created_at DESC`,
    [orgId]
  );

  return rows.map(r => ({
    ...r,
    total_price: parseFloat(r.total_price) || 0,
    items: (() => {
      if (Array.isArray(r.items)) return r.items;
      try { return JSON.parse(r.items || '[]'); } catch { return []; }
    })(),
    // Horas desde que se marcó la entrega — para ordenar por antigüedad de la deuda
    hours_owed: r.payment_marked_at
      ? Math.round((Date.now() - new Date(r.payment_marked_at).getTime()) / 3600000)
      : null,
  }));
}

/**
 * Busca un pedido puntual con la misma forma que getPendingCharges, para poder
 * cobrarlo desde el hook automático del repartidor.
 */
async function getOrderForCharge(orgId, source, orderId) {
  const all = await getPendingCharges(orgId);
  return all.find(o => o.source === source && String(o.id) === String(orderId)
    && !['pending', 'pre_verified'].includes(o.proof_status)) || null;
}

// Read-only provider reconciliation: never sends a message.
async function reconcileCharges(orgId, selection, io) {
  const wc = await db.getWhatsappConfig(orgId);
  if (!await require('./commercial').permitted(orgId, 'payments')) throw new Error('Módulo de cobranza no habilitado');
  if (wc?.provider !== 'kapso') throw new Error('Esta verificación requiere una conexión Kapso');
  const pending = await getPendingCharges(orgId);
  const { rows: candidates } = await getPool().query(`      WITH attempts AS (
        SELECT 'bot' AS source, id::text AS id, organization_id, customer_phone, charge_requested_at FROM orders WHERE organization_id=$1 AND charge_message_id IS NULL AND charge_requested_at IS NOT NULL
        UNION ALL
        SELECT 'shopify', shopify_order_id, organization_id, customer_phone, charge_requested_at FROM shopify_orders WHERE organization_id=$1 AND charge_message_id IS NULL AND charge_requested_at IS NOT NULL
      ), candidates AS (
        SELECT a.source, a.id, a.organization_id, a.charge_requested_at::text AS attempt_at, m.whatsapp_message_id,
          COUNT(*) OVER (PARTITION BY a.source, a.id, a.organization_id) AS order_matches,
          COUNT(*) OVER (PARTITION BY m.id) AS message_matches
        FROM attempts a JOIN conversations c ON c.organization_id=a.organization_id
          AND regexp_replace(c.phone_number, '[^0-9]', '', 'g')=regexp_replace(a.customer_phone, '[^0-9]', '', 'g')
        JOIN messages m ON m.conversation_id=c.id AND m.agent_type='cobranza' AND m.direction='outbound'
           AND m.whatsapp_message_id IS NOT NULL
          AND m.created_at BETWEEN a.charge_requested_at - INTERVAL '30 seconds' AND a.charge_requested_at
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.charge_message_id=m.whatsapp_message_id)
          AND NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.charge_message_id=m.whatsapp_message_id)
      ) SELECT * FROM candidates WHERE order_matches=1 AND message_matches=1 AND organization_id=$1`, [orgId]);
  const results = [];
  for (const sel of selection) {
    const order = pending.find(o => o.source === sel.source && String(o.id) === String(sel.id));
    if (!order) { results.push({ ...sel, status: 'unknown' }); continue; }
    const candidate = candidates.find(c => c.source === order.source && String(c.id) === String(order.id));
    const messageId = order.charge_message_id || candidate?.whatsapp_message_id;
    if (!messageId) { results.push({ ...sel, status: 'unknown' }); continue; }
    try {
      const receipt = await kapsoService.getMessageStatus(messageId, wc);
      if (!receipt) { results.push({ ...sel, status: 'unknown' }); continue; }
      const message = await db.updateMessageStatus(messageId, receipt.status, receipt.error, orgId);
      // Link only the attempt we just checked; do not overwrite a concurrent retry.
      if (!order.charge_message_id) {
        const table = order.source === 'bot' ? 'orders' : 'shopify_orders';
        const idCol = order.source === 'bot' ? 'id' : 'shopify_order_id';
        await getPool().query(`UPDATE ${table} SET charge_message_id=$1 WHERE organization_id=$2 AND ${idCol}=$3 AND charge_message_id IS NULL AND charge_requested_at=$4`, [messageId,orgId,order.id,candidate.attempt_at]);
      }
      if (message) io?.to(`org_${orgId}`).emit(`status_update_${orgId}`, { ...receipt, error: message.delivery_error });
      results.push({ ...sel, status: message?.status || receipt.status });
    } catch (err) {
      results.push({ ...sel, status: 'unknown', error: 'No se pudo verificar con Kapso. No se reenvió.' });
      if ([401,403,429].includes(err.response?.status)) break;
    }
  }
  return results;
}

module.exports = {
  reconcileCharges,
  submitChargeTemplate,
  fetchTemplateStatus,
  CHARGE_TEMPLATE_NAME,
  CHARGE_TEMPLATE_BODY,
  getChargeSettings,
  saveChargeSettings,
  buildChargeMessage,
  sendChargeRequest,
  getPendingCharges,
  getOrderForCharge,
  MIN_HOURS_BETWEEN_CHARGES,
  DEFAULT_TEMPLATE,
};
