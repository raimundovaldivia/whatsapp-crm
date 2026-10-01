/**
 * analyzePaymentProof.js — Analiza una imagen con Claude Vision
 *
 * Determina si la imagen es un comprobante de transferencia bancaria y,
 * si lo es, extrae monto, fecha, banco y referencia.
 */

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 250) : null;
}

/**
 * Una imagen sólo puede modificar pagos cuando la respuesta de Vision es
 * explícita y además contiene evidencia financiera. Esto evita que valores
 * como "false" (string), respuestas incompletas o fotos comunes se tomen
 * como comprobantes.
 */
function normalizePaymentProofAnalysis(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low';
  const parsedAmount = typeof raw.amount === 'number'
    ? raw.amount
    : Number(String(raw.amount ?? '').replace(/\D/g, ''));
  const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : null;
  const bank = cleanText(raw.bank);
  const reference = cleanText(raw.reference);
  const date = cleanText(raw.date);
  const currency = cleanText(raw.currency);
  const hasFinancialEvidence = amount !== null || bank !== null || reference !== null;
  const isPaymentProof = raw.is_payment_proof === true
    && ['high', 'medium'].includes(confidence)
    && hasFinancialEvidence;

  return {
    is_payment_proof: isPaymentProof,
    amount: isPaymentProof ? amount : null,
    currency: isPaymentProof ? currency : null,
    date: isPaymentProof ? date : null,
    bank: isPaymentProof ? bank : null,
    reference: isPaymentProof ? reference : null,
    confidence,
  };
}

/**
 * @param {Buffer} imageBuffer - Binario de la imagen
 * @param {string} mimeType    - 'image/jpeg' | 'image/png' | 'image/webp'
 * @returns {{
 *   is_payment_proof: boolean,
 *   amount: number|null,
 *   currency: string|null,
 *   date: string|null,
 *   bank: string|null,
 *   reference: string|null,
 *   confidence: 'high'|'medium'|'low'
 * }}
 */
async function analyzePaymentProof(imageBuffer, mimeType = 'image/jpeg') {
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const safeType   = validTypes.includes(mimeType) ? mimeType : 'image/jpeg';
  const base64     = Buffer.from(imageBuffer).toString('base64');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001', // rápido y barato para clasificación
    max_tokens: 250,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: safeType, data: base64 },
        },
        {
          type: 'text',
          text: `Analiza esta imagen. ¿Es un comprobante de transferencia o pago bancario?

Responde ÚNICAMENTE con JSON válido, sin texto extra:
{
  "is_payment_proof": true o false,
  "amount": número sin puntos ni comas (ej: 15900) o null,
  "currency": "CLP" o "USD" u otra o null,
  "date": "YYYY-MM-DD" o null,
  "bank": "nombre del banco" o null,
  "reference": "número de operación/referencia" o null,
  "confidence": "high" o "medium" o "low"
}

Sólo responde true si ves evidencia bancaria o financiera concreta, como monto,
banco, número de operación o referencia. Fotos de productos, huevos, personas,
domicilios, paquetes, boletas de compra sin pago bancario u objetos NO son
comprobantes de transferencia. Si tienes dudas, responde false.

Si NO es comprobante de pago, devuelve is_payment_proof: false y el resto null.`,
        },
      ],
    }],
  });

  const raw = response.content[0]?.text || '{}';

  try {
    // Intentar parsear directo
    return normalizePaymentProofAnalysis(JSON.parse(raw.trim()));
  } catch {
    // Extraer JSON del texto por si hay texto adicional
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return normalizePaymentProofAnalysis(JSON.parse(match[0])); } catch { /* ignorar */ }
    }
    console.warn('[AnalyzePayment] No se pudo parsear respuesta de Claude:', raw.slice(0, 200));
    return { is_payment_proof: false, confidence: 'low' };
  }
}

module.exports = { analyzePaymentProof, normalizePaymentProofAnalysis };
