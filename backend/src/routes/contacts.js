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

/**
 * GET /api/contacts/broadcast
 * Todos los contactos con teléfono disponibles para envío masivo:
 *   - Tabla contacts (WhatsApp leads/customers)
 *   - Clientes únicos de shopify_orders con customer_phone válido
 * Deduplicados por teléfono normalizado.
 */
router.get('/broadcast', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const [waRes, shopRes] = await Promise.all([
      // WhatsApp contacts
      pool.query(
        `SELECT phone, name, contact_type, total_orders, last_order_at
         FROM contacts
         WHERE organization_id = $1 AND phone IS NOT NULL AND phone <> ''
         ORDER BY total_orders DESC NULLS LAST`,
        [req.orgId]
      ),
      // Clientes de Shopify orders cacheados con teléfono
      pool.query(
        `SELECT DISTINCT ON (customer_phone)
           customer_phone  AS phone,
           customer_name   AS name,
           'shopify'       AS source,
           COUNT(*) OVER (PARTITION BY customer_phone) AS total_orders
         FROM shopify_orders
         WHERE organization_id = $1
           AND customer_phone IS NOT NULL
           AND customer_phone <> ''
         ORDER BY customer_phone, synced_at DESC`,
        [req.orgId]
      ),
    ]);

    // Normalizar teléfono (quitar +, espacios, guiones)
    const normalize = p => (p || '').replace(/[\s\-().+]/g, '');

    // Primero los contactos WhatsApp (ya verificados)
    const seen = new Map();
    for (const c of waRes.rows) {
      const norm = normalize(c.phone);
      if (norm && !seen.has(norm)) {
        seen.set(norm, { phone: c.phone, name: c.name || 'Sin nombre', source: 'whatsapp', contact_type: c.contact_type, total_orders: parseInt(c.total_orders) || 0 });
      }
    }
    // Luego los de Shopify que no estén ya
    for (const c of shopRes.rows) {
      const norm = normalize(c.phone);
      if (norm && !seen.has(norm)) {
        seen.set(norm, { phone: c.phone, name: c.name || 'Sin nombre', source: 'shopify', contact_type: 'customer', total_orders: parseInt(c.total_orders) || 0 });
      }
    }

    const contacts = Array.from(seen.values());
    res.json({ success: true, contacts, total: contacts.length, sources: { whatsapp: waRes.rows.length, shopify: shopRes.rows.length } });
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
