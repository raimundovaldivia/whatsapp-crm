/**
 * payment-collection.js — Cobranza de pedidos pagados por transferencia
 *
 * Un pedido queda "por cobrar" cuando el repartidor lo marcó como entregado
 * con medio de pago = transferencia, y el cliente todavía no mandó el
 * comprobante (no hay payment_proof verificado ni pre-verificado).
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
  if (wc.provider === 'kapso')  return kapsoService.sendTextMessage(phone, text, wc);
  return metaService.sendTextMessage(phone, text, wc);
}

/**
 * Marca el cobro como enviado en la tabla que corresponda.
 */
async function registerChargeSent(source, orderId, orgId) {
  const pool = getPool();
  if (source === 'shopify') {
    await pool.query(
      `UPDATE shopify_orders
          SET charge_requested_at  = NOW(),
              charge_request_count = COALESCE(charge_request_count, 0) + 1
        WHERE shopify_order_id = $1 AND organization_id = $2`,
      [String(orderId), orgId]
    );
  } else {
    await pool.query(
      `UPDATE orders
          SET charge_requested_at  = NOW(),
              charge_request_count = COALESCE(charge_request_count, 0) + 1
        WHERE id = $1 AND organization_id = $2`,
      [parseInt(orderId), orgId]
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
  if (!await require('./commercial').permitted(orgId,'payments')) return { ok:false, reason:'modulo_no_contratado' };
  const { force = false, io = null, templateOverride = null } = opts;

  if (!order?.customer_phone) {
    return { ok: false, reason: 'sin_telefono' };
  }

  // Anti-duplicado: no volver a cobrar si se cobró hace poco.
  if (!force && order.charge_requested_at) {
    const hours = (Date.now() - new Date(order.charge_requested_at).getTime()) / 3600000;
    if (hours < MIN_HOURS_BETWEEN_CHARGES) {
      return { ok: false, reason: 'cobrado_recien', hoursAgo: Math.round(hours * 10) / 10 };
    }
  }

  const wc = await db.getWhatsappConfig(orgId);
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

  // Dejar el mensaje en el hilo de la conversación, para que quede trazabilidad
  // en el CRM y el bot vea el contexto.
  try {
    const conv = await db.upsertConversation(orgId, order.customer_phone, order.customer_name);
    if (conv?.id) {
      const outMsg = await db.saveMessage({
        conversationId:    conv.id,
        whatsappMessageId: sent?.messageId || sent?.messages?.[0]?.id || null,
        direction:         'outbound',
        content:           via.startsWith('template:') ? `[Template: ${settings.waTemplate}] ${text}` : text,
        sentBy:            'system',
        agentType:         'cobranza',
        status:            'sent',
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

  await registerChargeSent(order.source, order.id, orgId);
  console.log(`[Cobranza] 💸 Cobro enviado a ${order.customer_phone} — pedido ${order.order_label} (${via})`);

  return { ok: true, message: text, via };
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
 * Un comprobante cuenta como válido si está 'verified' o 'pre_verified'.
 * Los 'pending' y 'rejected' NO cuentan: el pedido sigue por cobrar.
 */
async function getPendingCharges(orgId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT 'bot'                        AS source,
            o.id::text                   AS id,
            COALESCE(NULLIF(o.customer_name, ''), c.contact_name) AS customer_name,
            COALESCE(NULLIF(o.customer_phone, ''), c.phone_number) AS customer_phone,
            o.total_price::text          AS total_price,
            CONCAT('#', o.id::text)      AS order_label,
            o.status                     AS order_status,
            o.created_at                 AS created_at,
            o.payment_marked_at          AS payment_marked_at,
            o.charge_requested_at        AS charge_requested_at,
            COALESCE(o.charge_request_count, 0) AS charge_request_count,
            (SELECT COUNT(*) FROM payment_proofs pp
              WHERE pp.order_id = o.id
                AND pp.status = 'pending')::int AS proofs_pending
       FROM orders o
       LEFT JOIN conversations c ON c.id = o.conversation_id
      WHERE o.organization_id = $1
        AND o.payment_method = 'transferencia'
        AND o.status = 'entregado'
        AND NOT EXISTS (
          SELECT 1 FROM payment_proofs pp
           WHERE pp.order_id = o.id
             AND pp.status IN ('verified', 'pre_verified')
        )

      UNION ALL

     SELECT 'shopify'                    AS source,
            s.shopify_order_id           AS id,
            s.customer_name              AS customer_name,
            s.customer_phone             AS customer_phone,
            s.total_price::text          AS total_price,
            COALESCE(NULLIF(s.shopify_name, ''), CONCAT('#', s.shopify_order_id)) AS order_label,
            s.crm_status                 AS order_status,
            s.shopify_created_at         AS created_at,
            s.payment_marked_at          AS payment_marked_at,
            s.charge_requested_at        AS charge_requested_at,
            COALESCE(s.charge_request_count, 0) AS charge_request_count,
            0                            AS proofs_pending
       FROM shopify_orders s
      WHERE s.organization_id = $1
        AND s.payment_method = 'transferencia'
        AND s.crm_status = 'entregado'
        AND s.financial_status IS DISTINCT FROM 'paid'

      ORDER BY payment_marked_at DESC NULLS LAST, created_at DESC`,
    [orgId]
  );

  return rows.map(r => ({
    ...r,
    total_price: parseFloat(r.total_price) || 0,
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
  return all.find(o => o.source === source && String(o.id) === String(orderId)) || null;
}

module.exports = {
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
