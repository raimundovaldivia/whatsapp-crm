'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getPool, normalizeName } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { normalizedReferralPhone } = require('../services/referrals');
const engine = require('../services/referral-engine');
const automation = require('../services/referral-automation');
const { DEFAULT_RULES, PRESETS, parseCommand } = require('../services/referral-rules');
const action = fn => async (req, res) => {
  try { res.json({ success: true, ...await fn(req) }); }
  catch (error) { res.status([400,404,409].includes(error.status) ? error.status : 500).json({ success:false,error:error.status ? error.message : 'No se pudo completar la operación de referidos' }); }
};

const router = express.Router();
const canRead = requireRole('owner', 'admin', 'supervisor');
const canManage = requireRole('owner', 'admin');
const STATUS_TRANSITIONS = {
  pending: new Set(['qualified', 'rejected']),
  qualified: new Set(['rewarded', 'rejected']),
  rewarded: new Set(),
  rejected: new Set(['pending']),
};

router.use(requireAuth);

function referralBaseUrl() {
  return String(process.env.CRM_PUBLIC_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL || '')
    .replace(/\/$/, '');
}

function publicLink(slug, code) {
  const base = referralBaseUrl();
  return base ? `${base}/referido/${encodeURIComponent(slug)}/${code}` : null;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function newCode() {
  return `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

router.get('/', canRead, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const search = cleanText(req.query.search, 100);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  if (status && !Object.hasOwn(STATUS_TRANSITIONS, status)) {
    return res.status(400).json({ success: false, error: 'Estado inválido' });
  }

  try {
    const params = [req.orgId];
    const filters = ['r.organization_id = $1'];
    if (status) {
      params.push(status);
      filters.push(`r.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      filters.push(`(r.referred_name ILIKE $${params.length}
        OR r.referred_phone LIKE $${params.length}
        OR referrer.name ILIKE $${params.length}
        OR rc.code ILIKE $${params.length})`);
    }
    params.push(limit);

    const pool = getPool();
    const [referralsResult, codesResult, summaryResult, settingsResult, orgResult] = await Promise.all([
      pool.query(
        `SELECT r.id, r.referred_phone, r.referred_name, r.status, r.source,
                r.notes, r.qualified_at, r.rewarded_at, r.rejected_at,
                r.created_at, r.updated_at, rc.id AS referral_code_id, rc.code,
                referrer.id AS referrer_contact_id, referrer.name AS referrer_name,
                referrer.phone AS referrer_phone
           FROM referrals r
           JOIN referral_codes rc
             ON rc.organization_id = r.organization_id AND rc.id = r.referral_code_id
           JOIN contacts referrer
             ON referrer.organization_id = rc.organization_id
            AND referrer.id = rc.referrer_contact_id
          WHERE ${filters.join(' AND ')}
          ORDER BY r.created_at DESC
          LIMIT $${params.length}`,
        params
      ),
      pool.query(
        `SELECT rc.id, rc.code, rc.active, rc.click_count, rc.created_at, rc.rules_snapshot,
                c.id AS referrer_contact_id, c.name AS referrer_name, c.phone AS referrer_phone,
                COUNT(r.id)::int AS referral_count,
                COUNT(r.id) FILTER (WHERE r.status IN ('qualified','rewarded') AND r.qualifying_order_id IS NOT NULL)::int AS conversion_count
           FROM referral_codes rc
           JOIN contacts c
             ON c.organization_id = rc.organization_id AND c.id = rc.referrer_contact_id
           LEFT JOIN referrals r
             ON r.organization_id = rc.organization_id AND r.referral_code_id = rc.id
          WHERE rc.organization_id = $1
          GROUP BY rc.id, c.id
          ORDER BY rc.created_at DESC`,
        [req.orgId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'qualified')::int AS qualified,
                COUNT(*) FILTER (WHERE status = 'rewarded')::int AS rewarded,
                COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
           FROM referrals WHERE organization_id = $1`,
        [req.orgId]
      ),
      pool.query(
        `SELECT enabled, reward_referrer, reward_referred, terms, rules, updated_at
           FROM referral_program_settings WHERE organization_id = $1`,
        [req.orgId]
      ),
      pool.query('SELECT slug FROM organizations WHERE id = $1', [req.orgId]),
    ]);

    const slug = orgResult.rows[0]?.slug || '';
    const codes = codesResult.rows.map(code => ({
      ...code,
      public_url: publicLink(slug, code.code),
    }));
    res.json({
      success: true,
      data: referralsResult.rows,
      codes,
      summary: summaryResult.rows[0],
      settings: settingsResult.rows[0] || {
        enabled: false, reward_referrer: '', reward_referred: '', terms: '',
      },
    });
  } catch (error) {
    console.error('[Referrals] GET /', error.message);
    res.status(500).json({ success: false, error: 'No se pudo cargar el programa de referidos' });
  }
});

router.put('/settings', canManage, action(async req => ({ settings: await engine.saveSettings(req.orgId,req.userId,req.body) })));

router.post('/codes', canManage, action(async req => ({ code: await engine.createCode(req.orgId,req.userId,Number(req.body?.contact_id)) })));

router.get('/program', canRead, action(async req => {
  const pool = getPool();
  const [settings,rewards,messages,products,audit,orders] = await Promise.all([
    engine.settings(pool,req.orgId),
    pool.query("SELECT *, CASE WHEN status='available' AND expires_at<=NOW() THEN 'expired' ELSE status END AS display_status FROM referral_rewards WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200",[req.orgId]),
    pool.query('SELECT * FROM referral_messages WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',[req.orgId]),
    pool.query('SELECT id,title,stock FROM products WHERE organization_id=$1 AND active=TRUE ORDER BY title',[req.orgId]),
    pool.query('SELECT action,details,created_at FROM referral_program_audit WHERE organization_id=$1 ORDER BY id DESC LIMIT 50',[req.orgId]),
    pool.query("SELECT id,customer_name,customer_phone,total_price FROM orders WHERE organization_id=$1 AND status IN ('draft','nuevo','confirmed','sent','por_despachar','asignado_ruta') AND delivered_at IS NULL AND payment_marked_at IS NULL AND shopify_order_id IS NULL AND shopify_draft_id IS NULL AND invoice_url IS NULL ORDER BY created_at DESC LIMIT 200",[req.orgId]),
  ]);
  return { settings,presets:PRESETS,rewards:rewards.rows,messages:messages.rows,products:products.rows,audit:audit.rows,orders:orders.rows };
}));
router.post('/prepare', canManage, action(req => engine.prepareInvitations(req.orgId,req.userId)));
router.post('/reconcile', canManage, action(req => engine.reconcile(req.orgId)));
router.post('/messages/approve', canManage, action(req => automation.approve(req.orgId,req.userId,req.body?.ids)));
router.post('/rewards/:id/preview', canManage, action(req => engine.redeem(req.orgId,req.userId,Number(req.params.id),Number(req.body?.order_id),true)));
router.post('/rewards/:id/redeem', canManage, action(req => {
  if (!Number.isSafeInteger(req.body?.expected_total) || req.body.expected_total<1) throw Object.assign(new Error('Revisa el canje antes de confirmar'),{status:400});
  return engine.redeem(req.orgId,req.userId,Number(req.params.id),Number(req.body?.order_id),false,req.body.expected_total);
}));
router.post('/command', canManage, action(async req => {
  const current = await engine.settings(getPool(),req.orgId);
  const preview = parseCommand(req.body?.message,current.rules);
  if (req.body?.execute !== true) return { preview };
  // Interpret the original instruction again; never trust a client-supplied plan.
  let result;
  if (preview.action === 'configure') result = await engine.saveSettings(req.orgId,req.userId,{...current,rules:preview.rules});
  if (preview.action === 'pause' || preview.action === 'activate') result = await engine.saveSettings(req.orgId,req.userId,{...current,enabled:preview.action==='activate'});
  if (preview.action === 'prepare') result = await engine.prepareInvitations(req.orgId,req.userId);
  if (preview.action === 'reconcile') result = await engine.reconcile(req.orgId);
  return { preview,result };
}));

router.patch('/codes/:id', canManage, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Datos inválidos' });
  }
  try {
    const { rows: [code] } = await getPool().query(
      `UPDATE referral_codes SET active = $1, updated_at = NOW()
        WHERE id = $2 AND organization_id = $3 RETURNING *`,
      [req.body.active, id, req.orgId]
    );
    if (!code) return res.status(404).json({ success: false, error: 'Código no encontrado' });
    res.json({ success: true, code });
  } catch (error) {
    res.status(500).json({ success: false, error: 'No se pudo actualizar el código' });
  }
});

router.post('/claims', canManage, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^REF-[A-Z0-9]{8}$/.test(code)) {
    return res.status(400).json({ success: false, error: 'Código inválido' });
  }

  let referredPhone;
  try {
    referredPhone = normalizedReferralPhone(req.body?.referred_phone);
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, error: error.message });
  }
  const referredName = normalizeName(cleanText(req.body?.referred_name, 120)) || '';
  const notes = String(req.body?.notes || '').trim().slice(0, 1000);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [referralCode] } = await client.query(
      `SELECT rc.id, rc.rules_snapshot, referrer.phone AS referrer_phone
         FROM referral_codes rc
         JOIN contacts referrer
           ON referrer.organization_id = rc.organization_id
          AND referrer.id = rc.referrer_contact_id
        WHERE rc.organization_id = $1 AND rc.code = $2 AND rc.active = TRUE
          AND EXISTS(SELECT 1 FROM referral_program_settings s WHERE s.organization_id=rc.organization_id AND s.enabled=TRUE)
        FOR UPDATE`,
      [req.orgId, code]
    );
    if (!referralCode) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Código no encontrado o inactivo' });
    }
    if (normalizedReferralPhone(referralCode.referrer_phone) === referredPhone) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Un cliente no puede referirse a sí mismo' });
    }
    const history = await engine.purchases(client, req.orgId, referredPhone);
    if (history.some(p => p.purchased)) {
      await client.query('ROLLBACK');
      return res.status(409).json({success:false,error:'El beneficio de referido es solo para clientes sin compras anteriores'});
    }
    const { rows: [contact] } = await client.query(
      'SELECT id FROM contacts WHERE organization_id = $1 AND phone = $2',
      [req.orgId, referredPhone]
    );
    const { rows: [referral] } = await client.query(
      `INSERT INTO referrals
         (organization_id, referral_code_id, referred_contact_id, referred_phone,
          referred_name, status, source, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'manual', $6, $7)
       RETURNING *`,
      [req.orgId, referralCode.id, contact?.id || null, referredPhone, referredName, notes, req.userId]
    );
    await client.query('UPDATE referrals SET rules_snapshot=$3::jsonb WHERE organization_id=$1 AND id=$2', [req.orgId,referral.id,JSON.stringify(referralCode.rules_snapshot)]);
    await client.query(
      `INSERT INTO referral_events
         (organization_id, referral_id, actor_id, event_type, to_status, note)
       VALUES ($1, $2, $3, 'created', 'pending', $4)`,
      [req.orgId, referral.id, req.userId, notes]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, referral });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'Ese teléfono ya está asociado a un referido' });
    }
    console.error('[Referrals] POST /claims', error.message);
    res.status(500).json({ success: false, error: 'No se pudo registrar el referido' });
  } finally {
    client.release();
  }
});

router.patch('/:id/status', canManage, async (req, res) => {
  const id = Number(req.params.id);
  const nextStatus = String(req.body?.status || '');
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!Number.isSafeInteger(id) || id < 1 || !Object.hasOwn(STATUS_TRANSITIONS, nextStatus)) {
    return res.status(400).json({ success: false, error: 'Estado o referido inválido' });
  }
  if (['qualified','rewarded'].includes(nextStatus)) return res.status(409).json({ success:false,error:'Usa Revisar compras para calificar y Canjear bono para entregar beneficios' });
  if (nextStatus === 'rejected' && !note) {
    return res.status(400).json({ success: false, error: 'Indica el motivo del rechazo' });
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      'SELECT * FROM referrals WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      [req.orgId, id]
    );
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Referido no encontrado' });
    }
    if (current.rules_snapshot && nextStatus === 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({success:false,error:'Un referido rechazado no puede volver a recibir el beneficio único'});
    }
    if (!STATUS_TRANSITIONS[current.status]?.has(nextStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: `No se puede pasar de ${current.status} a ${nextStatus}` });
    }
    if (nextStatus === 'rejected') await client.query("UPDATE referral_rewards SET status='void' WHERE organization_id=$1 AND referral_id=$2 AND status='available'",[req.orgId,id]);
    const { rows: [updated] } = await client.query(
      `UPDATE referrals SET
         status = $1,
         notes = CASE WHEN $2 = '' THEN notes ELSE $2 END,
         qualified_at = CASE WHEN $1 = 'qualified' THEN NOW() WHEN $1 = 'pending' THEN NULL ELSE qualified_at END,
         rewarded_at = CASE WHEN $1 = 'rewarded' THEN NOW() ELSE rewarded_at END,
         rejected_at = CASE WHEN $1 = 'rejected' THEN NOW() WHEN $1 = 'pending' THEN NULL ELSE rejected_at END,
         updated_at = NOW()
       WHERE organization_id = $3 AND id = $4
       RETURNING *`,
      [nextStatus, note, req.orgId, id]
    );
    await client.query(
      `INSERT INTO referral_events
         (organization_id, referral_id, actor_id, event_type, from_status, to_status, note)
       VALUES ($1, $2, $3, 'status_changed', $4, $5, $6)`,
      [req.orgId, id, req.userId, current.status, nextStatus, note]
    );
    await client.query('COMMIT');
    res.json({ success: true, referral: updated });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Referrals] PATCH /:id/status', error.message);
    res.status(500).json({ success: false, error: 'No se pudo cambiar el estado' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports._private = { cleanText, newCode, publicLink, STATUS_TRANSITIONS };
