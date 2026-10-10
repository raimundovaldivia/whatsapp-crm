const path = require('node:path');
const db = require('../db/database');
const r2 = require('./r2-storage');
const mediaCache = require('./media-cache');
const whatsappProvider = require('./whatsapp-provider');

const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
]);

function safeFileName(value, mimeType) {
  const fallback = mimeType.startsWith('image/') ? 'foto.jpg' : 'archivo';
  const clean = path.basename(String(value || fallback))
    .normalize('NFKC')
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

function decodePayload({ data, mimeType, fileName, caption }) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    const error = new Error('Formato no permitido. Usa JPG, PNG, WEBP, PDF, Word, Excel, CSV o TXT.');
    error.status = 400;
    error.code = 'UNSUPPORTED_MEDIA';
    throw error;
  }
  const raw = String(data || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    const error = new Error('El archivo no es válido'); error.status = 400; throw error;
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) { const error = new Error('El archivo está vacío'); error.status = 400; throw error; }
  if (buffer.length > MAX_MEDIA_BYTES) {
    const error = new Error('El archivo supera el máximo de 6 MB'); error.status = 413; error.code = 'FILE_TOO_LARGE'; throw error;
  }
  const type = mime.startsWith('image/') ? 'image' : 'document';
  return {
    buffer,
    mimeType: mime,
    fileName: safeFileName(fileName, mime),
    caption: String(caption || '').trim().slice(0, 1000),
    type,
  };
}

async function send({ orgId, conversation, payload, config, sentBy = 'human', agentType = null }) {
  const media = decodePayload(payload);
  const directUpload = ['kapso', 'meta'].includes(String(config?.provider || 'meta').toLowerCase());
  let mediaUrl = null;
  if (r2.isConfigured()) {
    try {
      mediaUrl = await r2.uploadBuffer(media.buffer, media.fileName, media.mimeType, `chat/${orgId}`);
    } catch (err) {
      // Kapso y Meta aceptan el archivo directamente. La copia para el CRM no
      // debe impedir que la foto llegue al cliente.
      if (!directUpload) throw err;
      console.warn('[OutboundMedia] No se pudo guardar la copia pública; se usará la carga directa:', err.message);
    }
  }
  const result = await whatsappProvider.sendMediaMessage(
    conversation.phone_number,
    { ...media, mediaUrl: directUpload ? null : mediaUrl },
    config,
  );
  const mediaReference = mediaUrl || result?.uploadedMediaId;
  if (!mediaReference) throw new Error('No se pudo registrar el archivo enviado');
  if (!mediaUrl) mediaCache.set(`${orgId}:${mediaReference}`, media.buffer, media.mimeType);
  const content = media.type === 'image'
    ? (media.caption || '📷 Foto')
    : `📎 ${media.fileName}${media.caption ? `\n${media.caption}` : ''}`;
  const message = await db.saveMessage({
    conversationId: conversation.id,
    whatsappMessageId: whatsappProvider.messageId(result),
    direction: 'outbound',
    content,
    type: media.type,
    status: 'sent',
    sentBy,
    agentType,
    mediaId: mediaReference,
  });
  if (message) {
    await db.saveMessageMediaBlob(orgId, message.id, media.buffer, media.mimeType).catch(err => {
      // El archivo ya fue aceptado por WhatsApp: una falla de la copia local
      // nunca debe hacer que la interfaz sugiera reenviarlo y lo duplique.
      console.warn('[OutboundMedia] No se pudo conservar la copia:', err.message);
    });
  }
  await db.updateConversationLastMessage(conversation.id, content);
  return { message, mediaUrl: mediaReference, media };
}

module.exports = { MAX_MEDIA_BYTES, ALLOWED_MIME_TYPES, safeFileName, decodePayload, send };
