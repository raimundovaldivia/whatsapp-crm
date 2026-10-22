'use strict';

const { getPool, normalizePhone, normalizeName } = require('../db/database');

const CODE_PATTERN = /(?:^|\s)(REF-[A-Z0-9]{8})(?=$|\s|[.,;:!?])/iu;

function extractReferralCode(message) {
  const match = String(message || '').toUpperCase().match(CODE_PATTERN);
  return match?.[1] || null;
}

function normalizedReferralPhone(value) {
  const phone = normalizePhone(value);
  if (!/^\d{8,15}$/.test(phone)) {
    throw Object.assign(new Error('Ingresa un teléfono válido'), { status: 400 });
  }
  return phone;
}

async function captureInboundReferral(organizationId, conversationId, message) {
  const code = extractReferralCode(message);
  if (!code || !Number.isSafeInteger(Number(organizationId)) || !Number.isSafeInteger(Number(conversationId))) {
    return null;
  }

  const pool = await getPool().connect();
  try {
  await pool.query('BEGIN');
  const { rows: [identity] } = await pool.query(
    `SELECT c.phone_number, c.contact_name,
            rc.id AS referral_code_id, rc.rules_snapshot, referrer.phone AS referrer_phone,
            referred.id AS referred_contact_id
       FROM conversations c
       JOIN referral_codes rc
         ON rc.organization_id = c.organization_id
        AND rc.code = $3
        AND rc.active = TRUE
       JOIN referral_program_settings s
         ON s.organization_id = c.organization_id
        AND s.enabled = TRUE
       JOIN contacts referrer
         ON referrer.organization_id = rc.organization_id
        AND referrer.id = rc.referrer_contact_id
       LEFT JOIN contacts referred
         ON referred.organization_id = c.organization_id
        AND referred.phone = c.phone_number
      WHERE c.organization_id = $1 AND c.id = $2`,
    [organizationId, conversationId, code]
  );
  if (!identity) { await pool.query('ROLLBACK'); return null; }

  const referredPhone = normalizedReferralPhone(identity.phone_number);
  if (normalizedReferralPhone(identity.referrer_phone) === referredPhone) { await pool.query('ROLLBACK'); return null; }
  const engine = require('./referral-engine');
  const history = await engine.purchases(pool, organizationId, referredPhone);
  if (history.some(p => p.purchased)) { await pool.query('ROLLBACK'); return null; }

  const { rows: [referral] } = await pool.query(
    `INSERT INTO referrals
       (organization_id, referral_code_id, referred_contact_id, referred_phone,
        referred_name, status, source, rules_snapshot)
     VALUES ($1, $2, $3, $4, $5, 'pending', 'whatsapp', $6::jsonb)
     ON CONFLICT (organization_id, referred_phone) DO NOTHING
     RETURNING *`,
    [
      organizationId,
      identity.referral_code_id,
      identity.referred_contact_id || null,
      referredPhone,
      normalizeName(identity.contact_name) || '',
      JSON.stringify(identity.rules_snapshot || null),
    ]
  );

  if (!referral) { await pool.query('ROLLBACK'); return null; }
  await pool.query(
    `INSERT INTO referral_events
       (organization_id, referral_id, event_type, to_status, note)
     VALUES ($1, $2, 'created', 'pending', 'Código detectado en WhatsApp')`,
    [organizationId, referral.id]
  );
  await pool.query('COMMIT');
  return referral;
  } catch (error) { await pool.query('ROLLBACK').catch(() => {}); throw error; }
  finally { pool.release(); }
}

module.exports = {
  CODE_PATTERN,
  extractReferralCode,
  normalizedReferralPhone,
  captureInboundReferral,
};
