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
              shopify_id, total_orders, last_order_at, opt_out,
              CASE WHEN shopify_id IS NOT NULL THEN 'shopify' ELSE 'whatsapp' END AS source
       FROM contacts
       WHERE organization_id = $1 AND phone IS NOT NULL AND phone <> ''
         AND (opt_out IS NULL OR opt_out = FALSE)
         -- Excluir contactos con pedido agendado pendiente (ya tienen seguimiento)
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_orders so
           WHERE so.organization_id = contacts.organization_id
             AND so.phone = contacts.phone
             AND so.status = 'pending'
         )
       ORDER BY total_orders DESC NULLS LAST, last_order_at DESC NULLS LAST`,
      [req.orgId]
    );

    // Deduplicar por teléfono normalizado — prefiere formato 569XXXXXXXX (11 dígitos)
    // Bug anterior: /^9(\d{8})$/ capturaba solo 8 dígitos → 10 dígitos en vez de 11
    const normalize = p => {
      const n = String(p || '').replace(/\D/g, '');
      if (/^9\d{8}$/.test(n))   return '56' + n;  // 912345678 → 56912345678
      if (/^\d{11}$/.test(n))   return n;           // 56912345678 → igual
      return n;
    };
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
 * Ahora también extrae address1 del raw_json de la orden más reciente.
 */
router.post('/backfill-shopify', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (customer_phone)
         customer_phone, customer_name, customer_email, shipping_city, shopify_created_at,
         raw_json,
         COUNT(*) OVER (PARTITION BY customer_phone) AS order_count
       FROM shopify_orders
       WHERE organization_id = $1 AND customer_phone IS NOT NULL AND customer_phone <> ''
       ORDER BY customer_phone, shopify_created_at DESC`,
      [req.orgId]
    );

    let upserted = 0;
    for (const r of rows) {
      // Extraer address1 del raw_json de la orden más reciente
      let address1 = null;
      try {
        const raw = typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json;
        address1 = raw?.shippingAddress?.address1 || raw?.billingAddress?.address1 || null;
      } catch {}

      await pool.query(
        `INSERT INTO contacts
           (organization_id, phone, name, email, city, address1, contact_type,
            total_orders, last_order_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'customer',$7,$8,NOW(),NOW())
         ON CONFLICT (organization_id, phone) DO UPDATE SET
           name          = COALESCE(EXCLUDED.name,     contacts.name),
           email         = COALESCE(EXCLUDED.email,    contacts.email),
           city          = COALESCE(EXCLUDED.city,     contacts.city),
           address1      = COALESCE(EXCLUDED.address1, contacts.address1),
           contact_type  = 'customer',
           total_orders  = GREATEST(contacts.total_orders, EXCLUDED.total_orders),
           last_order_at = GREATEST(contacts.last_order_at, EXCLUDED.last_order_at),
           updated_at    = NOW()`,
        [req.orgId, r.customer_phone, r.customer_name, r.customer_email,
         r.shipping_city, address1, parseInt(r.order_count) || 1, r.shopify_created_at]
      );
      upserted++;
    }
    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/contacts/dedup-phones
 * Fusiona contactos duplicados que tienen el mismo número en formatos distintos
 * (ej: 912345678 y 56912345678). Conserva la fila con más datos.
 */
router.post('/dedup-phones', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    // ── Paso 1: normalizar teléfonos de 9 dígitos → anteponer 56 ──
    const { rows: toFix } = await pool.query(
      `SELECT id, phone, contact_type FROM contacts
       WHERE organization_id = $1 AND phone ~ '^9[0-9]{8}$'`,
      [req.orgId]
    );

    let merged = 0;
    for (const row of toFix) {
      const canonical = '56' + row.phone;
      const { rows: [existing] } = await pool.query(
        `SELECT id, contact_type FROM contacts WHERE organization_id = $1 AND phone = $2 LIMIT 1`,
        [req.orgId, canonical]
      );
      if (existing) {
        // Determinar cuál conservar: customer siempre gana sobre lead
        const keepId   = (existing.contact_type === 'customer' || row.contact_type === 'lead') ? existing.id : row.id;
        const deleteId = keepId === existing.id ? row.id : existing.id;
        // Fusionar datos del eliminado al que se conserva
        await pool.query(
          `UPDATE contacts SET
             name         = COALESCE(contacts.name,     (SELECT name     FROM contacts WHERE id = $2)),
             email        = COALESCE(contacts.email,    (SELECT email    FROM contacts WHERE id = $2)),
             address      = COALESCE(contacts.address,  (SELECT address  FROM contacts WHERE id = $2)),
             address1     = COALESCE(contacts.address1, (SELECT address1 FROM contacts WHERE id = $2)),
             city         = COALESCE(contacts.city,     (SELECT city     FROM contacts WHERE id = $2)),
             contact_type = CASE WHEN EXISTS (SELECT 1 FROM contacts WHERE id = $2 AND contact_type = 'customer')
                                 THEN 'customer' ELSE contacts.contact_type END,
             updated_at   = NOW()
           WHERE id = $1`,
          [keepId, deleteId]
        );
        // Si el que sobrevive tiene formato corto, normalizar su phone
        if (keepId === row.id) {
          await pool.query(
            `UPDATE contacts SET phone = $1, updated_at = NOW() WHERE id = $2`,
            [canonical, keepId]
          );
        }
        await pool.query(`DELETE FROM contacts WHERE id = $1`, [deleteId]);
        merged++;
      } else {
        // No hay duplicado — solo normalizar el teléfono
        await pool.query(
          `UPDATE contacts SET phone = $1, updated_at = NOW() WHERE id = $2`,
          [canonical, row.id]
        );
      }
    }

    // ── Paso 2: buscar pares lead+customer con mismo teléfono canónico (11 dígitos) ──
    // Puede ocurrir si ambos ya tienen 11 dígitos pero uno es lead y otro customer
    // (no debería pasar por UNIQUE constraint, pero cubre formatos adicionales como +569...)
    const { rows: withPlus } = await pool.query(
      `SELECT id, phone, contact_type FROM contacts
       WHERE organization_id = $1 AND phone ~ '^\\+569[0-9]{8}$'`,
      [req.orgId]
    );
    for (const row of withPlus) {
      const canonical = row.phone.replace(/^\+/, ''); // +56912345678 → 56912345678
      const { rows: [existing] } = await pool.query(
        `SELECT id, contact_type FROM contacts WHERE organization_id = $1 AND phone = $2 LIMIT 1`,
        [req.orgId, canonical]
      );
      if (existing) {
        const keepId   = existing.contact_type === 'customer' ? existing.id : row.id;
        const deleteId = keepId === existing.id ? row.id : existing.id;
        await pool.query(
          `UPDATE contacts SET
             name         = COALESCE(contacts.name,     (SELECT name FROM contacts WHERE id = $2)),
             email        = COALESCE(contacts.email,    (SELECT email FROM contacts WHERE id = $2)),
             address      = COALESCE(contacts.address,  (SELECT address FROM contacts WHERE id = $2)),
             city         = COALESCE(contacts.city,     (SELECT city FROM contacts WHERE id = $2)),
             contact_type = CASE WHEN EXISTS (SELECT 1 FROM contacts WHERE id = $2 AND contact_type = 'customer')
                                 THEN 'customer' ELSE contacts.contact_type END,
             updated_at   = NOW()
           WHERE id = $1`,
          [keepId, deleteId]
        );
        if (keepId === row.id) {
          await pool.query(`UPDATE contacts SET phone = $1, updated_at = NOW() WHERE id = $2`, [canonical, keepId]);
        }
        await pool.query(`DELETE FROM contacts WHERE id = $1`, [deleteId]);
        merged++;
      } else {
        await pool.query(`UPDATE contacts SET phone = $1, updated_at = NOW() WHERE id = $2`, [canonical, row.id]);
      }
    }

    res.json({ success: true, checked: toFix.length + withPlus.length, merged });
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

    let imported = 0, existingLeads = 0, existingCustomers = 0, invalid = 0;
    const errors = [];
    // Deduplicar teléfonos dentro del mismo archivo antes de procesar
    const seen = new Set();

    for (const raw of leads) {
      // Normalizar teléfono — también limpiar prefijos de fórmula Excel (=+56...)
      const rawPhone = String(raw.phone || '').replace(/^=\+?/, '').replace(/^\+/, '').replace(/\s/g, '').replace(/\.0$/, '');
      const phone = normalizePhone ? normalizePhone(rawPhone) : (() => {
        if (!rawPhone) return null;
        let p = rawPhone;
        if (/^9\d{8}$/.test(p)) p = '56' + p;
        return p.length >= 8 ? p : null;
      })();

      if (!phone || phone.length < 8) { invalid++; continue; }
      if (seen.has(phone)) { existingLeads++; continue; } // duplicado en el archivo
      seen.add(phone);

      const name    = (raw.name    || '').trim() || null;
      const email   = (raw.email   || '').trim().toLowerCase() || null;
      const address = (raw.address || '').trim() || null;
      const city    = (raw.city    || '').trim() || null;

      try {
        // xmax = 0 cuando es INSERT nuevo; != 0 cuando es UPDATE (conflicto)
        const { rows } = await pool.query(
          `INSERT INTO contacts
             (organization_id, phone, name, email, address, city, contact_type, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'lead', 'import', NOW(), NOW())
           ON CONFLICT (organization_id, phone) DO UPDATE SET
             name       = COALESCE(contacts.name,    EXCLUDED.name),
             email      = COALESCE(contacts.email,   EXCLUDED.email),
             address    = COALESCE(contacts.address, EXCLUDED.address),
             city       = COALESCE(contacts.city,    EXCLUDED.city),
             updated_at = NOW()
           RETURNING contact_type, (xmax = 0) AS is_new`,
          [req.orgId, phone, name, email, address, city]
        );
        const row = rows[0];
        if (row?.is_new) {
          imported++;          // nuevo lead insertado
        } else if (row?.contact_type === 'customer') {
          existingCustomers++; // ya existía como cliente — no se cambia el tipo
        } else {
          existingLeads++;     // ya existía como lead
        }
      } catch (err) {
        errors.push({ phone: raw.phone, error: err.message });
      }
    }

    res.json({ success: true, imported, existingLeads, existingCustomers, invalid, errors: errors.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/contacts/bulk
 * Elimina múltiples leads por teléfono.
 * Solo borra contactos con contact_type = 'lead' (nunca clientes).
 * Body: { phones: ["569...", ...] }
 */
router.delete('/bulk', async (req, res) => {
  const { getPool } = require('../db/database');
  const pool = getPool();
  try {
    const { phones, all, search } = req.body;

    // Modo "seleccionar todos": elimina todos los leads de la org (filtrado por búsqueda)
    if (all) {
      let q = `DELETE FROM contacts WHERE organization_id = $1 AND contact_type = 'lead'`;
      const params = [req.orgId];
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        q += ` AND (name ILIKE $2 OR phone ILIKE $2)`;
      }
      const { rowCount } = await pool.query(q, params);
      return res.json({ success: true, deleted: rowCount });
    }

    if (!Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({ success: false, error: 'Se requiere un array de teléfonos o all=true' });
    }
    if (phones.length > 2000) {
      return res.status(400).json({ success: false, error: 'Máximo 2000 eliminaciones a la vez' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM contacts
       WHERE organization_id = $1 AND phone = ANY($2) AND contact_type = 'lead'`,
      [req.orgId, phones]
    );
    res.json({ success: true, deleted: rowCount });
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

/**
 * PATCH /api/contacts/:phone/opt-out
 * Marca o desmarca a un contacto como "no quiere recibir mensajes".
 * Body: { optOut: true | false }
 */
router.patch('/:phone/opt-out', async (req, res) => {
  try {
    const { optOut } = req.body;
    if (typeof optOut !== 'boolean') {
      return res.status(400).json({ success: false, error: 'optOut debe ser true o false' });
    }
    const db = require('../db/database');
    const contact = await db.setContactOptOut(req.orgId, req.params.phone, optOut);
    if (!contact) return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
    res.json({ success: true, data: contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/contacts/empresas
 * Devuelve todos los contactos marcados como empresa (sin paginación).
 * Usado para la pantalla de asignación masiva de precios.
 */
router.get('/empresas', async (req, res) => {
  try {
    const { getPool } = require('../db/database');
    const { rows } = await getPool().query(
      `SELECT phone, name, address, city
       FROM contacts
       WHERE organization_id = $1 AND client_type = 'empresa'
       ORDER BY name ASC NULLS LAST`,
      [req.orgId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/contacts/prices/by-product/:product_id
 * Devuelve todos los overrides de precio para un producto dado.
 * Responde { phone → custom_price } para mostrar precios actuales por empresa.
 */
router.get('/prices/by-product/:product_id', async (req, res) => {
  try {
    const { getPool } = require('../db/database');
    const { rows } = await getPool().query(
      `SELECT phone, custom_price
       FROM contact_price_overrides
       WHERE organization_id = $1 AND product_id = $2`,
      [req.orgId, req.params.product_id]
    );
    const map = {};
    for (const r of rows) map[r.phone] = r.custom_price;
    res.json({ success: true, data: map });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Precios especiales por empresa ────────────────────────────────────────

/**
 * GET /api/contacts/:phone/prices
 * Lista los precios especiales configurados para este contacto.
 */
router.get('/:phone/prices', async (req, res) => {
  try {
    const { getPool } = require('../db/database');
    const { rows } = await getPool().query(
      `SELECT id, product_id, product_title, custom_price, updated_at
       FROM contact_price_overrides
       WHERE organization_id = $1 AND phone = $2
       ORDER BY product_title`,
      [req.orgId, req.params.phone]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/contacts/:phone/prices
 * Crea o actualiza un precio especial para un producto.
 * Body: { product_id, product_title, custom_price }
 */
router.put('/:phone/prices', async (req, res) => {
  try {
    const { product_id, product_title, custom_price } = req.body;
    if (!product_id || custom_price == null) {
      return res.status(400).json({ success: false, error: 'product_id y custom_price son requeridos' });
    }
    const price = parseFloat(custom_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, error: 'custom_price debe ser un número >= 0' });
    }
    const { getPool } = require('../db/database');
    const { rows: [row] } = await getPool().query(
      `INSERT INTO contact_price_overrides
         (organization_id, phone, product_id, product_title, custom_price, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (organization_id, phone, product_id) DO UPDATE SET
         product_title = EXCLUDED.product_title,
         custom_price  = EXCLUDED.custom_price,
         updated_at    = NOW()
       RETURNING *`,
      [req.orgId, req.params.phone, product_id, product_title || null, price]
    );
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/contacts/prices/bulk
 * Asigna un precio especial de un producto a múltiples empresas de una vez.
 * Body: { product_id, product_title, custom_price, phones: string[] }
 */
router.post('/prices/bulk', async (req, res) => {
  try {
    const { product_id, product_title, custom_price, phones } = req.body;
    if (!product_id || custom_price == null || !Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({ success: false, error: 'product_id, custom_price y phones[] son requeridos' });
    }
    const price = parseFloat(custom_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, error: 'custom_price debe ser un número >= 0' });
    }
    const { getPool } = require('../db/database');
    const pool = getPool();
    // Upsert one row per phone — unnest paralelo para una sola query
    const values = phones.map((ph, i) => `($1, $${i + 4}, $2, $3, NOW())`).join(', ');
    const params = [req.orgId, product_id, price, ...phones];
    // product_title es opcional — update si ya existe
    await pool.query(
      `INSERT INTO contact_price_overrides
         (organization_id, phone, product_id, custom_price, updated_at)
       VALUES ${values}
       ON CONFLICT (organization_id, phone, product_id) DO UPDATE SET
         custom_price = EXCLUDED.custom_price,
         updated_at   = NOW()`,
      params
    );
    // Guardar product_title en una query separada si viene (es texto, no bloquea)
    if (product_title) {
      await pool.query(
        `UPDATE contact_price_overrides SET product_title = $1
         WHERE organization_id = $2 AND product_id = $3`,
        [product_title, req.orgId, product_id]
      );
    }
    res.json({ success: true, updated: phones.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/contacts/:phone/prices/:product_id
 * Elimina un precio especial.
 */
router.delete('/:phone/prices/:product_id', async (req, res) => {
  try {
    const { getPool } = require('../db/database');
    await getPool().query(
      `DELETE FROM contact_price_overrides
       WHERE organization_id = $1 AND phone = $2 AND product_id = $3`,
      [req.orgId, req.params.phone, req.params.product_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
