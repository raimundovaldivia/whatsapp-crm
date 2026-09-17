/**
 * push.js (routes) — Registro de tokens push de las apps de administrador.
 *
 *   POST /api/push/register    { token, platform }   → guarda/actualiza el token
 *   POST /api/push/unregister  { token }             → lo borra (logout)
 *
 * Solo cuentas owner / admin / supervisor (las que usan la app Central).
 */
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('owner', 'admin', 'supervisor'));

router.post('/register', async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ success: false, error: 'Falta token' });
  try {
    await getPool().query(
      `INSERT INTO push_tokens (organization_id, user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (token) DO UPDATE SET organization_id = EXCLUDED.organization_id,
             user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = NOW()`,
      [req.orgId, req.userId, token, (platform || 'expo').slice(0, 20)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/unregister', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: 'Falta token' });
  try {
    await getPool().query(`DELETE FROM push_tokens WHERE token = $1 AND organization_id = $2`, [token, req.orgId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
