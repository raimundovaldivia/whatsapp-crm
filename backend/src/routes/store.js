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
const whatsapp      = require('../services/whatsapp-provider');
const { getPool }   = require('../db/database');
const xlPricing = require('../services/xl-welcome-pricing');

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
      xlWelcomeTiers: org.slug === xlPricing.STORE_SLUG ? xlPricing.WEB_TIERS : null,
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

    const allProducts = await db.getProducts(org.id);
    const products = allProducts.filter(p => p.active === true && p.is_business !== true).map(p => ({...p,replaces_ids:allProducts.filter(old=>old.deprecated_at && old.replacement_product_id===p.id).map(old=>old.id)})); // nunca exponer catálogo mayorista
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /store/:slug/orders ────────────────────────────────────────
// Body: { name, phone, address, city, items: [{productId, quantity}] }
router.post('/:slug/quote', async (req, res) => {
  try {
    const org = await getOrgBySlug(req.params.slug);
    if (!org) return res.status(404).json({ error: 'Tienda no encontrada' });
    const { phone, items } = req.body;
    if (typeof phone !== 'string' || phone.length > 30 || !/^\d{8,15}$/.test(phone.replace(/\D/g, '')) ||
      !Array.isArray(items) || !items.length || items.length > 100 || items.some(i => !Number.isSafeInteger(i.productId) || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 1000)) {
      return res.status(400).json({ error: 'Ingresa un WhatsApp chileno válido y los productos.' });
    }
    const products = await db.getProducts(org.id, true);
    const merged = new Map();
    for (const i of items) merged.set(i.productId, (merged.get(i.productId) || 0) + i.quantity);
    const lines = [...merged].map(([id, quantity]) => {
      const p = products.find(p => Number(p.id) === id && p.is_business !== true);
      if (!p || quantity > 1000) throw Object.assign(new Error('Producto o cantidad no disponible'), { status: 400 });
      return { id, title: p.title, quantity, price: Number(p.price) };
    });
    const ctx = await xlPricing.context(getPool(), org.id, phone);
    const priced = xlPricing.apply(lines, xlPricing.forStore(ctx));
    res.json({ items: priced, total: Math.round(priced.reduce((s, i) => s + i.price * i.quantity, 0)) });
  } catch (err) { res.status(err.status || 503).json({ error: 'No pudimos confirmar los precios. Intenta nuevamente.' }); }
});

router.post('/:slug/orders', async (req, res) => {
  try {
    const org = await getOrgBySlug(req.params.slug);
    if (!org) return res.status(404).json({ error: 'Tienda no encontrada' });

    const { name, phone, address, city, items } = req.body;

    if (![name, phone, address].every(v => typeof v === 'string' && v.length <= 300) ||
        !Array.isArray(items) || items.length < 1 || items.length > 100 ||
        (city !== undefined && (typeof city !== 'string' || city.length > 150))) return res.status(400).json({ error: 'Datos de pedido inválidos' });
    const invalidItem = items.some(item =>
      !Number.isSafeInteger(item?.productId) || item.productId < 1 ||
      !Number.isSafeInteger(item?.quantity) || item.quantity < 1 || item.quantity > 1000
    );
    if (invalidItem) return res.status(400).json({ error: 'Producto o cantidad inválida' });
    if (!/^\d{8,15}$/.test(phone.replace(/\D/g, ''))) return res.status(400).json({ error: 'Teléfono inválido' });
    // Validaciones básicas
    if (!name?.trim())    return res.status(400).json({ error: 'Nombre requerido' });
    if (!phone?.trim())   return res.status(400).json({ error: 'Teléfono requerido' });
    if (!address?.trim()) return res.status(400).json({ error: 'Dirección requerida' });
    if (!items?.length)   return res.status(400).json({ error: 'Agrega al menos un producto' });

    // Normalizar teléfono (quitar +, espacios)
    const phoneClean = phone.replace(/\D/g, '');

    // La tienda web usa la conexión directa (Evolution), nunca Kapso.
    const directChannel = await db.getEvolutionWhatsappChannel(org.id);
    const evolutionChannel = directChannel?.status === 'connected' ? directChannel : null;

    // Crear/obtener conversación para este cliente y asociarla al canal directo.
    const conversation = await db.upsertConversation(org.id, phoneClean, name, evolutionChannel?.id || null);

    // Crear el pedido y descontar stock dentro de una misma transacción.
    const { order, resolvedItems, total } = await db.createStoreOrder({
      conversationId:  conversation.id,
      organizationId:  org.id,
      customerName:    name,
      customerPhone:   phoneClean,
      shippingAddress: { address, city },
      items,
      expectedTotal: req.body.expectedTotal,
    });

    // Guardar contacto
    db.upsertContact(org.id, { phone: phoneClean, name, address, city }).catch(() => {});

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

    let confirmationSent = false;
    if (evolutionChannel) {
      try {
        await whatsapp.sendTextMessage(phoneClean, msg, evolutionChannel);
        confirmationSent = true;
      } catch (sendError) {
        console.error('[Store] Pedido guardado, pero Evolution no confirmó el mensaje al cliente:', sendError.message);
      }
    } else {
      console.warn('[Store] Pedido guardado sin confirmación: no hay canal Evolution conectado');
    }

    // Notificar al admin por la misma conexión directa.
    const adminPhone = await db.getSetting(org.id, 'admin_alert_phone');
    if (adminPhone && evolutionChannel) {
      const itemsSummary = resolvedItems.map(i => `${i.title} x${i.quantity}`).join(', ');
      const adminMsg = `🛒 *Nuevo pedido desde la tienda web*\n\n👤 *Cliente:* ${name} (${phoneClean})\n📦 *Productos:* ${itemsSummary}\n📍 *Dirección:* ${address}, ${city}\n💵 *Total:* $${parseInt(total).toLocaleString('es-CL')}\n💳 Pago contra entrega`;
      try {
        await whatsapp.sendTextMessage(adminPhone, adminMsg, evolutionChannel);
      } catch (sendError) {
        console.error('[Store] Pedido guardado, pero Evolution no notificó al administrador:', sendError.message);
      }
    }

    res.status(201).json({
      success: true,
      orderId: order.id,
      total:   parseInt(total),
      confirmationSent,
      whatsappProvider: confirmationSent ? 'evolution' : null,
      message: confirmationSent
        ? `¡Pedido recibido! Enviamos la confirmación al ${phoneClean} por WhatsApp.`
        : '¡Pedido recibido! Lo guardamos correctamente y te contactaremos para confirmarlo.',
    });

  } catch (err) {
    console.error('[Store] Error creando pedido:', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code || undefined });
  }
});

module.exports = router;
