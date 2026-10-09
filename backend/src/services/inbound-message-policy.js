function normalizeInboundText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const HIGH_CONFIDENCE_AUTOREPLY_PATTERNS = [
  /^gracias por comunicarte con .{2,80}[.!]? ¿?(como|en que) podemos ayudarte\??$/,
  /^gracias por (escribirnos|contactarnos|tu mensaje)[.!]? ¿?(como|en que) podemos ayudarte\??$/,
  /^hemos recibido tu mensaje[.!]? (te responderemos|nos pondremos en contacto|pronto te responderemos).{0,100}$/,
  /^gracias por tu mensaje[.!]? en este momento no (podemos|estamos disponibles).{0,140}$/,
  /^este es un mensaje autom[aá]tico.{0,180}$/,
];

function isLikelyAutomaticReply(value) {
  const text = normalizeInboundText(value);
  if (!text || text.length > 260) return false;
  return HIGH_CONFIDENCE_AUTOREPLY_PATTERNS.some(pattern => pattern.test(text));
}

function isGiftedStockReply(value) {
  const text = normalizeInboundText(value);
  return /\bme\s+(regalaron|dieron|trajeron)\b.{0,80}\b(huev|producto|mercaderia|mercancia|comida)/.test(text);
}

/**
 * Un enlace compartido sin una pregunta o instrucción no expresa una intención
 * suficiente para vender, escalar o reactivar campañas. Se permiten alrededor
 * del enlace espacios, signos y emojis, pero no palabras ni números.
 */
function isBareLinkMessage(value) {
  const text = String(value || '').trim();
  if (!text) return false;

  const urlPattern = /(?:https?:\/\/|www\.)[^\s<>()]+/giu;
  if (!urlPattern.test(text)) return false;

  const remainder = text
    .replace(urlPattern, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

  return remainder.length === 0;
}

// Only acknowledgements after a closed statement, never answers to questions.
function isClosingAcknowledgement(value, history = [], state) {
  if (!['scheduled', 'confirmed', 'awaiting_payment', 'delivered'].includes(state)) return false;
  const acknowledgement = String(value || '').replace(/[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\s]/gu, '');
  if (!/^(?:👌|👍|🙏|✅|🙌|😊|🙂|❤️|❤)+$/u.test(acknowledgement)) return false;
  const lastOutbound = [...history].reverse().find(message => message.direction === 'outbound');
  const text = lastOutbound?.content || '';
  if (!text || /[?¿]/.test(text)) return false;
  return /(?:anotado|agendado|pedido confirmado|pedido registrado|listo|gracias|buen[a-z]* (?:dia|día|semana|tarde|noche))/i.test(text);
}

function isInternalSilenceResponse(value) {
  const text = normalizeInboundText(value).replace(/^[\s*`]+/, '');
  return /^(?:\[?no_response\]?|\[?silence\]?)$/.test(text)
    || /^(?:no respondo|no respondere|no responder|no debo responder|no es necesario responder|no se requiere respuesta|sin respuesta)(?:[. :;!]|$)/.test(text)
    || /^el cliente solo (?:confirmo|agradecio|envio un emoji)/.test(text)
    || /^el ultimo mensaje esta incompleto\. espero el resto/.test(text);
}

module.exports = {
  isClosingAcknowledgement,
  isInternalSilenceResponse,
  normalizeInboundText,
  isLikelyAutomaticReply,
  isGiftedStockReply,
  isBareLinkMessage,
};
