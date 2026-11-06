// WhatsApp may use an app owned by the portfolio that owns the phone number.
// Keep the social app's credentials separate and reject incomplete overrides.
function getWhatsAppApp(env = process.env) {
  const dedicated = Boolean(env.META_WHATSAPP_APP_ID || env.META_WHATSAPP_APP_SECRET);
  const appId = dedicated ? env.META_WHATSAPP_APP_ID : env.META_APP_ID;
  const appSecret = dedicated ? env.META_WHATSAPP_APP_SECRET : env.META_APP_SECRET;
  if (dedicated && (!/^\d+$/.test(appId || '') || !appSecret)) {
    throw Object.assign(new Error('Completa la configuración de la aplicación propia de WhatsApp en el servidor'), { status: 503 });
  }
  return { appId, appSecret, dedicated };
}

module.exports = { getWhatsAppApp };
