const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');

const publicUser = user => ({ id: user.id, email: user.email, name: user.name, role: user.role, organization_id: user.organization_id });
const publicOrg = org => ({ id: org.id, name: org.name, slug: org.slug, setup_done: org.setup_done });
const normalizedEmail = email => String(email || '').trim().toLowerCase();

async function sessionAccounts(req) {
  const accounts = [];
  for (const grant of req.sessionAccounts || []) {
    if (!Number.isSafeInteger(grant?.userId) || !Number.isSafeInteger(grant?.orgId)) continue;
    const user = await db.getUserById(grant.userId);
    if (!user || user.organization_id !== grant.orgId || user.role !== grant.role ||
        Number(user.auth_version || 0) !== grant.authVersion ||
        normalizedEmail(user.email) !== normalizedEmail(grant.email) ||
        normalizedEmail(user.email) !== normalizedEmail(req.userEmail)) continue;
    if (!accounts.some(account => account.id === user.id)) accounts.push(user);
  }
  return accounts;
}

async function accountOptions(accounts) {
  const options = await Promise.all(accounts.map(async user => {
    const org = await db.getOrgById(user.organization_id);
    return org ? { organization_id: org.id, name: org.name, slug: org.slug, role: user.role } : null;
  }));
  return options.filter(Boolean);
}

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

    // El correo solo debe ser único dentro de cada empresa (ver índice users_org_email_uq),
    // así que una empresa nueva puede usar un correo que ya tiene cuenta en otra.

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
    const { password, organizationId } = req.body;
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    if (!email || email.length > 254 || typeof password !== 'string' || !password || password.length > 128) {
      return res.status(400).json({ success: false, error: 'Email y password requeridos' });
    }

    // Un correo puede tener una cuenta por empresa. La contraseña se valida contra
    // cada cuenta antes de revelar en qué empresas existe el correo.
    const candidates = await db.getUsersByEmail(email);
    const matches = [];
    for (const candidate of candidates) {
      if (await bcrypt.compare(password, candidate.password_hash)) matches.push(candidate);
    }
    if (matches.length === 0) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    if (organizationId != null && !matches.some(m => String(m.organization_id) === String(organizationId))) {
      return res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }

    let user = matches[0];
    if (matches.length > 1) {
      const chosen = organizationId != null
        ? matches.find(m => String(m.organization_id) === String(organizationId))
        : null;
      if (!chosen) {
        // Sin empresa elegida: el cliente muestra el selector y vuelve a llamar con organizationId.
        const organizations = await Promise.all(matches.map(async m => {
          const o = await db.getOrgById(m.organization_id);
          return { organization_id: m.organization_id, name: o?.name || '', slug: o?.slug || '', role: m.role };
        }));
        return res.json({ success: true, data: { needsOrganization: true, organizations } });
      }
      user = chosen;
    }

    const org = await db.getOrgById(user.organization_id);
    const token = generateToken(user, { accounts: matches });

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

// Lists only accounts authorized by this session, never by email alone.
router.get('/organizations', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, data: { organizations: await accountOptions(await sessionAccounts(req)) } });
  } catch {
    res.status(500).json({ success: false, error: 'No pudimos cargar tus tiendas' });
  }
});

// Upgrades an older session without logging out. The existing /api/auth rate
// limiter also protects this password verification. No credentials are persisted.
router.post('/verify-organizations', requireAuth, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ success: false, error: 'Ingresa tu contraseña' });
  }
  try {
    const candidates = await db.getUsersByEmail(req.userEmail);
    const matches = [];
    for (const candidate of candidates) {
      if (await bcrypt.compare(password, candidate.password_hash)) matches.push(candidate);
    }
    if (!matches.length) return res.status(403).json({ success: false, error: 'Contraseña incorrecta' });
    const currentAccounts = await sessionAccounts(req);
    const user = currentAccounts.find(candidate => candidate.id === req.userId && candidate.organization_id === req.orgId);
    if (!user) return res.status(403).json({ success: false, error: 'Verifica tu sesión nuevamente' });
    const accounts = [...new Map([...currentAccounts, ...matches].map(account => [account.id, account])).values()];
    res.json({ success: true, data: {
      token: generateToken(user, { accounts, expiresAt: req.sessionExpiresAt }),
      user: publicUser(user), organization: publicOrg(await db.getOrgById(req.orgId)),
      organizations: await accountOptions(accounts),
    } });
  } catch {
    res.status(500).json({ success: false, error: 'No pudimos verificar tus tiendas' });
  }
});

router.post('/switch-organization', requireAuth, async (req, res) => {
  const organizationId = req.body?.organizationId;
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    return res.status(400).json({ success: false, error: 'Selecciona una tienda válida' });
  }
  try {
    const accounts = await sessionAccounts(req);
    const user = accounts.find(account => account.organization_id === organizationId);
    if (!user) return res.status(403).json({ success: false, error: 'Esta sesión no tiene acceso a esa tienda. Verifica tus tiendas nuevamente.' });
    const org = await db.getOrgById(organizationId);
    if (!org) return res.status(403).json({ success: false, error: 'Tienda no disponible' });
    res.json({ success: true, data: {
      token: generateToken(user, { accounts, expiresAt: req.sessionExpiresAt }),
      user: publicUser(user), organization: publicOrg(org),
    } });
  } catch {
    res.status(500).json({ success: false, error: 'No pudimos cambiar de tienda' });
  }
});

module.exports = router;
