const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const db = require('../db/database');
const { getPool } = db;
const { requireAuth, requireRole, JWT_SECRET } = require('../middleware/auth');
const meta = require('../services/meta-platform');
const { summarizeInsights } = require('../services/ad-attribution');

const router = express.Router();
const SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata',
  'pages_messaging', 'pages_manage_posts',
  'instagram_basic', 'instagram_manage_messages', 'instagram_content_publish',
  'ads_read', 'ads_management', 'business_management',
  'whatsapp_business_management', 'whatsapp_business_messaging',
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

async function fetchWhatsappAssets(userToken) {
  const businesses = await meta.graphGet('me/businesses', userToken, { fields: 'id,name', limit: 100 });
  const accounts = new Map();
  for (const business of businesses.data || []) {
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      try {
        const result = await meta.graphGet(`${business.id}/${edge}`, userToken, {
          fields: 'id,name,currency,timezone_id', limit: 100,
        });
        for (const account of result.data || []) {
          if (!accounts.has(account.id)) accounts.set(account.id, { ...account, business_id: business.id, business_name: business.name, phone_numbers: [] });
        }
      } catch (error) {
        console.warn(`[Meta] No se pudo consultar ${edge} de ${business.id}:`, meta.graphError(error));
      }
    }
  }
  for (const account of accounts.values()) {
    try {
      const phones = await meta.graphGet(`${account.id}/phone_numbers`, userToken, {
        fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status', limit: 100,
      });
      account.phone_numbers = phones.data || [];
    } catch (error) {
      console.warn(`[Meta] No se pudieron listar números de WABA ${account.id}:`, meta.graphError(error));
    }
  }
  return [...accounts.values()];
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
  let whatsappAccounts = [];
  let whatsappError = null;
  try {
    whatsappAccounts = await fetchWhatsappAssets(userToken);
  } catch (error) {
    whatsappError = meta.graphError(error);
    console.warn('[Meta] No se pudieron listar cuentas de WhatsApp:', whatsappError);
  }
  return { profile, pages: pages.data || [], adAccounts: adAccounts.data || [], whatsappAccounts, whatsappError };
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
        })), adAccounts: assets.adAccounts, whatsappAccounts: assets.whatsappAccounts }), expiresAt]
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
    res.json({
      pages: assets.pages.map(p => ({ id: p.id, name: p.name, tasks: p.tasks, instagram: p.instagram_business_account || null })),
      adAccounts: assets.adAccounts,
      whatsappAccounts: assets.whatsappAccounts,
      whatsappError: assets.whatsappError,
    });
  } catch (error) { res.status(502).json({ error: meta.graphError(error) }); }
});

router.post('/whatsapp/activate', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const wabaId = String(req.body.businessAccountId || '').trim();
    const phoneId = String(req.body.phoneNumberId || '').trim();
    if (!wabaId || !phoneId) return res.status(400).json({ error: 'Selecciona una cuenta de WhatsApp Business y un número' });

    const connection = await getConnection(req.orgId, true);
    if (!connection || connection.status !== 'connected') return res.status(400).json({ error: 'Conecta Meta antes de activar WhatsApp Business' });
    const token = meta.decryptToken(connection.user_access_token);
    const accounts = await fetchWhatsappAssets(token);
    const account = accounts.find(item => String(item.id) === wabaId);
    const phone = account?.phone_numbers?.find(item => String(item.id) === phoneId);
    if (!account || !phone) return res.status(400).json({ error: 'El número seleccionado no pertenece a los activos autorizados' });

    // Suscribe el WABA a los webhooks de esta app. La URL y el token de
    // verificación se configuran una sola vez en Meta for Developers.
    await meta.graphPost(`${wabaId}/subscribed_apps`, token);
    const existing = await db.getWhatsappConfig(req.orgId);
    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || existing?.webhook_verify_token || crypto.randomBytes(24).toString('hex');
    await db.upsertWhatsappConfig(req.orgId, {
      provider: 'meta',
      phoneNumberId: phoneId,
      businessAccountId: wabaId,
      accessToken: token,
      webhookVerifyToken: verifyToken,
      displayPhoneNumber: String(phone.display_phone_number || '').replace(/\D/g, '') || null,
    });

    res.json({
      success: true,
      message: `WhatsApp Business activado · ${phone.verified_name || phone.display_phone_number || phoneId}`,
      data: {
        businessAccountId: wabaId,
        businessAccountName: account.name || null,
        phoneNumberId: phoneId,
        displayPhoneNumber: phone.display_phone_number || null,
        webhookUrl: `${publicUrl()}/webhook`,
        webhookVerifyToken: verifyToken,
      },
    });
  } catch (error) {
    res.status(502).json({ error: meta.graphError(error) });
  }
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

function validDate(value, fallback) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

router.get('/ads/analytics', async (req, res) => {
  try {
    const connection = await getConnection(req.orgId, true);
    if (!connection?.ad_account_id) return res.status(400).json({ error: 'Selecciona una cuenta publicitaria' });
    const token = meta.decryptToken(connection.user_access_token);
    const today = new Date().toISOString().slice(0, 10);
    const defaultSince = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const since = validDate(req.query.since, defaultSince);
    const until = validDate(req.query.until, today);
    if (since > until) return res.status(400).json({ error: 'El rango de fechas no es válido' });

    const insightFields = 'spend,impressions,reach,clicks,inline_link_clicks,ctr,cpc,cpm,actions,date_start,date_stop';
    const [account, accountResult, campaignResult, campaignList, adList] = await Promise.all([
      meta.graphGet(connection.ad_account_id, token, {
        fields: 'id,account_id,name,currency,timezone_name,account_status',
      }),
      meta.graphGet(`${connection.ad_account_id}/insights`, token, {
        fields: insightFields,
        time_range: JSON.stringify({ since, until }), level: 'account',
      }),
      meta.graphGet(`${connection.ad_account_id}/insights`, token, {
        fields: `campaign_id,campaign_name,${insightFields}`,
        time_range: JSON.stringify({ since, until }), level: 'campaign', limit: 200,
      }),
      meta.graphGet(`${connection.ad_account_id}/campaigns`, token, {
        fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', limit: 200,
      }),
      meta.graphGet(`${connection.ad_account_id}/ads`, token, {
        fields: 'id,name,status,effective_status,campaign_id,adset_id', limit: 500,
      }),
    ]);

    const campaignState = new Map((campaignList.data || []).map(item => [String(item.id), item]));
    const campaigns = (campaignResult.data || []).map(row => ({
      id: String(row.campaign_id),
      name: row.campaign_name || campaignState.get(String(row.campaign_id))?.name || row.campaign_id,
      status: campaignState.get(String(row.campaign_id))?.status || null,
      effectiveStatus: campaignState.get(String(row.campaign_id))?.effective_status || null,
      objective: campaignState.get(String(row.campaign_id))?.objective || null,
      metrics: summarizeInsights(row),
    }));

    const { rows: attributionRows } = await getPool().query(`
      WITH first_attribution AS (
        SELECT DISTINCT ON (a.conversation_id)
          a.id,a.conversation_id,a.source_id,a.source_type,a.ctwa_clid,a.headline,a.attributed_at
        FROM ad_conversation_attributions a
        WHERE a.organization_id=$1
          AND (a.source_type='ad' OR a.source_type IS NULL)
          AND a.attributed_at >= $2::date
          AND a.attributed_at < ($3::date + INTERVAL '1 day')
        ORDER BY a.conversation_id,a.attributed_at ASC
      )
      SELECT a.*,c.contact_name,c.phone_number,
             first_message.content AS first_message,
             ord.id AS order_id,ord.status AS order_status,ord.total_price AS order_total,
             ord.created_at AS order_created_at
      FROM first_attribution a
      JOIN conversations c ON c.id=a.conversation_id AND c.organization_id=$1
      LEFT JOIN LATERAL (
        SELECT m.content FROM messages m
        WHERE m.conversation_id=a.conversation_id AND m.direction='inbound'
          AND m.created_at >= (a.attributed_at AT TIME ZONE 'UTC')
        ORDER BY m.created_at ASC LIMIT 1
      ) first_message ON TRUE
      LEFT JOIN LATERAL (
        SELECT o.id,o.status,o.total_price,o.created_at FROM orders o
        WHERE o.organization_id=$1 AND o.conversation_id=a.conversation_id
          AND o.status <> 'cancelled'
          AND o.created_at >= (a.attributed_at AT TIME ZONE 'UTC')
          AND o.created_at < (a.attributed_at AT TIME ZONE 'UTC') + INTERVAL '30 days'
        ORDER BY o.created_at ASC LIMIT 1
      ) ord ON TRUE
      ORDER BY a.attributed_at DESC
      LIMIT 500`, [req.orgId, since, until]);

    const ads = adList.data || [];
    const adsById = new Map(ads.map(item => [String(item.id), item]));
    const campaignNames = new Map([
      ...(campaignList.data || []).map(item => [String(item.id), item.name]),
      ...(campaignResult.data || []).map(item => [String(item.campaign_id), item.campaign_name]),
    ]);
    const conversations = attributionRows.map(row => {
      const ad = adsById.get(String(row.source_id));
      return {
        conversationId: row.conversation_id,
        contactName: row.contact_name,
        phoneNumber: row.phone_number,
        firstMessage: row.first_message,
        attributedAt: row.attributed_at,
        sourceId: row.source_id,
        adName: ad?.name || row.headline || null,
        campaignId: ad?.campaign_id || null,
        campaignName: ad?.campaign_id ? campaignNames.get(String(ad.campaign_id)) || null : null,
        orderId: row.order_id,
        orderStatus: row.order_status,
        orderTotal: row.order_total,
        orderCreatedAt: row.order_created_at,
      };
    });
    const orders = conversations.filter(item => item.orderId);
    const revenue = orders.reduce((sum, item) => sum + Number(String(item.orderTotal || '0').replace(',', '.')) || sum, 0);
    const { rows: [tracking] } = await getPool().query(
      'SELECT MIN(attributed_at) AS since FROM ad_conversation_attributions WHERE organization_id=$1',
      [req.orgId]
    );

    res.json({
      since, until,
      account: {
        id: account.id || connection.ad_account_id,
        accountId: account.account_id || String(connection.ad_account_id).replace(/^act_/, ''),
        name: account.name || connection.ad_account_name,
        currency: account.currency || 'CLP',
        timezone: account.timezone_name || null,
      },
      summary: summarizeInsights(accountResult.data?.[0] || {}),
      campaigns,
      crm: {
        conversations: conversations.length,
        orders: orders.length,
        revenue,
        conversionRate: conversations.length ? (orders.length / conversations.length) * 100 : 0,
        trackingSince: tracking?.since || null,
        rows: conversations,
      },
    });
  } catch (error) {
    res.status(502).json({ error: meta.graphError(error) });
  }
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
