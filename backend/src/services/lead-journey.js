'use strict';

const EXPLICIT_REASONS = [
  { code: 'declined', label: 'No le interesa', confidence: 0.98, pattern: /\b(no gracias|no me interesa|ya no quiero|déjalo|dejalo)\b/i },
  { code: 'price', label: 'Precio', confidence: 0.94, pattern: /\b(muy caro|est[aá] caro|se me hace caro|no me alcanza|fuera de presupuesto)\b/i },
  { code: 'delivery', label: 'Despacho o ubicación', confidence: 0.94, pattern: /\b(no despachan|no llegan|no hacen env[ií]os?|muy lejos|no reparten)\b/i },
  { code: 'payment', label: 'Medio de pago', confidence: 0.92, pattern: /\b(no puedo pagar|no tengo transferencia|no tengo efectivo|problema con (el )?pago)\b/i },
  { code: 'later', label: 'Lo dejará para después', confidence: 0.9, pattern: /\b(m[aá]s adelante|otro d[ií]a|despu[eé]s veo|solo estoy cotizando|s[oó]lo cotizo|te aviso)\b/i },
  { code: 'stock', label: 'Producto o stock', confidence: 0.9, pattern: /\b(no tienen|no hay|se acab[oó]|sin stock|quer[ií]a otro)\b/i },
];

const STAGE_LABELS = {
  initial: 'Conversación inicial',
  product_interest: 'Producto o precio definido',
  order_details: 'Datos del pedido incompletos',
  link_sent: 'Enlace enviado sin clic',
  link_clicked: 'Hizo clic, pero no compró',
  converted: 'Pedido creado',
};

const MANUAL_REASON_LABELS = {
  price: 'Precio', delivery: 'Despacho o ubicación', payment: 'Medio de pago',
  later: 'Lo dejará para después', stock: 'Producto o stock', declined: 'No le interesa',
  competitor: 'Compró en otro lugar', no_reply: 'No respondió', unknown: 'Motivo desconocido',
};

const INFERRED_REASONS = {
  initial: ['no_reply_initial', 'No respondió la conversación inicial', 0.52],
  product_interest: ['no_reply_after_offer', 'No respondió después de producto o precio', 0.58],
  order_details: ['incomplete_order', 'No completó los datos del pedido', 0.64],
  link_sent: ['link_not_opened', 'No abrió el enlace enviado', 0.82],
  link_clicked: ['friction_after_click', 'Abrió el enlace, pero no terminó el pedido', 0.86],
};

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyStage(row) {
  if (Number(row.orders_count || 0) > 0) return 'converted';
  if (Number(row.tracked_clicks || 0) > 0) return 'link_clicked';
  if (Number(row.tracked_links || 0) > 0 || row.has_outbound_url) return 'link_sent';
  if (['collecting_order', 'awaiting_payment', 'confirmed'].includes(row.pipeline_state)) return 'order_details';
  if (row.pipeline_state === 'interested' || row.has_product_draft) return 'product_interest';
  return 'initial';
}

function explicitReason(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;
  const match = EXPLICIT_REASONS.find(reason => reason.pattern.test(normalized));
  return match ? { code: match.code, label: match.label, source: 'observed', confidence: match.confidence } : null;
}

function classifyReason(row, stage) {
  if (stage === 'converted') {
    return { code: 'converted', label: 'Convirtió en pedido', source: 'observed', confidence: 1 };
  }
  if (MANUAL_REASON_LABELS[row.limbo_reason_code]) {
    return { code: row.limbo_reason_code, label: row.limbo_reason_note || MANUAL_REASON_LABELS[row.limbo_reason_code], source: 'manual', confidence: 1 };
  }
  const observed = explicitReason(row.recent_inbound_text);
  if (observed) return observed;
  const inferred = INFERRED_REASONS[stage];
  if (inferred) return { code: inferred[0], label: inferred[1], source: 'inferred', confidence: inferred[2] };
  return { code: 'unknown', label: 'Motivo desconocido', source: 'unknown', confidence: null };
}

function classifyJourney(row) {
  const stage = classifyStage(row);
  const reason = classifyReason(row, stage);
  const silentHours = numberOrNull(row.silent_hours);
  const active = stage !== 'converted' && silentHours !== null && silentHours < 2;
  const outcome = stage === 'converted' ? 'converted' : active ? 'active' : 'limbo';
  return {
    ...row,
    stage,
    stage_label: STAGE_LABELS[stage],
    outcome,
    reason_code: active ? 'active' : reason.code,
    reason_label: active ? 'Conversación todavía activa' : reason.label,
    reason_source: active ? 'observed' : reason.source,
    reason_confidence: active ? 1 : reason.confidence,
    first_response_minutes: numberOrNull(row.first_response_minutes),
    customer_reply_minutes: numberOrNull(row.customer_reply_minutes),
    silent_hours: silentHours,
    orders_count: Number(row.orders_count || 0),
    tracked_links: Number(row.tracked_links || 0),
    tracked_clicks: Number(row.tracked_clicks || 0),
  };
}

function median(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : Math.round((clean[middle - 1] + clean[middle]) * 5) / 10;
}

function increment(map, key, label) {
  const item = map.get(key) || { code: key, label, count: 0 };
  item.count += 1;
  map.set(key, item);
}

function summarizeJourneys(rows) {
  const records = rows.map(classifyJourney);
  const stages = new Map();
  const reasons = new Map();
  for (const record of records) {
    increment(stages, record.stage, record.stage_label);
    if (record.outcome === 'limbo') increment(reasons, record.reason_code, record.reason_label);
  }
  const cohort = outcome => {
    const items = records.filter(record => record.outcome === outcome);
    return {
      contacts: items.length,
      median_first_response_minutes: median(items.map(item => item.first_response_minutes)),
      median_customer_reply_minutes: median(items.map(item => item.customer_reply_minutes)),
      average_messages: items.length
        ? Math.round(items.reduce((sum, item) => sum + Number(item.messages_count || 0), 0) * 10 / items.length) / 10
        : 0,
    };
  };
  const converted = records.filter(record => record.outcome === 'converted').length;
  const limbo = records.filter(record => record.outcome === 'limbo').length;
  return {
    totals: {
      contacts: records.length,
      converted,
      limbo,
      active: records.length - converted - limbo,
      conversion_rate: records.length ? Math.round(converted * 1000 / records.length) / 10 : 0,
    },
    funnel: {
      contacts: records.length,
      answered: records.filter(record => record.first_response_at).length,
      qualified: records.filter(record => record.stage !== 'initial').length,
      links_sent: records.filter(record => record.tracked_links > 0 || record.has_outbound_url).length,
      links_clicked: records.filter(record => record.tracked_clicks > 0).length,
      converted,
    },
    cohorts: { converted: cohort('converted'), limbo: cohort('limbo') },
    stages: [...stages.values()].sort((a, b) => b.count - a.count),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    records,
  };
}

function isTrackableDestination(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function extractTrackingTokens(text) {
  const tokens = new Set();
  const pattern = /\/r\/([A-Za-z0-9_-]{12})(?=$|[\s?#.,;!])/g;
  for (const match of String(text || '').matchAll(pattern)) tokens.add(match[1]);
  return [...tokens];
}

function shouldCountTrackingRequest(method, userAgent) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  return !/(facebookexternalhit|meta-externalagent|whatsapp|twitterbot|linkedinbot|slackbot|discordbot|googlebot|bingbot|preview)/i.test(String(userAgent || ''));
}

module.exports = { classifyJourney, summarizeJourneys, isTrackableDestination, extractTrackingTokens, shouldCountTrackingRequest, STAGE_LABELS, MANUAL_REASON_LABELS };
