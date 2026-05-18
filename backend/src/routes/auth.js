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
    const { businessName, email, password, name } = req.body;

    if (!businessName || !email || !password) {
      return res.status(400).json({ success: false, error: 'businessName, email y password son requeridos' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    // Verificar email único
    const existing = db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Este email ya está registrado' });
    }

    // Crear slug único para la organización
    const slug = businessName.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 30) + '-' + Date.now().toString(36);

    // Crear organización
    const org = db.createOrganization({ name: businessName, slug });

    // Hash de contraseña
    const passwordHash = await bcrypt.hash(password, 12);

    // Crear usuario owner
    const user = db.createUser({
      organizationId: org.id,
      email,
      passwordHash,
      name: name || businessName,
      role: 'owner',
    });

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        organization: { id: org.id, name: org.name, slug: org.slug, setup_done: org.setup_done },
      },
    });
  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ success: false, error: err.message });
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

    const user = db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    const org = db.getOrgById(user.organization_id);
    const token = generateToken(user);

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
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
router.get('/me', requireAuth, (req, res) => {
  try {
    const user = db.getUserById(req.userId);
    const org  = db.getOrgById(req.orgId);
    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        organization: { id: org.id, name: org.name, slug: org.slug, setup_done: org.setup_done },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
