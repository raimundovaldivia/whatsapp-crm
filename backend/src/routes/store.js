/**
 * store.js — Rutas públicas de la tienda (sin autenticación)
 *
 * GET  /store/:slug/info     → nombre, logo y configuración de la tienda
 * GET  /store/:slug/products → catálogo activo
 * POST /store/:slug/orders   → crear pedido COD + confirmación por WhatsApp
 */

const express       = require('express');
const router        = express.Router();
const db            = require('../db/database');
const kapsoService  = require('../services/kapso-whatsapp');
const { getPool }   = require('../db/database');

// ── Helper: obtener org por slug ────────────────────────────────────
async function getOrgBySlug(slug) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM organizations WHERE slug = $1 LIMIT 1',
    [slug]
  );
  return rows[0] || null;
}

router.use('/:slug', async (req,res,next) => {
  try {
    const org = await getOrgBySlug(req.params.slug);
    if (!org || !await require('../services/commercial').permitted(org.id,'storefront')) return res.status(404).json({error:'Tienda no disponible'});
    next();
  } catch { res.status(503).json({error:'Tienda temporalmente no disponible'}); }
});

// ── GET /store/:slug/info ───────────────────────────────────────────
router.get('/:slug/info', async (req, res) => {
  try {
    const org = await getOrgBySlug(req.params.slug);
    if (!org) return res.status(404).json({ error: 'Tienda no encontrada' });

    const [
      storeName, storeLogo, storeColor,
      announcement, heroTitle, heroSubtitle, heroTagsRaw,
      whatsappPhone, freeShippingRaw,
      howToBuy, aboutUs,
    ] = await Promise.all([
      db.getSetting(org.id, 'store_name'),
      db.getSetting(org.id, 'store_logo'),
      db.getSetting(org.id, 'store_color'),
      db.getSetting(org.id, 'store_announcement'),
      db.getSetting(org.id, 'store_hero_title'),
      db.getSetting(org.id, 'store_hero_subtitle'),
      db.getSetting(org.id, 'store_hero_tags'),
      db.getSetting(org.id, 'store_whatsapp_phone'),
      db.getSetting(org.id, 'store_free_shipping'),
      db.getSetting(org.id, 'store_how_to_buy'),
      db.getSetting(org.id, 'store_about_us'),
    ]);

    let heroTags = [];
    try { if (heroTagsRaw) heroTags = JSON.parse(heroTagsRaw); } catch {}

    res.json({
      name:         storeName  || org.name,
      logo:         storeLogo  || null,
      color:        storeColor || '#22c55e',
      slug:         org.slug,
      announcement: announcement || '',
      heroTitle:    heroTitle    || org.name,
      heroSubtitle: heroSubtitle || 'Descubre nuestro catálogo y realiza tu pedido.',
      heroTags,
      whatsappPhone: whatsappPhone || null,
      freeShipping:  freeShippingRaw ? parseInt(freeShippingRaw) : null,
      howToBuy:     howToBuy  || null,
      aboutUs:      aboutUs   || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /store/:slug/products ───────────────────────────────────────
router.get('/:slug/products', async (req, res) => {
  try {
    const org = await getOrgBySlug(req.params.slug);
    if (!org) return res.status(404).json({ error: 'Tienda no encontrada' });

    const products = await db.getProducts(org.id, true); // solo activos
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /store/:slug/orders ────────────────────────────────────────
// Body: { name, phone, address, city, items: [{productId, quantity}] }
router.post('/:slug/orders', async (req, res) => {
  try {
    const org = await getOrgBySlug(req.params.slug);
    if (!org) return res.status(404).json({ error: 'Tienda no encontrada' });

    const { name, phone, address, city, items } = req.body;

    if (![name, phone, address].every(v => typeof v === 'string' && v.length <= 300) ||
        !Array.isArray(items) || items.length < 1 || items.length > 100 ||
        (city !== undefined && (typeof city !== 'string' || city.length > 150))) return res.status(400).json({ error: 'Datos de pedido inválidos' });
    if (!/^\d{8,15}$/.test(phone.replace(/\D/g, ''))) return res.status(400).json({ error: 'Teléfono inválido' });
    // Validaciones básicas
    if (!name?.trim())    return res.status(400).json({ error: 'Nombre requerido' });
    if (!phone?.trim())   return res.status(400).json({ error: 'Teléfono requerido' });
    if (!address?.trim()) return res.status(400).json({ error: 'Dirección requerida' });
    if (!items?.length)   return res.status(400).json({ error: 'Agrega al menos un producto' });

    // Resolver productos y calcular total
    const allProducts = await db.getProducts(org.id, true);
    const productMap  = new Map(allProducts.map(p => [p.id, p]));

    const resolvedItems = [];
    let total = 0;

    for (const item of items) {
      if (!item || typeof item !== 'object') return res.status(400).json({ error: 'Producto inválido' });
      const product = productMap.get(Number(item.productId));
      if (!product) return res.status(400).json({ error: `Producto ${item.productId} no encontrado` });
      const qty = item.quantity;
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1000) return res.status(400).json({ error: 'Cantidad inválida' });
      const price = Number(product.price);
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Precio inválido' });
      resolvedItems.push({ id: product.id, title: product.title, quantity: qty, price });
      total += price * qty;
    }

    // Normalizar teléfono (quitar +, espacios)
    const phoneClean = phone.replace(/\D/g, '');

    // Crear/obtener conversación para este cliente
    const conversation = await db.upsertConversation(org.id, phoneClean, name);

    // Guardar pedido en DB
    const order = await db.createOrder({
      conversationId:  conversation.id,
      organizationId:  org.id,
      items:           resolvedItems,
      customerName:    name,
      customerPhone:   phoneClean,
      shippingAddress: { address, city },
      totalPrice:      total.toFixed(0),
    });

    // Guardar contacto
    db.upsertContact(org.id, { phone: phoneClean, name, address, city }).catch(() => {});

    // Enviar confirmación por WhatsApp
    const wc = await db.getWhatsappConfig(org.id);
    if (wc?.provider === 'kapso') {
      const itemsText = resolvedItems
        .map(i => `  • ${i.title} x${i.quantity} — $${(i.price * i.quantity).toLocaleString('es-CL')}`)
        .join('\n');

      const msg = [
        `¡Hola ${name}! 👋`,
        ``,
        `Tu pedido fue recibido ✅`,
        ``,
        `📦 *Productos:*`,
        itemsText,
        ``,
        `📍 *Entrega:* ${address}, ${city}`,
        `💵 *Total:* $${parseInt(total).toLocaleString('es-CL')}`,
        `💳 *Pago:* Contra entrega`,
        ``,
        `Pronto te confirmaremos la fecha de despacho 🚀`,
      ].join('\n');

      kapsoService.sendTextMessage(phoneClean, msg, wc).catch(() => {});
    }

    // Notificar al admin
    const adminPhone = await db.getSetting(org.id, 'admin_alert_phone');
    if (adminPhone && wc?.provider === 'kapso') {
      const itemsSummary = resolvedItems.map(i => `${i.title} x${i.quantity}`).join(', ');
      const adminMsg = `🛒 *Nuevo pedido desde la tienda web*\n\n👤 *Cliente:* ${name} (${phoneClean})\n📦 *Productos:* ${itemsSummary}\n📍 *Dirección:* ${address}, ${city}\n💵 *Total:* $${parseInt(total).toLocaleString('es-CL')}\n💳 Pago contra entrega`;
      kapsoService.sendTextMessage(adminPhone, adminMsg, wc).catch(() => {});
    }

    res.status(201).json({
      success: true,
      orderId: order.id,
      total:   parseInt(total),
      message: `¡Pedido recibido! Te enviamos confirmación al ${phoneClean} por WhatsApp.`,
    });

  } catch (err) {
    console.error('[Store] Error creando pedido:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
