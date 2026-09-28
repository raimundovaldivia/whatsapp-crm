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

module.exports = {
  normalizeInboundText,
  isLikelyAutomaticReply,
  isGiftedStockReply,
};
