/**
 * admin-notify.js — Entrega confiable de alertas al admin
 *
 * PROBLEMA QUE RESUELVE
 * Las alertas al admin ("un cliente necesita respuesta", "llegó un pago") salen
 * como texto libre de WhatsApp. Meta no permite texto libre a un número que no
 * escribió al negocio en las últimas 24h. Si el admin pasa un día sin escribirle
 * al número, TODAS sus alertas fallan en silencio y nunca se entera.
 *
 * SOLUCIÓN — tres piezas:
 *  1. notifyAdmin(): intenta enviar; si la ventana está cerrada, guarda el
 *     mensaje en la cola (admin_outbox) en vez de perderlo.
 *  2. markAdminWindowOpen(): cuando el admin escribe al número, su ventana de
 *     24h se reabre → se drena la cola (se le mandan los pendientes).
 *  3. sweepAdminWindowWarnings(): cron que le avisa ANTES de que la ventana se
 *     cierre ("escribe algo para seguir recibiendo alertas"), mientras todavía
 *     se puede entregar texto libre.
 *
 * La ventana del admin se mide desde su último mensaje entrante al número,
 * guardado en el setting 'admin_window_last_inbound'.
 */

const db           = require('../db/database');
const { getPool }  = require('../db/database');
const kapsoService = require('./kapso-whatsapp');
const delivery = require('./admin-delivery');

const WINDOW_MS          = 24 * 60 * 60 * 1000;      // ventana de 24h de WhatsApp
const WARN_BEFORE_MS     = 2  * 60 * 60 * 1000;      // avisar cuando quedan ≤ 2h
const OUTBOX_EXPIRY_MS   = 48 * 60 * 60 * 1000;      // una consulta de hace >48h ya no se reenvía
const MAX_DRAIN          = 10;                       // tope de mensajes al drenar (evita avalancha)

// ─── Helpers de ventana ───────────────────────────────────────────────────────

function windowState(lastInboundIso) {
  if (!lastInboundIso) return { open: false, msLeft: 0 };
  const elapsed = Date.now() - new Date(lastInboundIso).getTime();
  return { open: elapsed < WINDOW_MS, msLeft: WINDOW_MS - elapsed };
}

async function isWindowOpen(orgId) {
  const last = await db.getSetting(orgId, 'admin_window_last_inbound').catch(() => null);
  return windowState(last).open;
}

async function recipientSuspended(orgId, phone) {
  const { rows } = await getPool().query(`SELECT id FROM users WHERE organization_id=$1 AND active=FALSE
    AND regexp_replace(whatsapp_phone,'[^0-9]','','g')=$2 LIMIT 1`, [orgId,db.normalizePhone(phone)]);
  return rows.length > 0;
}

// ─── Envío principal ───────────────────────────────────────────────────────────

/**
 * Envía una alerta al admin, con respaldo en cola si la ventana está cerrada.
 *
 * @param {number} orgId
 * @param {object} opts
 *   - body:            texto del mensaje (obligatorio)
 *   - kind:            'help' | 'handoff' | 'payment' | ...  (default 'help')
 *   - conversationId:  para deduplicar en la cola (opcional)
 *   - wc:              config WhatsApp ya cargada (opcional, se busca si falta)
 * @returns {Promise<{sent:boolean, queued:boolean, reason?:string}>}
 */
async function notifyAdmin(orgId, { body, kind = 'help', conversationId = null, wc = null, recipientPhone = null } = {}) {
  if (!body) return { sent: false, queued: false, reason: 'sin_cuerpo' };

  // Push a la app Central (independiente de la ventana de 24h de WhatsApp).
  // Best-effort: nunca bloquea ni rompe la alerta por WhatsApp.
  try {
    const title = { payment: '💸 Pago', order: '📦 Pedido', handoff: '👤 Atención', help: '🆘 Necesita ayuda' }[kind] || '🔔 Aviso';
    require('./push').pushAdmins(orgId, { title, body: body.replace(/\*/g, ''), data: { kind, conversationId } }).catch(() => {});
  } catch (_) {}

  const adminPhone = recipientPhone || await db.getSetting(orgId, 'admin_alert_phone').catch(() => null);
  if (adminPhone && await recipientSuspended(orgId, adminPhone)) {
    await delivery.blocked(orgId, { conversationId, kind, phone: adminPhone, reason: 'usuario_suspendido' });
    return { sent: false, queued: false, reason: 'usuario_suspendido' };
  }
  if (!adminPhone) {
    await delivery.blocked(orgId, { conversationId, kind, reason: 'sin_admin_phone' });
    return { sent: false, queued: false, reason: 'sin_admin_phone' };
  }

  const cfg = wc || await db.getWhatsappConfig(orgId).catch(() => null);
  if (!cfg || cfg.provider !== 'kapso') {
    await delivery.blocked(orgId, { conversationId, kind, phone: adminPhone, reason: 'sin_kapso' });
    return { sent: false, queued: false, reason: 'sin_kapso' };
  }

  try {
    await delivery.send(orgId, { phone: adminPhone, body, config: cfg, kind, conversationId });
    console.log(`[AdminNotify] Aviso aceptado para envío al admin (entrega aún no confirmada) (${kind})`);
    return { sent: true, queued: false };
  } catch (err) {
    if (err.is24hWindow) {
      await queueMessage(orgId, adminPhone, body, kind, conversationId);
      console.warn(`[AdminNotify] 📥 Ventana del admin cerrada — alerta encolada (${kind}). Se enviará cuando el admin escriba al número.`);
      return { sent: false, queued: true, reason: 'ventana_cerrada' };
    }
    console.error('[AdminNotify] Error enviando alerta al admin:', err.message);
    return { sent: false, queued: false, reason: 'error_envio' };
  }
}

// ─── Cola ──────────────────────────────────────────────────────────────────────

async function queueMessage(orgId, adminPhone, body, kind, conversationId) {
  const pool = getPool();
  // Dedup: si ya hay un pendiente de la MISMA conversación y tipo, reemplazar su
  // cuerpo por el más reciente en vez de acumular. Una conversación que sigue
  // esperando no debe llenar la cola con cada mensaje del cliente.
  if (conversationId) {
    const { rowCount } = await pool.query(
      `UPDATE admin_outbox
          SET body = $1, created_at = NOW()
        WHERE organization_id = $2 AND conversation_id = $3 AND kind = $4 AND status = 'pending' AND admin_phone=$5`,
      [body, orgId, conversationId, kind, adminPhone]
    );
    if (rowCount > 0) return;
  }
  await pool.query(
    `INSERT INTO admin_outbox (organization_id, admin_phone, body, kind, conversation_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, adminPhone, body, kind, conversationId]
  );
}

/**
 * Marca que el admin escribió al número (reabre su ventana de 24h) y drena la
 * cola de alertas pendientes. Se llama desde el webhook cuando el mensaje viene
 * del teléfono del admin.
 *
 * @param {number} orgId
 * @param {object} wc - config WhatsApp (opcional)
 */
async function markAdminWindowOpen(orgId, wc = null) {
  await db.setSetting(orgId, 'admin_window_last_inbound', new Date().toISOString()).catch(() => {});
  await db.setSetting(orgId, 'admin_window_warning_sent', '').catch(() => {});
  return drainAdminOutbox(orgId, wc);
}

/**
 * Envía las alertas encoladas. Deduplica por conversación (se queda con la más
 * reciente), descarta las muy viejas y encabeza con un resumen de qué había
 * quedado pendiente. Si algún envío vuelve a fallar por ventana, lo deja en cola.
 */
async function drainAdminOutbox(orgId, wc = null, recipientPhone = null) {
  const recipient = recipientPhone || await db.getSetting(orgId, 'admin_alert_phone');
  if (!recipient) return { drained: 0 };
  if (await recipientSuspended(orgId, recipient)) return { drained: 0, reason: 'usuario_suspendido' };
  const pool = getPool();

  // Expirar lo demasiado viejo (una consulta de hace 2 días ya no sirve)
  await pool.query(
    `UPDATE admin_outbox SET status = 'expired'
      WHERE organization_id = $1 AND status = 'pending'
        AND created_at < NOW() - INTERVAL '${Math.round(OUTBOX_EXPIRY_MS / 1000)} seconds'`,
    [orgId]
  );

  const { rows } = await pool.query(
    `SELECT id, admin_phone, body, kind, conversation_id
       FROM admin_outbox
      WHERE organization_id = $1 AND status = 'pending'
        AND regexp_replace(admin_phone,'[^0-9]','','g')=$2
      ORDER BY created_at ASC LIMIT 10`,
    [orgId, db.normalizePhone(recipient)]
  );
  if (rows.length === 0) return { drained: 0 };

  const cfg = wc || await db.getWhatsappConfig(orgId).catch(() => null);
  if (!cfg || cfg.provider !== 'kapso') return { drained: 0, reason: 'sin_kapso' };

  const adminPhone = rows[0].admin_phone;
  const batch = rows.slice(0, MAX_DRAIN);

  // Encabezado de contexto: el admin va a recibir varias alertas de golpe
  if (batch.length > 1) {
    await kapsoService.sendTextMessage(
      adminPhone,
      `📥 Tenías ${batch.length} aviso(s) esperando mientras no podía escribirte. Te los paso ahora:`,
      cfg
    ).catch(() => {});
  }

  let drained = 0;
  for (const row of batch) {
    try {
      await delivery.send(orgId, { phone: row.admin_phone, body: row.body, config: cfg, kind: row.kind, conversationId: row.conversation_id });
      await pool.query(`UPDATE admin_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1`, [row.id]);
      drained++;
    } catch (err) {
      if (err.is24hWindow) {
        // La ventana se cerró de nuevo (raro justo ahora): dejar el resto en cola
        console.warn('[AdminNotify] Ventana se cerró durante el drenado — se reintenta luego');
        break;
      }
      console.error('[AdminNotify] Error drenando alerta:', err.message);
    }
  }

  if (drained > 0) console.log(`[AdminNotify] 📤 ${drained} alerta(s) pendientes entregadas al admin`);
  return { drained };
}

// ─── Aviso preventivo (cron) ────────────────────────────────────────────────────

/** Texto del aviso de cierre de ventana. */
function windowWarnMessage(msLeft, pendingCount = 0) {
  const mins   = Math.max(1, Math.round(msLeft / 60000));
  const tiempo = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  const extra  = pendingCount > 0
    ? `\n\nHay ${pendingCount} aviso(s) en espera que te llegarán apenas escribas.`
    : '';
  return (
    `⏰ *Tu canal de alertas se cierra en ~${tiempo}.*\n\n` +
    `WhatsApp deja de dejarme escribirte si pasan 24h sin que me escribas. ` +
    `Mandame cualquier mensaje (una palabra basta) para seguir recibiendo los avisos de clientes.${extra}`
  );
}

/**
 * Aviso al número admin (admin_alert_phone). Su ventana se mide por org en el
 * setting admin_window_last_inbound.
 */
async function warnAdminPhone(orgId, wc, adminPhone) {
  if (!adminPhone) return;
  if (await recipientSuspended(orgId, adminPhone)) return;
  const pool = getPool();
  const lastInbound = await db.getSetting(orgId, 'admin_window_last_inbound').catch(() => null);
  const { open, msLeft } = windowState(lastInbound);
  if (!open || msLeft > WARN_BEFORE_MS) return;   // cerrada o con tiempo de sobra

  const warnedFor = await db.getSetting(orgId, 'admin_window_warning_sent').catch(() => null);
  if (warnedFor && warnedFor === lastInbound) return;  // ya avisado en esta ventana

  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM admin_outbox WHERE organization_id = $1 AND status = 'pending'`,
    [orgId]
  );
  await kapsoService.sendTextMessage(adminPhone, windowWarnMessage(msLeft, n), wc);
  await db.setSetting(orgId, 'admin_window_warning_sent', lastInbound);
  console.log(`[AdminNotify] ⏰ Aviso preventivo enviado al admin (org ${orgId})`);
}

/**
 * Aviso a cada miembro del equipo con notificaciones activadas — cada uno con su
 * propia ventana (users.wa_last_inbound). Se salta al que coincide con el
 * admin_alert_phone (ya avisado en warnAdminPhone) para no duplicar.
 */
async function warnUserWindows(orgId, wc, adminPhone) {
  const pool = getPool();
  const { rows: users } = await pool.query(
    `SELECT id, name, whatsapp_phone, wa_last_inbound, wa_window_warned
       FROM users
      WHERE organization_id = $1
        AND active=TRUE AND whatsapp_phone IS NOT NULL AND whatsapp_phone <> ''
        AND (wa_notifications->>'new_messages')::boolean = true`,
    [orgId]
  );
  const adminDigits = (adminPhone || '').replace(/[^0-9]/g, '');

  for (const u of users) {
    try {
      if (adminDigits && u.whatsapp_phone.replace(/[^0-9]/g, '') === adminDigits) continue;
      if (!u.wa_last_inbound) continue;   // nunca escribió: no hay ventana abierta que avisar
      const { open, msLeft } = windowState(u.wa_last_inbound);
      if (!open || msLeft > WARN_BEFORE_MS) continue;
      // no repetir dentro de la misma ventana
      if (u.wa_window_warned && new Date(u.wa_window_warned) >= new Date(u.wa_last_inbound)) continue;

      await kapsoService.sendTextMessage(u.whatsapp_phone, windowWarnMessage(msLeft), wc);
      await pool.query(`UPDATE users SET wa_window_warned = NOW() WHERE id = $1`, [u.id]);
      console.log(`[AdminNotify] ⏰ Aviso preventivo enviado a ${u.name || u.whatsapp_phone} (org ${orgId})`);
    } catch (err) {
      console.warn(`[AdminNotify] aviso a usuario ${u.id}:`, err.message);
    }
  }
}

/**
 * Revisa todas las orgs y avisa —al número admin y a cada miembro del equipo con
 * notificaciones— cuando su ventana de 24h está por cerrarse, para que escriban
 * algo y no dejen de recibir alertas. Solo se avisa con la ventana abierta y
 * quedando ≤ WARN_BEFORE_MS (una ventana cerrada no recibiría el aviso).
 */
async function sweepAdminWindowWarnings() {
  const pool = getPool();
  let orgs;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT organization_id FROM (
        SELECT organization_id FROM settings WHERE key = 'admin_alert_phone' AND value <> ''
        UNION
        SELECT organization_id FROM users
          WHERE whatsapp_phone IS NOT NULL AND whatsapp_phone <> ''
            AND (wa_notifications->>'new_messages')::boolean = true
      ) t`
    );
    orgs = rows.map(r => r.organization_id);
  } catch (err) {
    console.error('[AdminNotify] sweep: error listando orgs:', err.message);
    return;
  }

  for (const orgId of orgs) {
    try {
      const wc = await db.getWhatsappConfig(orgId).catch(() => null);
      if (!wc || wc.provider !== 'kapso') continue;
      const adminPhone = await db.getSetting(orgId, 'admin_alert_phone').catch(() => null);
      await warnAdminPhone(orgId, wc, adminPhone);
      await warnUserWindows(orgId, wc, adminPhone);
    } catch (err) {
      console.warn(`[AdminNotify] sweep org ${orgId}:`, err.message);
    }
  }
}

/** Arranca el cron del aviso preventivo. Corre cada 20 min. */
function startAdminWindowJob() {
  console.log('[AdminNotify] 🚀 Job de ventana del admin iniciado (revisa cada 20 min)');
  setTimeout(sweepAdminWindowWarnings, 60 * 1000);          // primera pasada 1 min tras arrancar
  setInterval(sweepAdminWindowWarnings, 20 * 60 * 1000);    // luego cada 20 min
}

module.exports = {
  notifyAdmin,
  markAdminWindowOpen,
  drainAdminOutbox,
  isWindowOpen,
  sweepAdminWindowWarnings,
  startAdminWindowJob,
};
