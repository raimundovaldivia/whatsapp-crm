/**
 * contacts.js — Gestión de contactos (leads y clientes)
 *
 * GET  /api/contacts         → Lista con filtros (type, search, page)
 * GET  /api/contacts/stats   → Totales lead/customer
 * PATCH /api/contacts/:phone/type → Cambiar tipo manualmente
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const PAGE_SIZE = 100;

router.get('/', async (req, res) => {
  try {
    const { type, search, page = 1 } = req.query;
    const offset  = (parseInt(page) - 1) * PAGE_SIZE;
    const contacts = await db.getContacts(req.orgId, {
      type:   type   || null,
      search: search || null,
      limit:  PAGE_SIZE,
      offset,
    });
    const total = await db.countContacts(req.orgId, type || null);
    res.json({ success: true, data: contacts, total, page: parseInt(page), pageSize: PAGE_SIZE });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const [total, leads, customers] = await Promise.all([
      db.countContacts(req.orgId),
      db.countContacts(req.orgId, 'lead'),
      db.countContacts(req.orgId, 'customer'),
    ]);
    res.json({ success: true, data: { total, leads, customers } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/:phone/type', async (req, res) => {
  try {
    const { type } = req.body;
    if (!['lead', 'customer'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Tipo debe ser lead o customer' });
    }
    const { getPool } = require('../db/database');
    const { rows: [contact] } = await getPool().query(
      `UPDATE contacts SET contact_type = $1, updated_at = NOW()
       WHERE organization_id = $2 AND phone = $3 RETURNING *`,
      [type, req.orgId, req.params.phone]
    );
    if (!contact) return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
    res.json({ success: true, data: contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
