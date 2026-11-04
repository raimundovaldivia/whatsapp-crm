const axios = require('axios');

const { GRAPH_URL: BASE_URL } = require('./meta-platform');
const { downloadMedia } = require('./safe-media');

function requestOptions(config) {
  if (!config?.access_token || !/^\d+$/.test(config.phone_number_id || '')) throw new Error('Falta conexión con Meta');
  return { headers: { Authorization: `Bearer ${config.access_token}` }, timeout: 20000 };
}

async function postMessage(config, payload) {
  const accountId = config?.business_account_id;
  if (accountId && !/^\d+$/.test(accountId)) throw new Error('Cuenta de mensajes de Meta inválida');
  // Explicit billing/template scope when the same number has several integrations.
  const body = accountId ? { ...payload, messaging_account_id: accountId } : payload;
  try {
    const response = await axios.post(`${BASE_URL}/${config.phone_number_id}/messages`, body, requestOptions(config));
    return response.data;
  } catch (error) {
    if (Number(error.response?.data?.error?.code) === 131047) error.is24hWindow = true;
    throw error;
  }
}

/**
 * Envía texto usando las credenciales de la organización
 */
async function sendTextMessage(toPhone, text, whatsappConfig) {
  return postMessage(whatsappConfig,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'text',
      text: { body: text },
    }
  );
}

async function sendMediaMessage(toPhone, media, whatsappConfig) {
  const { phone_number_id } = whatsappConfig;
  const type = media.type === 'image' ? 'image' : 'document';
  let uploadedMediaId = null;
  if (!media.mediaUrl) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([media.buffer], { type: media.mimeType }), media.fileName);
    const upload = await axios.post(`${BASE_URL}/${phone_number_id}/media`, form, {
      ...requestOptions(whatsappConfig),
    });
    uploadedMediaId = upload.data?.id;
    if (!uploadedMediaId) throw new Error('Meta no devolvió el identificador del archivo');
  }
  const content = media.mediaUrl ? { link: media.mediaUrl } : { id: uploadedMediaId };
  if (media.caption) content.caption = media.caption;
  if (type === 'document' && media.fileName) content.filename = media.fileName;
  const response = await postMessage(whatsappConfig,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to: toPhone, type, [type]: content });
  return { ...response, uploadedMediaId };
}

async function markAsRead(messageId, whatsappConfig) {
  const { phone_number_id } = whatsappConfig;
  try {
    await axios.post(
      `${BASE_URL}/${phone_number_id}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      requestOptions(whatsappConfig)
    );
  } catch { /* No crítico */ }
}

function parseWebhookMessage(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return null;
    const message = value.messages[0];
    if (typeof message.id !== 'string' || !/^\d{7,15}$/.test(message.from || '')) return null;
    if (['reaction', 'sticker', 'system'].includes(message.type)) return null;
    const contact = value?.contacts?.find(c => c.wa_id === message.from) || value?.contacts?.[0];
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    const media = ['image', 'audio', 'video', 'document'].includes(message.type) ? message[message.type] : null;
    let text = message.type === 'text' ? message.text?.body : null;
    if (message.type === 'interactive') text = reply?.title || reply?.description || null;
    if (message.type === 'button') text = message.button?.text || message.button?.payload || null;
    if (message.type === 'contacts') {
      const shared = message.contacts?.[0];
      const label = [shared?.name?.formatted_name, shared?.phones?.[0]?.phone || shared?.phones?.[0]?.wa_id].filter(Boolean).join(' ');
      text = label ? `[Contacto compartido: ${label}]` : null;
    }
    const unsupported = message.type === 'unsupported';
    if (unsupported) text = '📎 [Mensaje no compatible de WhatsApp]';
    let location = null;
    if (message.type === 'location') {
      const { latitude: lat, longitude: lng, name, address } = message.location || {};
      if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      location = { lat, lng, name, address };
    }
    const attributionService = require('./whatsapp-attribution');
    const attribution = attributionService.fromMeta?.(message) || null;
    const adReferral = require('./ad-attribution').normalizeAdReferral?.(message.referral, 'meta') || null;
    return {
      messageId: message.id,
      from: message.from,
      contactName: contact?.profile?.name || null,
      timestamp: message.timestamp,
      type: message.type,
      text: typeof text === 'string' ? text : null,
      mediaId: typeof media?.id === 'string' && /^\d+$/.test(media.id) ? media.id : null,
      mediaUrl: null,
      interactiveId: reply?.id || null,
      location,
      unsupported,
      ...(attribution ? { attribution } : {}),
      ...(adReferral ? { adReferral } : {}),
    };
  } catch { return null; }
}

function parseStatusUpdate(body) {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.statuses?.length) return null;
    const status = value.statuses[0];
    return { messageId: status.id, status: status.status, recipientId: status.recipient_id, error: status.errors || null };
  } catch { return null; }
}

async function getMediaUrl(mediaId, config) {
  if (!/^\d+$/.test(mediaId || '')) throw new Error('Identificador multimedia inválido');
  const response = await axios.get(`${BASE_URL}/${mediaId}`, {
    ...requestOptions(config), params: { phone_number_id: config.phone_number_id },
  });
  return response.data;
}

async function getTemplates(config, { all = false } = {}) {
  if (!/^\d+$/.test(config.business_account_id || '')) throw new Error('Falta la cuenta de WhatsApp Business');
  const templates = [];
  let after;
  do {
    const response = await axios.get(`${BASE_URL}/${config.business_account_id}/message_templates`, {
      ...requestOptions(config), params: { limit: 100, ...(after ? { after } : {}) },
    });
    templates.push(...(response.data?.data || []));
    const next = response.data?.paging?.next && response.data?.paging?.cursors?.after;
    if (!next || next === after) break;
    after = next;
  } while (templates.length < 10000);
  return all ? templates : templates.filter(t => t.status === 'APPROVED');
}

async function sendTemplate(to, name, languageCode = 'es', components = [], config) {
  return postMessage(config, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
    template: { name, language: { code: languageCode }, ...(components.length ? { components } : {}) },
  });
}

async function createTemplate(templateData, config) {
  if (!/^\d+$/.test(config.business_account_id || '')) throw new Error('Falta la cuenta de WhatsApp Business');
  const response = await axios.post(`${BASE_URL}/${config.business_account_id}/message_templates`, templateData, requestOptions(config));
  return response.data;
}

module.exports = { sendTextMessage, sendMediaMessage, markAsRead, parseWebhookMessage, parseStatusUpdate, getMediaUrl, downloadMedia, getTemplates, sendTemplate, createTemplate };
