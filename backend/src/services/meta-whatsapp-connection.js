const db = require('../db/database');
const meta = require('./meta-platform');
const { getWhatsAppApp } = require('./meta-whatsapp-app');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function verifyWebhookSetup({ appId, appSecret: secret }) {
  const publicUrl = process.env.CRM_PUBLIC_URL;
  if (!/^\d+$/.test(appId || '') || !secret || !publicUrl?.startsWith('https://')) {
    throw fail('Configura la app Meta y la URL pública del backend antes de activar WhatsApp', 503);
  }
  const subscriptions = await meta.graphGet(`${appId}/subscriptions`, `${appId}|${secret}`, {}, { appSecret: secret });
  const callback = `${publicUrl.replace(/\/$/, '')}/webhook`;
  const ready = subscriptions.data?.some(item => item.object === 'whatsapp_business_account'
    && item.active === true && item.callback_url === callback
    && item.fields?.some(field => (typeof field === 'string' ? field : field.name) === 'messages'));
  if (!ready) throw fail('Configura y verifica el webhook de WhatsApp y suscribe el campo messages en Meta antes de cambiar la conexión', 409);
}

// Both existing setup entry points validate first. A failed authorization must
// never replace a working Kapso connection or silently select another number.
async function activate(orgId, { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken }) {
  if (typeof phoneNumberId !== 'string' || !/^\d{5,30}$/.test(phoneNumberId)
      || typeof businessAccountId !== 'string' || !/^\d{5,30}$/.test(businessAccountId)
      || typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 4096
      || typeof webhookVerifyToken !== 'string' || !webhookVerifyToken.trim() || webhookVerifyToken.length > 256) {
    throw fail('Completa los identificadores de WhatsApp, el token de acceso y el token de verificación');
  }
  const app = getWhatsAppApp();
  if (!app.appSecret) throw fail('Configura el secreto de la app Meta para autenticar mensajes entrantes', 503);
  const existing = await db.getWhatsappConfig(orgId);
  if (existing?.provider === 'kapso' && String(existing.phone_number_id) !== phoneNumberId) {
    throw fail('Para conservar los chats, selecciona el mismo número que está conectado con Kapso', 409);
  }
  const owner = await db.getOrgByPhoneNumberId(phoneNumberId);
  if (owner && String(owner.org.id) !== String(orgId)) throw fail('Este número ya está conectado a otra tienda', 409);

  const graphOptions = { appSecret: app.appSecret };
  if (app.dedicated) {
    const { data: token } = await meta.graphGet('debug_token', `${app.appId}|${app.appSecret}`, { input_token: accessToken }, graphOptions);
    if (!token?.is_valid || String(token.app_id) !== app.appId || token.type !== 'SYSTEM_USER'
        || token.expires_at !== 0
        || !['whatsapp_business_management', 'whatsapp_business_messaging'].every(scope => token.scopes?.includes(scope))) {
      throw fail('Usa un token permanente de usuario del sistema de la aplicación propia de WhatsApp, con permisos de mensajería y administración');
    }
  }

  let phone, after;
  const cursors = new Set();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await meta.graphGet(`${businessAccountId}/phone_numbers`, accessToken, {
      fields: 'id,display_phone_number,verified_name', limit: 100, ...(after ? { after } : {}),
    }, graphOptions);
    phone = page.data?.find(item => String(item.id) === phoneNumberId);
    const next = page.paging?.next && page.paging?.cursors?.after;
    if (phone || !next || cursors.has(next)) break;
    cursors.add(next);
    after = next;
  }
  if (!phone) throw fail('El token no tiene acceso al número dentro de la cuenta de WhatsApp seleccionada');

  await verifyWebhookSetup(app);
  const subscription = await meta.graphPost(`${businessAccountId}/subscribed_apps`, accessToken, {}, graphOptions);
  if (subscription?.success !== true) throw fail('Meta no confirmó la suscripción de mensajes. La conexión actual sigue activa', 502);
  await db.upsertWhatsappConfig(orgId, {
    provider: 'meta', phoneNumberId, businessAccountId, accessToken, webhookVerifyToken,
    displayPhoneNumber: String(phone.display_phone_number || '').replace(/\D/g, '') || null,
  });
  return phone;
}

module.exports = { activate };
