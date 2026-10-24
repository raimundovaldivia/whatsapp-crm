/**
 * store-settings.js — Ajustes editables de la tienda pública
 *
 * GET  /api/store-settings    → leer todos los settings de la tienda
 * PUT  /api/store-settings    → guardar todos los settings de la tienda
 *
 * Requiere autenticación (requireAuth).
 * Los settings se guardan en la tabla `settings` (key/value por org).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('owner', 'admin'));

// Keys que gestionamos (whitelist)
const STORE_KEYS = [
  'store_name',
  'store_logo',
  'store_color',
  'store_announcement',
  'store_hero_title',
  'store_hero_subtitle',
  'store_hero_tags',       // JSON array de strings
  'store_whatsapp_phone',
  'store_free_shipping',   // número como string
  'admin_alert_phone',
  'store_how_to_buy',      // texto largo editable
  'store_about_us',        // texto largo editable
  'store_public_url',      // URL pública de la tienda integrada (ej: https://crm.diezrios.cl/tienda/diezrios)
  'payment_mode',          // 'cod' = pago contra entrega | 'link' = link de pago Shopify
  'campaign_recent_outreach_days', // 1 protege solo contra campañas repetidas el mismo día
];

// ── GET /api/store-settings ────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const pairs = await Promise.all(
      STORE_KEYS.map(async key => [key, await db.getSetting(req.orgId, key)])
    );
    const settings = Object.fromEntries(pairs.map(([k, v]) => [k, v || '']));
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/store-settings ────────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    const updates = req.body || {};
    const saved = [];
    if ('campaign_recent_outreach_days' in updates) {
      const outreachDays = updates.campaign_recent_outreach_days === null ? '' : String(updates.campaign_recent_outreach_days);
      if (!/^(?:[1-9]|[12]\d|30)$/.test(outreachDays)) {
        return res.status(400).json({ error: 'La pausa entre campañas debe ser de 1 a 30 días.' });
      }
    }

    for (const key of STORE_KEYS) {
      if (key in updates) {
        const value = updates[key] === null ? '' : String(updates[key]);
        await db.setSetting(req.orgId, key, value);
        saved.push(key);
      }
    }

    res.json({ success: true, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
