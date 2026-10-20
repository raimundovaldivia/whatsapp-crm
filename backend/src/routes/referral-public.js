'use strict';

const express = require('express');
const { getPool, normalizePhone } = require('../db/database');

const router = express.Router();

router.get('/:slug/:code', async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) || !/^REF-[A-Z0-9]{8}$/.test(code)) {
    return res.status(404).send('Enlace de referido no encontrado');
  }

  try {
    const pool = getPool();
    const { rows: [program] } = await pool.query(
      `SELECT o.id AS organization_id, o.name, rc.id AS referral_code_id,
              wc.display_phone_number, wc.twilio_phone_number
         FROM organizations o
         JOIN referral_program_settings s
           ON s.organization_id = o.id AND s.enabled = TRUE
         JOIN referral_codes rc
           ON rc.organization_id = o.id AND rc.code = $2 AND rc.active = TRUE
         LEFT JOIN whatsapp_configs wc ON wc.organization_id = o.id
        WHERE o.slug = $1`,
      [slug, code]
    );
    if (!program) return res.status(404).send('Enlace de referido no encontrado');

    const destinationPhone = normalizePhone(program.display_phone_number || program.twilio_phone_number);
    if (!/^\d{8,15}$/.test(destinationPhone)) {
      return res.status(503).send('El canal de WhatsApp no está disponible en este momento');
    }

    await pool.query(
      `UPDATE referral_codes SET click_count = click_count + 1, updated_at = NOW()
        WHERE organization_id = $1 AND id = $2`,
      [program.organization_id, program.referral_code_id]
    );
    const message = `Hola, vengo referido con el código ${code}`;
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, `https://wa.me/${destinationPhone}?text=${encodeURIComponent(message)}`);
  } catch (error) {
    console.error('[ReferralPublic]', error.message);
    return res.status(503).send('El enlace no está disponible en este momento');
  }
});

module.exports = router;
