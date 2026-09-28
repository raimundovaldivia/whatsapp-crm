const CUSTOMER_TIME_ZONE = 'America/Santiago';
const CUSTOMER_WINDOW_START_HOUR = 9;
const CUSTOMER_WINDOW_END_HOUR = 21;

function chileTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CUSTOMER_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

/**
 * Los mensajes automáticos hacia clientes solo salen entre las 09:00 y 20:59
 * de Chile. Intl aplica automáticamente el cambio entre horario de verano e
 * invierno, por lo que no dependemos de una diferencia UTC fija.
 */
function isCustomerMessagingHour(date = new Date()) {
  const hour = Number(chileTimeParts(date).hour);
  return hour >= CUSTOMER_WINDOW_START_HOUR && hour < CUSTOMER_WINDOW_END_HOUR;
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const CUSTOMER_PAUSED_PATTERNS = [
  /\bpor ahora[, ]+(gracias|no|nada|estoy|tengo)\b/,
  /\bpor el momento\b/,
  /\bcuando pueda\b/,
  /\bmas adelante\b/,
  /\ben otro momento\b/,
  /\b(familiar|amigo|conocido).{0,35}\bproveedor\b/,
  /\btengo.{0,35}\bproveedor\b/,
  /\b(no necesito|no requiero|estoy abastecid[oa]|tengo suficiente)\b/,
  /\bno\s+(aun|todavia)\b/,
  /\bme\s+(regalaron|dieron|trajeron)\b/,
];

const RENEWED_PURCHASE_PATTERNS = [
  /\bahora si\b/,
  /\b(quiero|necesito|deme|dame|mandame|env(i|í)ame|anotame|agregame)\b/,
  /\b(encargo|pedido)\b.{0,30}\b(hoy|ahora)\b/,
];

const STORE_CLOSED_PATTERNS = [
  /\baqui estaremos cuando (lo|la) necesites\b/,
  /\bcualquier cosa (me|nos) escribes\b/,
  /\bhasta pronto\b/,
  /\bque todo te vaya bien\b/,
];

/**
 * Evita insistir si el cliente postergó la compra o si Diva ya cerró el hilo.
 * Un nuevo mensaje de compra posterior al cierre permite que el flujo normal
 * vuelva a activarse; esta regla solo decide si corresponde un follow-up.
 */
function shouldSkipAutomatedFollowUp(history = []) {
  const recent = history.slice(-10);
  let customerPaused = false;
  for (const message of recent) {
    if (message.direction !== 'inbound') continue;
    const text = normalizeText(message.content);
    if (CUSTOMER_PAUSED_PATTERNS.some(pattern => pattern.test(text))) customerPaused = true;
    if (customerPaused && RENEWED_PURCHASE_PATTERNS.some(pattern => pattern.test(text))
        && !/\bcuando pueda\b/.test(text)) customerPaused = false;
  }

  if (customerPaused) return true;

  const lastMessage = recent.at(-1);
  if (lastMessage?.direction === 'outbound') {
    const text = normalizeText(lastMessage.content);
    if (STORE_CLOSED_PATTERNS.some(pattern => pattern.test(text))) return true;
  }

  return false;
}

module.exports = {
  CUSTOMER_TIME_ZONE,
  CUSTOMER_WINDOW_START_HOUR,
  CUSTOMER_WINDOW_END_HOUR,
  chileTimeParts,
  isCustomerMessagingHour,
  shouldSkipAutomatedFollowUp,
};
