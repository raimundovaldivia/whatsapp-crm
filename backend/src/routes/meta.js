const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { getPool } = require('../db/database');
const { requireAuth, requireRole, JWT_SECRET } = require('../middleware/auth');
const meta = require('../services/meta-platform');

const router = express.Router();
const SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata',
  'pages_messaging', 'pages_manage_posts',
  'instagram_basic', 'instagram_manage_messages', 'instagram_content_publish',
  'ads_read', 'ads_management', 'business_management',
];

function publicUrl() {
  return (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
}

function callbackUrl() {
  const origin = publicUrl();
  if (!origin) throw new Error('Falta configurar CRM_PUBLIC_URL');
  return `${origin}/meta-oauth/callback`;
}

async function getConnection(orgId, includeSecrets = false) {
  const fields = includeSecrets ? '*' : `id, organization_id, facebook_user_name, page_id, page_name,
    instagram_account_id, instagram_username, ad_account_id, ad_account_name, scopes, status,
    token_expires_at, last_error, created_at, updated_at`;
  const { rows } = await getPool().query(`SELECT ${fields} FROM meta_connections WHERE organization_id = $1`, [orgId]);
  return rows[0] || null;
}

async function fetchAssets(userToken) {
  const profile = await meta.graphGet('me', userToken, { fields: 'id,name' });
  const pages = await meta.graphGet('me/accounts', userToken, {
    fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name,profile_picture_url}',
    limit: 100,
  });
  let adAccounts = { data: [] };
  try {
    adAccounts = await meta.graphGet('me/adaccounts', userToken, {
      fields: 'id,account_id,name,account_status,currency,timezone_name', limit: 100,
    });
  } catch (error) {
    console.warn('[Meta] No se pudieron listar cuentas publicitarias:', meta.graphError(error));
  }
  return { profile, pages: pages.data || [], adAccounts: adAccounts.data || [] };
}

// Callback público: Meta redirige aquí después del login.
router.get('/callback', async (req, res) => {
  let state;
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    state = jwt.verify(req.query.state, JWT_SECRET, { algorithms: ['HS256'], audience: 'meta-oauth' });
    const appId = meta.requiredEnv('META_APP_ID');
    const appSecret = meta.requiredEnv('META_APP_SECRET');
    const short = await axios.get(`${meta.GRAPH_URL}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, redirect_uri: callbackUrl(), code: req.query.code },
      timeout: 20000,
    });
    const long = await axios.get(`${meta.GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret,
        fb_exchange_token: short.data.access_token,
      }, timeout: 20000,
    });
    const userToken = long.data.access_token;
    const assets = await fetchAssets(userToken);
    const page = assets.pages.find(p => p.instagram_business_account) || assets.pages[0] || null;
    const instagram = page?.instagram_business_account || null;
    const adAccount = assets.adAccounts[0] || null;
    const expiresAt = long.data.expires_in ? new Date(Date.now() + Number(long.data.expires_in) * 1000) : null;

    await getPool().query(
      `INSERT INTO meta_connections (
         organization_id, facebook_user_id, facebook_user_name, user_access_token, page_id, page_name,
         page_access_token, instagram_account_id, instagram_username, ad_account_id, ad_account_name,
         scopes, available_assets, status, token_expires_at, last_error, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'connected',$14,NULL,NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         facebook_user_id=EXCLUDED.facebook_user_id, facebook_user_name=EXCLUDED.facebook_user_name,
         user_access_token=EXCLUDED.user_access_token, page_id=EXCLUDED.page_id, page_name=EXCLUDED.page_name,
         page_access_token=EXCLUDED.page_access_token, instagram_account_id=EXCLUDED.instagram_account_id,
         instagram_username=EXCLUDED.instagram_username, ad_account_id=EXCLUDED.ad_account_id,
         ad_account_name=EXCLUDED.ad_account_name, scopes=EXCLUDED.scopes,
         available_assets=EXCLUDED.available_assets, status='connected', token_expires_at=EXCLUDED.token_expires_at,
         last_error=NULL, updated_at=NOW()`,
      [state.orgId, assets.profile.id, assets.profile.name, meta.encryptToken(userToken), page?.id || null,
        page?.name || null, meta.encryptToken(page?.access_token), instagram?.id || null, instagram?.username || null,
        adAccount?.id || null, adAccount?.name || null, SCOPES, JSON.stringify({ pages: assets.pages.map(p => ({
          id: p.id, name: p.name, tasks: p.tasks, instagram: p.instagram_business_account || null,
        })), adAccounts: assets.adAccounts }), expiresAt]
    );

    if (page?.id && page?.access_token) {
      await meta.graphPost(`${page.id}/subscribed_apps`, page.access_token, {
        subscribed_fields: 'messages,messaging_postbacks,feed',
      }).catch(error => console.warn('[Meta] Suscripción webhook Page:', meta.graphError(error)));
    }
    res.redirect(`${frontendUrl()}/?meta_success=1`);
  } catch (error) {
    console.error('[Meta OAuth]', meta.graphError(error));
    if (state?.orgId) {
      await getPool().query(
        `INSERT INTO meta_connections (organization_id,status,last_error) VALUES ($1,'error',$2)
         ON CONFLICT(organization_id) DO UPDATE SET status='error',last_error=$2,updated_at=NOW()`,
        [state.orgId, meta.graphError(error)]
      ).catch(() => {});
    }
    res.redirect(`${frontendUrl()}/?meta_error=${encodeURIComponent(meta.graphError(error))}`);
  }
});

router.use(requireAuth);

router.get('/auth-url', requireRole('owner', 'admin'), (req, res) => {
  try {
    const appId = meta.requiredEnv('META_APP_ID');
    const state = jwt.sign({ orgId: req.orgId, userId: req.userId }, JWT_SECRET, {
      algorithm: 'HS256', expiresIn: '10m', audience: 'meta-oauth',
    });
    const params = new URLSearchParams({
      client_id: appId, redirect_uri: callbackUrl(), state,
      response_type: 'code', scope: SCOPES.join(','), auth_type: 'rerequest',
    });
    res.json({ url: `https://www.facebook.com/${meta.GRAPH_VERSION}/dialog/oauth?${params}` });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

router.get('/status', async (req, res) => {
  const connection = await getConnection(req.orgId);
  res.json({ connected: connection?.status === 'connected', connection });
});

router.get('/assets', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const connection = await getConnection(req.orgId, true);
    if (!connection) return res.status(404).json({ error: 'Meta no está conectado' });
    const assets = await fetchAssets(meta.decryptToken(connection.user_access_token));
    res.json({ pages: assets.pages.map(p => ({ id: p.id, name: p.name, tasks: p.tasks, instagram: p.instagram_business_account || null })), adAccounts: assets.adAccounts });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

router.patch('/assets', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const connection = await getConnection(req.orgId, true);
    if (!connection) return res.status(404).json({ error: 'Meta no está conectado' });
    const assets = await fetchAssets(meta.decryptToken(connection.user_access_token));
    const page = assets.pages.find(p => p.id === String(req.body.pageId));
    const ad = assets.adAccounts.find(a => a.id === String(req.body.adAccountId));
    if (req.body.pageId && !page) return res.status(400).json({ error: 'Página no autorizada' });
    if (req.body.adAccountId && !ad) return res.status(400).json({ error: 'Cuenta publicitaria no autorizada' });
    const ig = page?.instagram_business_account || null;
    await getPool().query(
      `UPDATE meta_connections SET page_id=$1,page_name=$2,page_access_token=$3,
       instagram_account_id=$4,instagram_username=$5,ad_account_id=$6,ad_account_name=$7,updated_at=NOW()
       WHERE organization_id=$8`,
      [page?.id || null, page?.name || null, meta.encryptToken(page?.access_token), ig?.id || null,
        ig?.username || null, ad?.id || null, ad?.name || null, req.orgId]
    );
    res.json({ connection: await getConnection(req.orgId) });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

router.delete('/connection', requireRole('owner', 'admin'), async (req, res) => {
  await getPool().query('DELETE FROM meta_connections WHERE organization_id=$1', [req.orgId]);
  res.json({ success: true });
});

router.get('/threads', async (req, res) => {
  const { rows } = await getPool().query(
    `SELECT t.*, (SELECT content FROM meta_messages m WHERE m.thread_id=t.id ORDER BY m.created_at DESC LIMIT 1) last_message
       FROM meta_threads t WHERE t.organization_id=$1 ORDER BY t.last_message_at DESC LIMIT 100`, [req.orgId]
  );
  res.json({ threads: rows });
});

router.get('/threads/:id/messages', async (req, res) => {
  const { rows } = await getPool().query(
    `SELECT m.* FROM meta_messages m JOIN meta_threads t ON t.id=m.thread_id
      WHERE m.thread_id=$1 AND t.organization_id=$2 ORDER BY m.created_at ASC LIMIT 200`,
    [Number(req.params.id), req.orgId]
  );
  res.json({ messages: rows });
});

router.post('/threads/:id/messages', async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
    const { rows: [thread] } = await getPool().query('SELECT * FROM meta_threads WHERE id=$1 AND organization_id=$2', [Number(req.params.id), req.orgId]);
    if (!thread) return res.status(404).json({ error: 'Conversación no encontrada' });
    const connection = await getConnection(req.orgId, true);
    const token = meta.decryptToken(connection.page_access_token);
    const result = await meta.graphPost(`${connection.page_id}/messages`, token, {
      recipient: { id: thread.external_user_id }, message: { text },
    });
    const { rows: [message] } = await getPool().query(
      `INSERT INTO meta_messages(thread_id,external_message_id,direction,content,status,sent_by)
       VALUES($1,$2,'outbound',$3,'sent','human') RETURNING *`,
      [thread.id, result.message_id || null, text]
    );
    await getPool().query('UPDATE meta_threads SET last_message_at=NOW(),updated_at=NOW() WHERE id=$1', [thread.id]);
    res.json({ message });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

router.get('/ads/insights', async (req, res) => {
  try {
    const connection = await getConnection(req.orgId, true);
    if (!connection?.ad_account_id) return res.status(400).json({ error: 'Selecciona una cuenta publicitaria' });
    const token = meta.decryptToken(connection.user_access_token);
    const since = req.query.since || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const until = req.query.until || new Date().toISOString().slice(0, 10);
    const data = await meta.graphGet(`${connection.ad_account_id}/insights`, token, {
      fields: 'account_name,spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values',
      time_range: JSON.stringify({ since, until }), level: 'account',
    });
    res.json({ since, until, insights: data.data?.[0] || null });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

router.get('/ads/campaigns', async (req, res) => {
  try {
    const connection = await getConnection(req.orgId, true);
    if (!connection?.ad_account_id) return res.status(400).json({ error: 'Selecciona una cuenta publicitaria' });
    const token = meta.decryptToken(connection.user_access_token);
    const data = await meta.graphGet(`${connection.ad_account_id}/campaigns`, token, {
      fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,insights.date_preset(last_30d){spend,impressions,reach,clicks,ctr}',
      limit: 50,
    });
    res.json({ campaigns: data.data || [] });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

async function waitUntilMediaReady(containerId, token) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const status = await meta.graphGet(containerId, token, { fields: 'status_code,status' });
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw new Error(status.status || 'Meta no pudo procesar el video');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('El video sigue procesándose en Meta; inténtalo nuevamente en unos minutos');
}

router.post('/publish', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { platform, message, mediaUrl, mediaType = 'image' } = req.body;
    const connection = await getConnection(req.orgId, true);
    if (!connection) return res.status(400).json({ error: 'Meta no está conectado' });
    const pageToken = meta.decryptToken(connection.page_access_token);
    if (platform === 'facebook') {
      if (!connection.page_id) return res.status(400).json({ error: 'Selecciona una página de Facebook' });
      const isVideo = mediaType === 'video' || mediaType === 'reel';
      const endpoint = mediaUrl ? `${connection.page_id}/${isVideo ? 'videos' : 'photos'}` : `${connection.page_id}/feed`;
      const result = await meta.graphPost(endpoint, pageToken, mediaUrl
        ? (isVideo ? { file_url: mediaUrl, description: message || '' } : { url: mediaUrl, caption: message || '' })
        : { message });
      return res.json({ success: true, id: result.post_id || result.id });
    }
    if (platform === 'instagram') {
      if (!connection.instagram_account_id || !mediaUrl) return res.status(400).json({ error: 'Instagram requiere una cuenta profesional y una URL pública de imagen o video' });
      const isVideo = mediaType === 'video' || mediaType === 'reel';
      const container = await meta.graphPost(`${connection.instagram_account_id}/media`, pageToken, {
        ...(isVideo ? { video_url: mediaUrl, media_type: mediaType === 'reel' ? 'REELS' : 'VIDEO' } : { image_url: mediaUrl }),
        caption: message || '',
      });
      if (isVideo) await waitUntilMediaReady(container.id, pageToken);
      const result = await meta.graphPost(`${connection.instagram_account_id}/media_publish`, pageToken, { creation_id: container.id });
      return res.json({ success: true, id: result.id });
    }
    res.status(400).json({ error: 'Plataforma inválida' });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

module.exports = router;
module.exports.SCOPES = SCOPES;
