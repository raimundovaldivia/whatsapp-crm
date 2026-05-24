/**
 * shopify-oauth.js — Flujo OAuth de Shopify para el CRM
 *
 * GET /shopify-oauth/connect?shop=mi-tienda.myshopify.com
 *   → Redirige a la pantalla de autorización de Shopify
 *
 * GET /shopify-oauth/callback?code=...&shop=...&hmac=...&state=...
 *   → Intercambia el código por un access token permanente,
 *     guarda el token en data_sources, redirige al frontend.
 *
 * Variables de entorno requeridas:
 *   SHOPIFY_API_KEY      = client_id de la app (Shopify Partner dashboard)
 *   SHOPIFY_API_SECRET   = client_secret de la app
 *   SHOPIFY_SCOPES       = (opcional) scopes separados por coma
 *   CRM_PUBLIC_URL       = URL pública del backend (ej: https://crm.onrender.com)
 *   FRONTEND_URL         = URL del frontend (ej: https://crm.onrender.com)
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const axios    = require('axios');
const db       = require('../db/database');
const { getPool } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const API_KEY    = process.env.SHOPIFY_API_KEY    || '';
const API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const SCOPES     = process.env.SHOPIFY_SCOPES
  || 'read_products,write_draft_orders,read_draft_orders,read_orders,write_orders,read_customers';
const CRM_URL    = process.env.CRM_PUBLIC_URL || process.env.PUBLIC_URL || process.env.BACKEND_URL || 'http://localhost:3001';
const FRONTEND   = process.env.FRONTEND_URL   || 'http://localhost:5173';

const REDIRECT_URI = `${CRM_URL}/shopify-oauth/callback`;

// ─── Almacén en memoria de nonces pendientes (state) ──────────────
// Clave: state (nonce) → { shop, orgId, expiresAt }
const pendingStates = new Map();

// Limpiar nonces expirados cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates.entries()) {
    if (v.expiresAt < now) pendingStates.delete(k);
  }
}, 10 * 60 * 1000);

/**
 * GET /shopify-oauth/auth-url?shop=mi-tienda
 *
 * Devuelve la URL de OAuth para que el frontend redirija.
 * El frontend llama esto via api.get() (que ya sabe la URL del backend).
 */
router.get('/auth-url', requireAuth, (req, res) => {
  let { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'Falta el parámetro "shop"' });

  shop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!shop.includes('.')) shop += '.myshopify.com';

  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return res.status(400).json({ error: 'Dominio inválido. Ej: mi-tienda.myshopify.com' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, {
    shop,
    orgId: req.orgId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
    client_id:           API_KEY,
    scope:               SCOPES,
    redirect_uri:        REDIRECT_URI,
    state,
    'grant_options[]':   'offline',
  }).toString();

  res.json({ url: authUrl });
});

/**
 * GET /shopify-oauth/connect?shop=mi-tienda.myshopify.com
 *
 * Protegido con requireAuth — el orgId viene del JWT.
 * Redirige al usuario a la pantalla de instalación/autorización de Shopify.
 */
router.get('/connect', requireAuth, (req, res) => {
  let { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'Falta el parámetro "shop"' });

  // Normalizar: quitar https://, trailing slash, etc.
  shop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!shop.includes('.')) shop += '.myshopify.com';

  // Validar formato (solo letras, números, guiones + .myshopify.com)
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return res.status(400).json({ error: 'Dominio de tienda inválido. Debe ser algo como mi-tienda.myshopify.com' });
  }

  // Generar nonce único para CSRF protection
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, {
    shop,
    orgId: req.orgId,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutos
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
    client_id:    API_KEY,
    scope:        SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    'grant_options[]': 'offline', // token permanente que no expira
  }).toString();

  res.redirect(authUrl);
});

/**
 * GET /shopify-oauth/callback
 *
 * Shopify redirige aquí con ?code=...&shop=...&hmac=...&state=...
 * Intercambia el código por un access_token permanente y guarda en DB.
 */
router.get('/callback', async (req, res) => {
  const { code, shop, hmac, state, error: shopifyError } = req.query;

  // ── Error de Shopify (ej: usuario canceló) ──────────────────────
  if (shopifyError) {
    console.warn('[ShopifyOAuth] Error de Shopify:', shopifyError);
    return res.redirect(`${FRONTEND}?shopify_error=${encodeURIComponent(shopifyError)}`);
  }

  if (!code || !shop || !hmac || !state) {
    return res.redirect(`${FRONTEND}?shopify_error=missing_params`);
  }

  // ── Verificar HMAC (auténtica petición de Shopify) ──────────────
  const params = { ...req.query };
  delete params.hmac;
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const digest  = crypto.createHmac('sha256', API_SECRET).update(message).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
    console.error('[ShopifyOAuth] HMAC inválido');
    return res.redirect(`${FRONTEND}?shopify_error=invalid_hmac`);
  }

  // ── Verificar state (CSRF) ──────────────────────────────────────
  const pending = pendingStates.get(state);
  if (!pending || pending.shop !== shop) {
    console.error('[ShopifyOAuth] State inválido o expirado');
    return res.redirect(`${FRONTEND}?shopify_error=invalid_state`);
  }
  pendingStates.delete(state);
  const { orgId } = pending;

  // ── Intercambiar código por access_token ────────────────────────
  let accessToken;
  try {
    const { data } = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      { client_id: API_KEY, client_secret: API_SECRET, code },
      { timeout: 15000 }
    );
    accessToken = data.access_token;
    if (!accessToken) throw new Error('Shopify no devolvió access_token');
  } catch (err) {
    console.error('[ShopifyOAuth] Error intercambiando token:', err.message);
    return res.redirect(`${FRONTEND}?shopify_error=${encodeURIComponent('No se pudo obtener el token de Shopify: ' + err.message)}`);
  }

  // ── Guardar en data_sources ──────────────────────────────────────
  try {
    await upsertShopifyDataSource(orgId, shop, accessToken);
  } catch (err) {
    console.error('[ShopifyOAuth] Error guardando en DB:', err.message);
    return res.redirect(`${FRONTEND}?shopify_error=${encodeURIComponent('Token obtenido pero error guardando en DB')}`);
  }

  console.log(`[ShopifyOAuth] ✅ Tienda ${shop} conectada para org ${orgId}`);

  // ── Redirigir al frontend con éxito ─────────────────────────────
  res.redirect(`${FRONTEND}?shopify_success=1&shop=${encodeURIComponent(shop)}`);
});

/**
 * GET /shopify-oauth/status
 * Devuelve el estado de la conexión Shopify para la org autenticada.
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ connected: false });
    res.json({
      connected: true,
      shop: ds.config?.storeUrl || ds.name,
      connectedAt: ds.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /shopify-oauth/disconnect
 * Desconecta Shopify: limpia el access token y marca como desconectado.
 * No borra el row para no romper FK con la tabla agents.
 */
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    await getPool().query(
      `UPDATE data_sources
       SET status = 'pending',
           config = jsonb_set(config::jsonb, '{accessToken}', 'null'::jsonb)::text,
           last_sync_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND type = 'shopify'`,
      [req.orgId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper: upsert del data source Shopify ──────────────────────

async function upsertShopifyDataSource(orgId, shop, accessToken) {
  const pool  = getPool();
  const config = JSON.stringify({ storeUrl: shop, accessToken });

  // Verificar si ya existe un data source de Shopify para esta org
  const { rows } = await pool.query(
    "SELECT id FROM data_sources WHERE organization_id = $1 AND type = 'shopify' LIMIT 1",
    [orgId]
  );

  if (rows.length > 0) {
    // Actualizar el existente
    await pool.query(
      `UPDATE data_sources
       SET name = $1, config = $2, status = 'connected', last_sync_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [shop, config, rows[0].id]
    );
  } else {
    // Crear nuevo
    await pool.query(
      `INSERT INTO data_sources (organization_id, type, name, config, status)
       VALUES ($1, 'shopify', $2, $3, 'connected')`,
      [orgId, shop, config]
    );
  }
}

module.exports = router;
