'use strict';

const TEMPERATURES = new Set([
  'exploring', 'interested', 'hot', 'very_hot', 'future', 'won', 'discarded',
]);

const NUMBER_WORDS = 'un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce';
const UNIT_WORDS = 'bandejas?|cajas?|maples?|docenas?|unidades?|quesos?|huevos?|packs?|paquetes?';
const PRODUCT_PATTERN = /\b(huevos?|bandejas?|cajas?|maples?|quesos?|xl|jumbo|extra\s*grande|color|blancos?|cabras?|vacas?)\b/i;
const QUANTITY_PATTERN = new RegExp(`\\b(?:\\d{1,3}|${NUMBER_WORDS})\\s*(?:${UNIT_WORDS})\\b`, 'i');

function textOf(messages) {
  return (messages || [])
    .filter(message => message?.direction === 'inbound')
    .map(message => String(message.content || '').trim())
    .filter(Boolean)
    .slice(-20)
    .join('\n');
}

function parseDraft(orderDraft) {
  if (!orderDraft) return {};
  if (typeof orderDraft === 'object') return orderDraft;
  try { return JSON.parse(orderDraft); } catch { return {}; }
}

function draftItems(orderDraft) {
  const draft = parseDraft(orderDraft);
  return Array.isArray(draft.items) ? draft.items : [];
}

function hasDraftProduct(items) {
  return items.some(item => String(item?.product_name || item?.name || item?.title || '').trim());
}

function hasDraftQuantity(items) {
  return items.some(item => Number(item?.quantity) > 0);
}

function purchaseSignal(text) {
  const actionableText = text.replace(
    /\b(quiero|quisiera|necesito)\s+(?:un(?:a)?\s+)?(?:saber|cotizaci[oó]n|informaci[oó]n|precios?|valores?)\b/gi,
    'consulta'
  );
  if (/\b(c[oó]mo|d[oó]nde)\s+(puedo\s+)?(comprar|pedir)\b/i.test(actionableText)) return true;
  return /\b(quiero|quisiera|necesito)\s+(?:pedir|comprar|encargar|llevar|\d+|dos|tres|cuatro|cinco)\b/i.test(actionableText)
    || /\b(me\s+llevo|me\s+mandas|me\s+env[ií]as|m[aá]ndame|env[ií]ame|dame|agr[eé]game|confirmo(?:\s+el)?\s+pedido|hacer\s+un\s+pedido)\b/i.test(actionableText)
    || new RegExp(`\\b(?:quiero|necesito)\\b.{0,30}${PRODUCT_PATTERN.source}`, 'i').test(actionableText);
}

function leadSignals({ messages = [], orderDraft = null } = {}) {
  const text = textOf(messages);
  const draft = parseDraft(orderDraft);
  const items = draftItems(draft);
  const explicitPurchase = purchaseSignal(text);
  return {
    priceQuestion: /\b(precio|valor|cu[aá]nto\s+(?:cuesta|sale|vale)|a\s+cu[aá]nto|cotizaci[oó]n|cotizar)\b/i.test(text),
    product: hasDraftProduct(items) || PRODUCT_PATTERN.test(text),
    quantity: hasDraftQuantity(items) || QUANTITY_PATTERN.test(text),
    delivery: /\b(despach|env[ií]o|env[ií]an|repart|entrega|domicilio|comuna|llegan\s+a)\b/i.test(text),
    nearTerm: /\b(hoy|ma[nñ]ana|ahora|esta\s+semana|lo\s+antes\s+posible)\b/i.test(text),
    explicitPurchase,
    customerDetails: Boolean(
      String(draft.customer_name || '').trim()
      || String(draft.address || draft.shipping_address?.address || '').trim()
      || String(draft.city || draft.shipping_address?.city || '').trim()
    ),
    quoteOnly: /\b(s[oó]lo|solo)\s+(?:estoy\s+)?(?:cotizando|consultando|viendo\s+precios)|\bpor\s+ahora\s+(?:s[oó]lo\s+)?(?:cotizo|consulto)\b/i.test(text),
    future: /\b(m[aá]s\s+adelante|pr[oó]ximamente|otro\s+d[ií]a|el\s+pr[oó]ximo\s+mes|despu[eé]s\s+veo|te\s+aviso)\b/i.test(text),
    priceObjection: /\b(muy\s+caro|est[aá]\s+caro|no\s+me\s+alcanza|fuera\s+de\s+presupuesto)\b/i.test(text),
    declined: /\b(no\s+gracias|no\s+me\s+interesa|ya\s+no\s+quiero|no\s+quiero\s+comprar)\b/i.test(text),
  };
}

function qualifyLead({ messages = [], pipelineState = 'exploring', orderDraft = null, hasOrder = false } = {}) {
  const signals = leadSignals({ messages, orderDraft });
  const reasons = [];
  let score = 0;

  const add = (condition, points, label) => {
    if (!condition) return;
    score += points;
    reasons.push(label);
  };

  add(signals.priceQuestion, 5, 'Consultó precio');
  add(signals.product, 10, 'Definió un producto');
  add(signals.quantity, 20, 'Indicó una cantidad');
  add(signals.delivery, 10, 'Consultó despacho o comuna');
  add(signals.nearTerm, 15, 'Quiere comprar pronto');
  add(signals.explicitPurchase, 35, 'Expresó intención de compra');
  add(signals.customerDetails, 15, 'Entregó datos para el pedido');
  add(signals.quoteOnly, -25, 'Indicó que solo está cotizando');
  add(signals.future, -20, 'Compra prevista para más adelante');
  add(signals.priceObjection, -15, 'Presentó una objeción de precio');
  score = Math.max(0, Math.min(100, score));

  if (hasOrder) {
    return { temperature: 'won', score: 100, reasons: ['Pedido creado'], signals, veryHotGate: true };
  }
  if (signals.declined || pipelineState === 'opted_out') {
    return { temperature: 'discarded', score: 0, reasons: ['Indicó que no desea comprar'], signals, veryHotGate: false };
  }
  if (signals.future && !signals.nearTerm) {
    return { temperature: 'future', score, reasons, signals, veryHotGate: false };
  }

  const veryHotGate = signals.explicitPurchase
    && signals.product
    && (signals.quantity || signals.customerDetails);

  let temperature = 'exploring';
  if (score >= 65 && veryHotGate) temperature = 'very_hot';
  else if (score >= 40) temperature = 'hot';
  else if (score >= 20) temperature = 'interested';

  if (!TEMPERATURES.has(temperature)) temperature = 'exploring';
  return { temperature, score, reasons, signals, veryHotGate };
}

module.exports = { TEMPERATURES, leadSignals, qualifyLead };
