/**
 * /api/users — gestión de usuarios de la organización (solo admin/owner)
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireRole, generateToken } = require('../middleware/auth');

// 'repartidor': solo accede a la app de despachos (ver REPARTIDOR_ALLOWED_PREFIXES en middleware/auth.js)
const VALID_ROLES = ['admin', 'supervisor', 'agent', 'repartidor', 'coordinador'];

/**
 * Normaliza un "usuario" de login para repartidores (que no tienen email).
 * El identificador de login se guarda en la columna email, así que el usuario
 * pasa a ser un handle sin espacios ni acentos: "Juan Pérez" → "juan.perez".
 */
function normalizeUsername(s) {
  return (s || '')
    .toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/\s+/g, '.')                              // espacios → punto
    .replace(/[^a-z0-9._-]/g, '')                      // solo caracteres seguros
    .replace(/\.+/g, '.')
    .replace(/^[.]+|[.]+$/g, '')
    .slice(0, 40);
}

// Todos los endpoints requieren auth + rol admin/owner
router.use(requireAuth);
router.use(requireRole('owner', 'admin'));

/**
 * GET /api/users
 * Lista todos los usuarios de la organización
 */
router.get('/', async (req, res) => {
  try {
    const users = await db.listOrgUsers(req.orgId);
    res.json({ success: true, data: users });
  } catch (err) {
    console.error('[Users] GET /', err);
    res.status(500).json({ success: false, error: 'Error al listar usuarios' });
  }
});

/**
 * POST /api/users
 * Crea un nuevo usuario en la organización
 * Body: { email, password, name, role }
 */
router.post('/', async (req, res) => {
  try {
    const { email, username, password, name, role } = req.body;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !role) {
      return res.status(400).json({ success: false, error: 'Password y rol son requeridos' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `Rol inválido. Válidos: ${VALID_ROLES.join(', ')}` });
    }

    // Identificador de login. Los repartidores no tienen email: usan un "usuario"
    // (handle) que se guarda igual en la columna email (la clave de login).
    let loginId;
    let displayName = name;
    if (role === 'repartidor') {
      loginId = normalizeUsername(username || name);
      if (!loginId) {
        return res.status(400).json({ success: false, error: 'El usuario es requerido para un repartidor' });
      }
      displayName = name || username;
    } else {
      if (!email) {
        return res.status(400).json({ success: false, error: 'Email es requerido' });
      }
      loginId = email.trim().toLowerCase();
      displayName = name || loginId.split('@')[0];
    }

    const existing = await db.getUserByEmail(loginId);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: role === 'repartidor' ? 'Ese usuario ya existe, elige otro' : 'Este email ya está registrado',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({
      organizationId: req.orgId,
      email: loginId,
      passwordHash,
      name: displayName,
      role,
    });

    res.status(201).json({
      success: true,
      data: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error('[Users] POST /', err);
    res.status(500).json({ success: false, error: 'Error al crear usuario' });
  }
});

/**
 * PATCH /api/users/:id
 * Actualiza whatsapp_phone y/o wa_notifications de un usuario
 * Body: { whatsapp_phone?, wa_notifications? }
 */
router.patch('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { whatsapp_phone, wa_notifications } = req.body;

    let updated = null;

    if (whatsapp_phone !== undefined) {
      updated = await db.updateUserWaPhone(userId, req.orgId, whatsapp_phone || null);
      if (!updated) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    if (wa_notifications !== undefined) {
      updated = await db.updateUserNotifications(userId, req.orgId, wa_notifications);
      if (!updated) return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    if (!updated) return res.status(400).json({ success: false, error: 'Sin campos para actualizar' });

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[Users] PATCH /:id', err);
    res.status(500).json({ success: false, error: 'Error al actualizar usuario' });
  }
});

/**
 * PATCH /api/users/:id/role
 * Cambia el rol de un usuario
 * Body: { role }
 */
router.patch('/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    const userId = parseInt(req.params.id);

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `Rol inválido. Válidos: ${VALID_ROLES.join(', ')}` });
    }

    // No puede cambiar su propio rol
    if (userId === req.userId) {
      return res.status(400).json({ success: false, error: 'No puedes cambiar tu propio rol' });
    }

    const updated = await db.updateUserRole(userId, req.orgId, role);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[Users] PATCH /:id/role', err);
    res.status(500).json({ success: false, error: 'Error al actualizar rol' });
  }
});

/**
 * DELETE /api/users/:id
 * Elimina un usuario de la organización
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // No puede eliminarse a sí mismo
    if (userId === req.userId) {
      return res.status(400).json({ success: false, error: 'No puedes eliminarte a ti mismo' });
    }

    const deleted = await db.deleteOrgUser(userId, req.orgId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Users] DELETE /:id', err);
    res.status(500).json({ success: false, error: 'Error al eliminar usuario' });
  }
});

module.exports = router;
