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

/**
 * GET /api/contacts/by-phone?phone=56987...
 * Busca un contacto por teléfono (con normalización de variantes).
 */
router.get('/by-phone', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const raw = (req.query.phone || '').replace(/\D/g, '');
    if (!raw) return res.json({ contact: null });
    // Variantes del número
    const variants = new Set([raw]);
    if (/^569\d{8}$/.test(raw))  variants.add(raw.slice(2));
    if (/^9\d{8}$/.test(raw))    variants.add('56' + raw);
    const { rows } = await pool.query(
      `SELECT * FROM contacts WHERE organization_id = $1 AND phone = ANY($2) LIMIT 1`,
      [req.orgId, [...variants]]
    );
    res.json({ contact: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
 * Todos los contactos con teléfono desde la tabla contacts.
 * Los clientes de Shopify se sincronizan automáticamente en upsertShopifyOrders.
 */
router.get('/broadcast', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT phone, name, email, city, contact_type,
              shopify_id, total_orders, last_order_at,
              CASE WHEN shopify_id IS NOT NULL THEN 'shopify' ELSE 'whatsapp' END AS source
       FROM contacts
       WHERE organization_id = $1 AND phone IS NOT NULL AND phone <> ''
       ORDER BY total_orders DESC NULLS LAST, last_order_at DESC NULLS LAST`,
      [req.orgId]
    );

    // Deduplicar por teléfono normalizado — prefiere formato 56XXXXXXXXX
    const normalize = p => String(p || '').replace(/^\+/, '').replace(/^9(\d{8})$/, '56$1');
    const seen = new Map();
    for (const row of rows) {
      const key = normalize(row.phone);
      if (!seen.has(key)) {
        seen.set(key, { ...row, phone: key });
      }
    }
    const contacts = [...seen.values()];

    const whatsapp = contacts.filter(c => c.source === 'whatsapp').length;
    const shopify  = contacts.filter(c => c.source === 'shopify').length;
    res.json({ success: true, contacts, total: contacts.length, sources: { whatsapp, shopify } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/contacts/backfill-shopify
 * Rellena la tabla contacts con todos los clientes ya cacheados en shopify_orders.
 * Solo necesita ejecutarse una vez (o cuando se quiera forzar re-sincronización).
 */
router.post('/backfill-shopify', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (customer_phone)
         customer_phone, customer_name, customer_email, shipping_city, shopify_created_at,
         COUNT(*) OVER (PARTITION BY customer_phone) AS order_count
       FROM shopify_orders
       WHERE organization_id = $1 AND customer_phone IS NOT NULL AND customer_phone <> ''
       ORDER BY customer_phone, shopify_created_at DESC`,
      [req.orgId]
    );

    let upserted = 0;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO contacts
           (organization_id, phone, name, email, city, contact_type,
            total_orders, last_order_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'customer',$6,$7,NOW(),NOW())
         ON CONFLICT (organization_id, phone) DO UPDATE SET
           name          = COALESCE(EXCLUDED.name, contacts.name),
           email         = COALESCE(EXCLUDED.email, contacts.email),
           city          = COALESCE(EXCLUDED.city,  contacts.city),
           contact_type  = 'customer',
           total_orders  = GREATEST(contacts.total_orders, EXCLUDED.total_orders),
           last_order_at = GREATEST(contacts.last_order_at, EXCLUDED.last_order_at),
           updated_at    = NOW()`,
        [req.orgId, r.customer_phone, r.customer_name, r.customer_email, r.shipping_city,
         parseInt(r.order_count) || 1, r.shopify_created_at]
      );
      upserted++;
    }
    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/contacts/normalize-names
 * Aplica Title Case a todos los nombres de contactos de esta organización.
 */
router.post('/normalize-names', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM contacts WHERE organization_id = $1 AND name IS NOT NULL`,
      [req.orgId]
    );
    function toTitleCase(s) {
      const LOWER = new Set(['de','del','la','las','los','y','e','el','en','con','por','a']);
      return (s || '').trim().split(/\s+/).filter(Boolean).map((w, i) => {
        const wl = w.toLowerCase();
        return (i === 0 || !LOWER.has(wl))
          ? wl.charAt(0).toUpperCase() + wl.slice(1)
          : wl;
      }).join(' ');
    }
    let updated = 0;
    for (const { id, name } of rows) {
      const fixed = toTitleCase(name);
      if (fixed !== name) {
        await pool.query(`UPDATE contacts SET name = $1, updated_at = NOW() WHERE id = $2`, [fixed, id]);
        updated++;
      }
    }
    res.json({ success: true, checked: rows.length, updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/contacts/import
 * Importación masiva de leads desde CSV/Excel.
 * Body: { leads: [{phone, name?, email?}] }
 * Normaliza phones y upsertea sin pisar contactos existentes.
 * Retorna: { imported, skipped, invalid, errors[] }
 */
router.post('/import', async (req, res) => {
  try {
    const { leads = [] } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, error: 'No se enviaron leads' });
    }
    if (leads.length > 5000) {
      return res.status(400).json({ success: false, error: 'Máximo 5000 leads por importación' });
    }

    const { getPool } = require('../db/database');
    const { normalizePhone } = db;
    const pool = getPool();

    let imported = 0, skipped = 0, invalid = 0;
    const errors = [];

    for (const raw of leads) {
      const phone = normalizePhone ? normalizePhone(raw.phone) : (() => {
        if (!raw.phone) return null;
        let p = String(raw.phone).replace(/\s/g, '').replace(/^\+/, '');
        if (/^9\d{8}$/.test(p)) p = '56' + p;
        return p.length >= 8 ? p : null;
      })();

      if (!phone) { invalid++; continue; }

      const name  = (raw.name  || '').trim() || null;
      const email = (raw.email || '').trim().toLowerCase() || null;

      try {
        const { rowCount } = await pool.query(
          `INSERT INTO contacts
             (organization_id, phone, name, email, contact_type, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'lead', 'import', NOW(), NOW())
           ON CONFLICT (organization_id, phone) DO UPDATE SET
             name       = CASE WHEN EXCLUDED.name IS NOT NULL AND contacts.name IS NULL
                               THEN EXCLUDED.name ELSE contacts.name END,
             email      = CASE WHEN EXCLUDED.email IS NOT NULL AND contacts.email IS NULL
                               THEN EXCLUDED.email ELSE contacts.email END,
             updated_at = NOW()
           WHERE contacts.name IS NULL OR contacts.email IS NULL`,
          [req.orgId, phone, name, email]
        );
        // rowCount = 1 si insertó o actualizó, 0 si ya existía y no había nada que actualizar
        if (rowCount > 0) imported++; else skipped++;
      } catch (err) {
        errors.push({ phone: raw.phone, error: err.message });
      }
    }

    res.json({ success: true, imported, skipped, invalid, errors: errors.slice(0, 20) });
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

/**
 * PATCH /api/contacts/:phone
 * Actualiza nombre, dirección y ciudad de un contacto.
 */
router.patch('/:phone', async (req, res) => {
  try {
    const { getPool } = require('../db/database');
    const { name, address, city } = req.body;
    const phone = req.params.phone;
    // Upsert: inserta o actualiza dirección/nombre
    const { rows: [contact] } = await getPool().query(
      `INSERT INTO contacts (organization_id, phone, name, address, city, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (organization_id, phone)
       DO UPDATE SET
         name       = CASE WHEN $3 IS NOT NULL THEN $3 ELSE contacts.name END,
         address    = CASE WHEN $4 IS NOT NULL THEN $4 ELSE contacts.address END,
         city       = CASE WHEN $5 IS NOT NULL THEN $5 ELSE contacts.city END,
         updated_at = NOW()
       RETURNING *`,
      [req.orgId, phone, name || null, address || null, city || null]
    );
    res.json({ success: true, data: contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
