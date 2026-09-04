/**
 * /api/users — gestión de usuarios de la organización (solo admin/owner)
 */
const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../db/database');
const { requireAuth, requireRole, generateToken } = require('../middleware/auth');

const VALID_ROLES = ['admin', 'supervisor', 'agent'];

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
    const { email, password, name, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ success: false, error: 'Email, password y rol son requeridos' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `Rol inválido. Válidos: ${VALID_ROLES.join(', ')}` });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Este email ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({
      organizationId: req.orgId,
      email,
      passwordHash,
      name: name || email.split('@')[0],
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
