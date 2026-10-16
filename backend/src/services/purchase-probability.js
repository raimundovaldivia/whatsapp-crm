const MODEL_VERSION = 'conversation-rules-v1';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalized(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function canonicalPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('9')) digits = `56${digits}`;
  return digits;
}

function safeItems(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function unitsFromProductName(name) {
  const text = normalized(name);
  if (!/huev|bandeja|\b(?:m|l|xl|jumbo)\b/.test(text)) return 0;
  const explicit = text.match(/\b(20|30|40|60|90|100|120|180|360|540)\s*(?:huevos?|unidades?)\b/);
  if (explicit) return Number(explicit[1]);
  const container = text.match(/\b(?:bandeja|pack|caja)\s*(?:de\s*)?(20|30|40|60|90|100|120|180)\b/);
  if (container) return Number(container[1]);
  if (/\bcaja\b/.test(text)) return 180;
  if (/\bbandeja\b/.test(text)) return 30;
  return 0;
}

function eggsFromOrderItems(value) {
  return safeItems(value).reduce((sum, item) => {
    const units = unitsFromProductName(item.name || item.title || item.product_name);
    const quantity = clamp(Number.parseInt(item.quantity, 10) || 1, 1, 100);
    return sum + units * quantity;
  }, 0);
}

function explicitEggsFromText(value) {
  const text = normalized(value);
  if (!/huev|bandeja|caja|\b(?:m|l|xl|jumbo)\b/.test(text)) return 0;
  const countValue = raw => ({ una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 }[raw] || Number(raw));
  const countPattern = '(\\d{1,2}|una?|dos|tres|cuatro|cinco|seis)';

  const tray = text.match(new RegExp(`\\b${countPattern}\\s*(?:bandejas?|packs?)\\b[^\\n]{0,45}?\\b(?:de\\s*)?(20|30)\\s*(?:huevos?|unidades?)?`));
  if (tray) return clamp(countValue(tray[1]) * Number(tray[2]), 0, 5000);

  const boxes = text.match(new RegExp(`\\b${countPattern}\\s*cajas?\\b[^\\n]{0,45}?\\b(?:de\\s*)?(100|120|180)\\s*(?:huevos?|unidades?)?`));
  if (boxes) return clamp(countValue(boxes[1]) * Number(boxes[2]), 0, 5000);

  const eggs = [...text.matchAll(/\b(20|30|40|60|90|100|120|180|360|540|720|900)\s*(?:huevos?|unidades?)\b/g)]
    .map(match => Number(match[1]));
  if (eggs.length) return clamp(eggs.at(-1), 0, 5000);

  const trayCount = text.match(new RegExp(`\\b${countPattern}\\s*(?:bandejas?|packs?)\\b`));
  if (trayCount) return clamp(countValue(trayCount[1]) * 30, 0, 5000);
  const boxCount = text.match(new RegExp(`\\b${countPattern}\\s*cajas?\\b`));
  if (boxCount) return clamp(countValue(boxCount[1]) * 180, 0, 5000);
  return 0;
}

function estimateEggs(messages, historicalEggs = []) {
  const inbound = messages.filter(message => message.direction === 'inbound').slice(-8).reverse();
  for (const message of inbound) {
    const eggs = explicitEggsFromText(message.content);
    if (eggs) return { eggs, source: 'conversation' };
  }

  const relevantOutbound = messages.filter(message => message.direction === 'outbound').slice(-3).reverse();
  for (const message of relevantOutbound) {
    const eggs = explicitEggsFromText(message.content);
    if (eggs && !/\b(?:40|60|90|100)\b[^\n]+\b(?:40|60|90|100)\b/.test(normalized(message.content))) {
      return { eggs, source: 'quote' };
    }
  }

  const validHistory = historicalEggs.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (validHistory.length) {
    const mid = Math.floor(validHistory.length / 2);
    const median = validHistory.length % 2
      ? validHistory[mid]
      : Math.round((validHistory[mid - 1] + validHistory[mid]) / 2);
    return { eggs: clamp(median, 20, 5000), source: 'purchase_history' };
  }

  const allText = normalized(messages.map(message => message.content).join(' '));
  return /huev|bandeja|\b(?:m|l|xl|jumbo)\b/.test(allText)
    ? { eggs: 30, source: 'category_default' }
    : { eggs: 0, source: 'unknown' };
}

function addSignal(signals, key, label, weight) {
  signals.push({ key, label, weight });
  return weight;
}

function hoursSince(value, now) {
  if (!value) return Infinity;
  return Math.max(0, (now.getTime() - new Date(value).getTime()) / 3600000);
}

function scoreConversation({ messages = [], pipelineState = 'exploring', priorOrders = 0, lastOrderAt = null, historicalEggs = [], now = new Date() }) {
  const lastOrderTime = lastOrderAt ? new Date(lastOrderAt).getTime() : Number.NaN;
  const scoringMessages = Number.isFinite(lastOrderTime)
    ? messages.filter(message => {
      const messageTime = new Date(message.created_at).getTime();
      return Number.isFinite(messageTime) && messageTime > lastOrderTime;
    })
    : messages;
  const inboundMessages = scoringMessages.filter(message => message.direction === 'inbound');
  const inbound = normalized(inboundMessages.map(message => message.content).join(' '));
  const outbound = normalized(scoringMessages.filter(message => message.direction === 'outbound').map(message => message.content).join(' '));
  const all = `${inbound} ${outbound}`;
  const lastInboundAt = inboundMessages.at(-1)?.created_at || null;
  const ageHours = hoursSince(lastInboundAt, now);
  const signals = [];
  let points = 12;

  const hasProduct = /huev|bandeja|caja|queso|aceituna|\b(?:m|l|xl|jumbo)\b/.test(inbound);
  const askedPrice = /cu[aá]nto|precio|valor|sale|cuesta|cotiz/.test(inbound);
  const hasQuote = /\$\s*[\d.]+|\b\d{1,3}(?:\.\d{3})+\b/.test(outbound);
  const hasQuantity = /\b\d{1,3}\s*(?:huevos?|unidades?|bandejas?|packs?|cajas?)\b|\b(?:una|dos|tres|cuatro)\s*(?:bandejas?|cajas?)\b/.test(inbound);
  const explicitIntent = /\b(?:quiero|quisiera|necesito|dame|deme|dejame|dejeme|anotame|anoteme|encarg|confirmo|me llevo|voy a llevar|guardame|reservame)\b/.test(inbound);
  const delivery = /repart|despach|entreg|env[ií]o|s[aá]bado|ma[nñ]ana|hoy|horario/.test(inbound);
  const address = /direcci[oó]n|domicilio|calle|avenida|pasaje|depto|departamento|condominio/.test(inbound);
  const softFuture = /te aviso|les aviso|lo pienso|voy a pensar|estoy cotizando|solo cotiz|cualquier cosa|mas adelante|m[aá]s adelante/.test(inbound);
  const priceObjection = /muy caro|esta caro|est[aá] caro|m[aá]s barato|se me sale|fuera de presupuesto|mucho para mi/.test(inbound);
  const optOut = pipelineState === 'opted_out' || /no me escrib|no quiero recibir|dame de baja|no contactar/.test(inbound);
  const lastInboundTime = lastInboundAt ? new Date(lastInboundAt).getTime() : Number.NaN;
  const alreadyConverted = Number.isFinite(lastOrderTime)
    && (!Number.isFinite(lastInboundTime) || lastOrderTime >= lastInboundTime);

  if (hasProduct) points += addSignal(signals, 'product', 'Producto o calibre identificado', 8);
  if (askedPrice) points += addSignal(signals, 'price_question', 'Consultó precio o cotización', 8);
  if (hasQuote) points += addSignal(signals, 'quoted', 'Recibió una cotización concreta', 6);
  if (hasQuantity) points += addSignal(signals, 'quantity', 'Indicó una cantidad', 12);
  if (explicitIntent) points += addSignal(signals, 'explicit_intent', 'Expresó intención directa de compra', 22);
  if (delivery) points += addSignal(signals, 'delivery', 'Consultó despacho u horario', 5);
  if (address) points += addSignal(signals, 'address', 'Entregó o consultó dirección', 14);
  if (softFuture) points += addSignal(signals, 'soft_future', 'Dejó la decisión para después', 3);
  if (priceObjection) points += addSignal(signals, 'price_objection', 'Mostró objeción de precio', -7);

  const stateWeights = {
    interested: 8,
    collecting_order: 24,
    awaiting_payment: 26,
    future_interest: 5,
    scheduled: 18,
    confirmed: -18,
    done: -15,
    opted_out: -100,
  };
  if (stateWeights[pipelineState]) points += addSignal(signals, `state_${pipelineState}`, `Estado comercial: ${pipelineState}`, stateWeights[pipelineState]);

  if (priorOrders > 0) {
    const weight = Math.min(12, 4 + Math.round(Math.log2(priorOrders + 1) * 2));
    points += addSignal(signals, 'purchase_history', `${priorOrders} pedido(s) anteriores`, weight);
  }

  const orderAgeHours = hoursSince(lastOrderAt, now);
  if (orderAgeHours <= 24 * 7) points += addSignal(signals, 'recent_order', 'Ya compró durante los últimos 7 días', -25);
  else if (orderAgeHours <= 24 * 21) points += addSignal(signals, 'recent_order', 'Compró durante las últimas 3 semanas', -10);

  let recencyWeight;
  if (ageHours <= 24) recencyWeight = 12;
  else if (ageHours <= 72) recencyWeight = 6;
  else if (ageHours <= 24 * 7) recencyWeight = 1;
  else if (ageHours <= 24 * 14) recencyWeight = -6;
  else if (ageHours <= 24 * 31) recencyWeight = -12;
  else recencyWeight = -20;
  points += addSignal(signals, 'recency', ageHours <= 24 ? 'Conversación activa en las últimas 24 horas' : `Último mensaje entrante hace ${Math.round(ageHours / 24)} día(s)`, recencyWeight);

  if (alreadyConverted) addSignal(signals, 'already_converted', 'La compra más reciente ocurrió después de esta conversación', -100);
  if (optOut || alreadyConverted) points = -100;
  const suppressed = optOut || alreadyConverted;
  const probability24h = suppressed ? 0 : Math.round(100 / (1 + Math.exp(-(points - 45) / 13)));
  const probability48h = suppressed ? 0 : Math.round(probability24h + (100 - probability24h) * 0.22);

  let stage = 'exploration';
  if (alreadyConverted) stage = 'converted';
  else if (explicitIntent && hasQuantity) stage = 'decision';
  else if (softFuture && hasQuote) stage = 'post_quote';
  else if (delivery && !explicitIntent) stage = 'logistics';
  else if (askedPrice && hasQuote) stage = 'quoted';
  else if (hasProduct) stage = 'consideration';

  let blocker = 'needs_qualification';
  if (optOut) blocker = 'opted_out';
  else if (alreadyConverted) blocker = 'already_purchased';
  else if (priceObjection) blocker = 'price';
  else if (softFuture) blocker = 'decision_delay';
  else if (delivery && !explicitIntent) blocker = 'logistics';
  else if (explicitIntent && hasQuantity) blocker = 'confirmation';
  else if (hasProduct && !hasQuantity) blocker = 'quantity';
  else if (hasQuantity && !explicitIntent) blocker = 'confirmation';

  const actions = {
    opted_out: 'No contactar',
    already_purchased: 'No insistir por esta compra; esperar una nueva señal posterior al pedido',
    price: 'Resolver la objeción con una alternativa concreta basada en lo cotizado',
    decision_delay: 'Retomar exactamente el producto, cantidad y precio que dejó pendientes',
    logistics: 'Resolver primero el despacho u horario y pedir una elección concreta',
    quantity: 'Preguntar la cantidad usando el producto ya conversado',
    confirmation: 'Pedir confirmación directa de la cantidad ya elegida',
    needs_qualification: 'Continuar desde la última pregunta concreta y descubrir producto y cantidad',
  };

  const estimate = estimateEggs(scoringMessages, historicalEggs);
  return {
    modelVersion: MODEL_VERSION,
    probability24h: clamp(probability24h, 0, 99),
    probability48h: clamp(probability48h, 0, 99),
    estimatedEggs: estimate.eggs,
    expectedEggs24h: Number((estimate.eggs * probability24h / 100).toFixed(1)),
    expectedEggs48h: Number((estimate.eggs * probability48h / 100).toFixed(1)),
    estimateSource: estimate.source,
    stage,
    blocker,
    signals,
    recommendedAction: actions[blocker],
    explanation: signals
      .filter(signal => signal.key !== 'recency')
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 3)
      .map(signal => signal.label)
      .join(' · ') || 'Todavía hay pocas señales de compra',
    rawPoints: points,
    lastInboundAt,
  };
}

module.exports = {
  MODEL_VERSION,
  canonicalPhone,
  eggsFromOrderItems,
  explicitEggsFromText,
  estimateEggs,
  scoreConversation,
};
