/**
 * scheduled-orders.js
 *
 * Detecta cuando un cliente quiere pedir para una fecha futura y extrae
 * la fecha y el producto usando Claude Haiku.
 */

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Patrones en español que indican pedido futuro
const FUTURE_ORDER_PATTERNS = [
  /para\s+la\s+pr[oó]xima\s+semana/i,
  /la\s+semana\s+que\s+viene/i,
  /para\s+(el\s+)?(pr[oó]ximo\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i,
  /para\s+ma[nñ]ana/i,
  /para\s+pasado\s+ma[nñ]ana/i,
  /en\s+\d+\s+d[ií]as?/i,
  /en\s+una\s+semana/i,
  /en\s+unos\s+d[ií]as?/i,
  /no\s+es\s+para\s+ahora/i,
  /es\s+para\s+(m[aá]s\s+)?adelante/i,
  /es\s+para\s+despu[eé]s/i,
  /m[aá]s\s+adelante/i,
  /la\s+pr[oó]xima\s+vez/i,
  /para\s+la\s+pr[oó]xima/i,
  /para\s+el\s+\d{1,2}\s+(de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i,
  /para\s+el\s+fin\s+de\s+semana/i,
  /el\s+fin\s+de\s+semana/i,
  // Respuestas de duración de stock ("me duran una semana", "unos 5 días más")
  /\d+\s+d[ií]as?\s+(m[aá]s|aproximadamente|m[aá]s\s+o\s+menos)?/i,
  /una\s+semana\s+(m[aá]s|aproximadamente|m[aá]s\s+o\s+menos)?/i,
  /dos\s+semanas?\s+(m[aá]s)?/i,
  /unos?\s+\d+\s+d[ií]as?/i,
  /\d+\s+semanas?\s+(m[aá]s)?/i,
];

/**
 * Retorna true si el mensaje indica que el cliente quiere pedir para después.
 */
function isFutureOrderIntent(message) {
  return FUTURE_ORDER_PATTERNS.some(p => p.test(message));
}

/**
 * Usa Claude Haiku para extraer:
 * - desiredDate: fecha ISO (YYYY-MM-DD) en que quiere el pedido
 * - productNotes: qué quiere pedir (texto libre)
 * - confidence: 0-1
 *
 * @param {string} userMessage - mensaje actual del cliente
 * @param {string[]} recentMessages - últimos mensajes de la conversación
 * @param {string} todayISO - fecha de hoy en formato YYYY-MM-DD
 */
async function extractScheduledOrderData(userMessage, recentMessages = [], todayISO) {
  const today = todayISO || new Date().toISOString().split('T')[0];

  const context = recentMessages.slice(-6).join('\n');
  const SYSTEM = `Hoy es ${today}. Extrae de la conversación:
1. ¿Para qué fecha quiere el pedido? (date ISO YYYY-MM-DD). Si dice "la próxima semana" usa el lunes de la semana siguiente. Si dice "el viernes" usa el próximo viernes. Si dice "mañana" usa ${addDays(today, 1)}. Si no hay fecha clara, usa ${addDays(today, 7)}.
2. ¿Qué producto quiere? (texto corto, máximo 60 chars). Si no se menciona producto, pon "su pedido habitual".

Responde SOLO JSON: {"desiredDate":"YYYY-MM-DD","productNotes":"texto","confidence":0.0-1.0}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Contexto previo:\n${context}\n\nMensaje actual: ${userMessage}` }],
    });
    const text = response.content[0]?.text || '{}';
    const json = JSON.parse(text.match(/\{.*\}/s)?.[0] || '{}');
    return {
      desiredDate:  json.desiredDate || addDays(today, 7),
      productNotes: json.productNotes || 'su pedido habitual',
      confidence:   json.confidence || 0.7,
    };
  } catch (err) {
    console.warn('[ScheduledOrders] Error extrayendo datos:', err.message);
    return {
      desiredDate:  addDays(today, 7),
      productNotes: 'su pedido habitual',
      confidence:   0.5,
    };
  }
}

function addDays(isoDate, days) {
  const str = isoDate instanceof Date
    ? isoDate.toISOString().slice(0, 10)
    : String(isoDate).slice(0, 10);
  const d = new Date(str + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Formatea fecha (string ISO o Date) a texto legible en español */
function formatDateEs(isoDate) {
  // pg puede devolver DATE como objeto Date o como string — normalizar siempre a YYYY-MM-DD
  const str = isoDate instanceof Date
    ? isoDate.toISOString().slice(0, 10)
    : String(isoDate).slice(0, 10);
  const d = new Date(str + 'T12:00:00Z');
  return d.toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

// Patrones de intención futura SUAVE: el cliente no se compromete con fecha
// ("lo pienso", "ya te aviso", "quizás") — sin scheduled_order, estado future_interest
const SOFT_FUTURE_PATTERNS = [
  /lo\s+(pienso|voy\s+a\s+pensar|pensaré|pensaré)/i,
  /voy\s+a\s+pensar(lo)?/i,
  /d[eé]jame\s+pensar(lo)?/i,
  /quiz[aá]s?/i,
  /tal\s+vez/i,
  /de\s+repente/i,         // modismo chileno para "quizás"
  /ya\s+te\s+(aviso|confirmo|digo|escribo|llamo)/i,
  /te\s+(confirmo|aviso|digo|escribo)\s+(despu[eé]s|m[aá]s\s+tarde|luego)/i,
  /cuando\s+(pueda|tenga|me\s+alcance|pueda\s+pagar|llegue)/i,
  /ahorita\s+no/i,
  /no\s+(por\s+ahora|por\s+el\s+momento|ahorita)/i,
  /en\s+otro\s+momento/i,
  /m[aá]s\s+adelante/i,
  /en\s+alg[uú]n\s+momento/i,
  /despu[eé]s\s+te\s+(escribo|llamo|confirmo)/i,
  /lo\s+pensaré/i,
  /no\s+s[eé]\s+(todav[ií]a|a[uú]n|si\s+puedo)/i,
  /todav[ií]a\s+no\s+s[eé]/i,
  /no\s+estoy\s+seguro/i,
];

/**
 * Retorna true si el mensaje indica interés futuro SUAVE (sin fecha comprometida).
 * A diferencia de isFutureOrderIntent, aquí el cliente no da una fecha concreta.
 */
function isSoftFutureIntent(message) {
  // Si ya hay fecha explícita, no es "soft" — es "hard" (scheduled_order)
  if (isFutureOrderIntent(message)) return false;
  return SOFT_FUTURE_PATTERNS.some(p => p.test(message));
}

module.exports = { isFutureOrderIntent, isSoftFutureIntent, extractScheduledOrderData, formatDateEs };
