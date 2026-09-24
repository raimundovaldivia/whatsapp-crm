const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');

/**
 * POST /api/auth/register
 * Registra un nuevo negocio (organización) y su usuario owner
 */
router.post('/register', async (req, res) => {
  try {
    const { businessName, password, name } = req.body;
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (typeof businessName !== 'string' || !businessName.trim() || businessName.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length > 128 || (name !== undefined && (typeof name !== 'string' || name.length > 150))) return res.status(400).json({ error:'Revisa el nombre del negocio, correo y contraseña' });

    if (!businessName || !email || !password) {
      return res.status(400).json({ success: false, error: 'businessName, email y password son requeridos' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    // Verificar email único
    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Este email ya está registrado' });
    }

    // Crear slug único para la organización
    const slug = businessName.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 30) + '-' + Date.now().toString(36);

    const passwordHash = await bcrypt.hash(password, 12);
    const client = await db.getPool().connect();
    let org, user;
    try {
      await client.query('BEGIN');
      org = (await client.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING *',[businessName.trim(),slug])).rows[0];
      user = (await client.query("INSERT INTO users(organization_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,'owner') RETURNING id,email,name,role,organization_id",[org.id,email,passwordHash,name || businessName])).rows[0];
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, organization_id: user.organization_id },
        organization: { id: org.id, name: org.name, slug: org.slug, setup_done: org.setup_done },
      },
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(err.code === '23505' ? 409 : 500).json({ success: false, error: err.code === '23505' ? 'Este correo ya está registrado' : 'No se pudo crear la cuenta' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email y password requeridos' });
    }

    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    const org = await db.getOrgById(user.organization_id);
    const token = generateToken(user);

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, organization_id: user.organization_id },
        organization: { id: org.id, name: org.name, slug: org.slug, setup_done: org.setup_done },
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/auth/me — Valida token y devuelve usuario actual
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.userId);
    const org  = await db.getOrgById(req.orgId);
    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role, organization_id: user.organization_id },
        organization: { id: org.id, name: org.name, slug: org.slug, setup_done: org.setup_done },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
