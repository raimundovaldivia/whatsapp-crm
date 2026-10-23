'use strict';

const { classifyJourney } = require('./lead-journey');
const TIME_ZONE = 'America/Santiago';
const ATTRIBUTION_DAYS = 7;
const DAY = 86400000;

function dayKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function shiftDay(day, offset) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
}
function validateRange(from, to, now = new Date()) {
  const today = dayKey(now);
  from ??= today;
  to ??= from;
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && shiftDay(value, 0) === value;
  if (!valid(from) || !valid(to) || from > to || to > today || (Date.parse(to) - Date.parse(from)) / DAY > 30) {
    throw Object.assign(new Error('Selecciona un período válido de hasta 31 días, sin fechas futuras'), { status: 400 });
  }
  return { from, to };
}
function instant(value) {
  if (!value) return null;
  const text = typeof value === 'string' && !/(Z|[+-]\d\d:\d\d)$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}
function identity(phone, fallback) {
  let digits = String(phone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (/^0569\d{8}$/.test(digits)) digits = digits.slice(1);
  if (/^9\d{8}$/.test(digits)) digits = `56${digits}`;
  return digits ? `phone:${digits}` : `conversation:${fallback}`;
}
const amount = value => Math.max(0, Math.round(Number(value) || 0));
const rate = (n, d) => d ? Math.round(n * 1000 / d) / 10 : 0;

// Pure calculation: no Shopify calls, AI requests, outbound messages or writes.
function summarizeDailySales({ conversations, orders, attributions, proofs }, range, now = new Date()) {
  const at = new Date(now);
  const during = value => { const date = instant(value); return date && date <= at && dayKey(date) >= range.from && dayKey(date) <= range.to; };
  const convById = new Map(conversations.map(c => [String(c.id), c]));
  const contactKey = c => identity(c.phone_number, c.id);
  const orderKey = o => convById.has(String(o.conversation_id))
    ? contactKey(convById.get(String(o.conversation_id))) : identity(o.customer_phone, o.conversation_id || `order:${o.id}`);
  const validOrders = orders.filter(o => !['cancelled', 'cancelado', 'draft'].includes(o.status) && instant(o.created_at) && instant(o.created_at) <= at);
  const history = new Map();
  for (const o of validOrders) {
    const key = orderKey(o);
    if (!history.has(key)) history.set(key, []);
    history.get(key).push(o);
  }
  for (const items of history.values()) items.sort((a, b) => instant(a.created_at) - instant(b.created_at) || Number(a.id) - Number(b.id));
  const referrals = new Map();
  for (const a of attributions) {
    const c = convById.get(String(a.conversation_id));
    if (!c || !instant(a.first_seen_at) || instant(a.first_seen_at) > at) continue;
    const key = contactKey(c);
    if (!referrals.has(key)) referrals.set(key, []);
    referrals.get(key).push(a);
  }
  for (const rows of referrals.values()) rows.sort((a, b) => instant(a.first_seen_at) - instant(b.first_seen_at) || Number(a.id) - Number(b.id));
  const cohort = new Map();
  const firstContacts = new Map();
  for (const c of conversations) {
    const key = contactKey(c);
    const first = instant(c.first_inbound_at);
    if (first && (!firstContacts.has(key) || first < firstContacts.get(key))) firstContacts.set(key, first);
    if (!during(c.period_first_inbound_at)) continue;
    const existing = cohort.get(key);
    const cohortStart = instant(c.period_first_inbound_at);
    if (!existing) cohort.set(key, { ...c, key, cohort_start: cohortStart });
    else {
      const earliest = cohortStart < existing.cohort_start ? cohortStart : existing.cohort_start;
      if (instant(c.last_message_at) > instant(existing.last_message_at)) cohort.set(key, { ...c, key, cohort_start: earliest });
      else existing.cohort_start = earliest;
    }
  }
  const records = [...cohort.values()].map(c => {
    const laterOrders = (history.get(c.key) || []).filter(o => instant(o.created_at) >= c.cohort_start);
    const operational = !laterOrders.length && (history.get(c.key) || []).some(o =>
      instant(o.created_at) < c.cohort_start && !o.delivered_at && o.status !== 'entregado');
    const journey = classifyJourney({ ...c, conversation_id: c.id, orders_count: laterOrders.length,
      silent_hours: instant(c.last_message_at) ? Math.max(0, (at - instant(c.last_message_at)) / 3600000) : null });
    const first = firstContacts.get(c.key);
    const origin = (referrals.get(c.key) || []).find(a => first && Math.abs(instant(a.first_seen_at) - first) <= 30 * 60000);
    const action = c.pipeline_state === 'opted_out' || ['declined', 'no_need', 'competitor'].includes(journey.reason_code)
      ? 'No contactar: respetar la decisión del cliente'
      : laterOrders.length || operational ? 'Continuar en pago o entrega'
        : c.agent_mode !== 'ai' || ['requires_human', 'bot_unanswered'].includes(c.attention_state)
          ? 'Revisión humana pendiente'
          : journey.stage === 'order_details' ? 'Revisar qué dato falta para confirmar'
            : journey.stage === 'product_interest' ? 'Revisar oferta, total y condiciones de entrega'
              : 'Revisar la consulta y la respuesta inicial';
    return { conversation_id: c.id, contact_name: c.contact_name || 'Cliente', phone_number: c.phone_number,
      last_message_at: c.last_message_at, stage: journey.stage, stage_label: journey.stage_label,
      outcome: operational ? 'operational' : journey.outcome, reason_code: journey.reason_code, reason_label: journey.reason_label,
      reason_source: journey.reason_source, action, human_attention: action === 'Revisión humana pendiente',
      acquisition: origin ? 'Anuncio identificado' : 'Directo / no identificado',
      acquisition_campaign: origin ? (origin.campaign_name || origin.headline || origin.source_id || 'Anuncio sin nombre') : null };
  });
  const periodOrders = validOrders.filter(o => during(o.created_at));
  const buyers = new Set(periodOrders.map(orderKey));
  const converted = records.filter(c => c.outcome === 'converted').length;
  const ads = records.filter(c => c.acquisition === 'Anuncio identificado').length;
  const days = [];
  for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) {
    const items = periodOrders.filter(o => dayKey(instant(o.created_at)) === day);
    days.push({ day, orders: items.length, order_value: items.reduce((sum, o) => sum + amount(o.total_price), 0) });
  }
  // A receipt image or an elected payment method alone is not a confirmed payment.
  const verified = new Map();
  for (const p of proofs.filter(p => p.status === 'verified')) {
    if (!verified.has(String(p.order_id))) verified.set(String(p.order_id), []);
    verified.get(String(p.order_id)).push(p);
  }
  let collected = 0, receivable = 0, undated = 0;
  for (const o of validOrders) {
    const total = amount(o.total_price);
    const paid = o.status === 'paid';
    const markedAt = instant(o.payment_marked_at);
    const cash = ['efectivo', 'mixto'].includes(o.payment_method) && (o.delivered_at || ['entregado', 'paid'].includes(o.status))
      ? Math.min(total, o.payment_method === 'efectivo' ? total : amount(o.payment_cash_amount)) : 0;
    const entries = [];
    if (cash) entries.push({ amount: cash, date: markedAt });
    let covered = cash;
    const seen = new Set();
    for (const p of verified.get(String(o.id)) || []) {
      // Several screenshots of one transfer cannot multiply the paid amount.
      const key = p.bank_movement_id ? `bank:${p.bank_movement_id}` : p.extracted_reference ? `ref:${p.extracted_reference}` : 'unidentified';
      if (seen.has(key)) continue;
      seen.add(key);
      const value = Math.min(total - covered, amount(p.extracted_amount));
      if (value) entries.push({ amount: value, date: instant(p.bank_verified_at) });
      covered += value;
    }
    if (paid && covered < total) { entries.push({ amount: total - covered, date: markedAt }); covered = total; }
    for (const e of entries) {
      if (!e.date) undated += e.amount;
      else if (during(e.date)) collected += e.amount;
    }
    receivable += Math.max(0, total - covered);
  }
  const campaigns = new Map();
  let repeatOrders = 0;
  for (const o of periodOrders) {
    const key = orderKey(o);
    const repeat = history.get(key)?.[0]?.id !== o.id;
    if (repeat) repeatOrders++;
    // Latest evidenced touch within seven days before THIS order. Never attach
    // every future purchase to the customer's original acquisition campaign.
    const touch = (referrals.get(key) || []).filter(a => instant(a.first_seen_at) <= instant(o.created_at)
      && instant(a.first_seen_at) >= new Date(instant(o.created_at) - ATTRIBUTION_DAYS * DAY)).at(-1);
    const campaignKey = touch ? `${touch.provider}:${touch.campaign_id || touch.source_id || touch.source_url || touch.headline || touch.id}` : 'unattributed';
    if (!campaigns.has(campaignKey)) campaigns.set(campaignKey, { key: campaignKey, label: touch?.campaign_name || touch?.headline || touch?.source_id || 'Sin campaña reciente identificada', orders: 0, order_value: 0, buyers: new Set(), repeat_orders: 0 });
    const item = campaigns.get(campaignKey);
    item.orders++; item.order_value += amount(o.total_price); item.buyers.add(key); item.repeat_orders += Number(repeat);
  }
  const reasons = new Map();
  for (const c of records.filter(c => c.outcome === 'limbo')) {
    const key = `${c.reason_source}:${c.reason_code}`;
    if (!reasons.has(key)) reasons.set(key, { code: c.reason_code, label: c.reason_label, source: c.reason_source, count: 0 });
    reasons.get(key).count++;
  }
  const orderValue = periodOrders.reduce((sum, o) => sum + amount(o.total_price), 0);
  return { range, time_zone: TIME_ZONE, generated_at: at.toISOString(), source: 'crm', attribution_window_days: ATTRIBUTION_DAYS,
    activity: { orders: periodOrders.length, buyers: buyers.size, order_value: orderValue,
      average_ticket: periodOrders.length ? Math.round(orderValue / periodOrders.length) : 0,
      collected, receivable_current: receivable, confirmed_payments_without_date: undated,
      pending_delivery_current: validOrders.filter(o => !o.delivered_at && o.status !== 'entregado').length },
    cohort: { contacts: records.length, acquisition_ads: ads, direct_or_unknown: records.length - ads, converted,
      conversion_rate: rate(converted, records.length), limbo: records.filter(c => c.outcome === 'limbo').length,
      active: records.filter(c => c.outcome === 'active').length },
    operational_contacts: records.filter(c => c.outcome === 'operational').length,
    opportunities: records.filter(c => ['active', 'limbo'].includes(c.outcome)).sort((a, b) => Number(b.human_attention) - Number(a.human_attention)
      || Number(b.stage === 'order_details') - Number(a.stage === 'order_details')),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count), daily: days,
    results: { repeat_orders: repeatOrders, campaigns: [...campaigns.values()].map(c => ({ ...c, buyers: c.buyers.size })).sort((a, b) => b.order_value - a.order_value) },
    summary: `En el período consultaron ${records.length} personas y ${converted} crearon un pedido desde su consulta (${rate(converted, records.length)}%). Se crearon ${periodOrders.length} pedidos en estas fechas.`,
  };
}

async function getDailySales(pool, orgId, input = {}, now = new Date()) {
  const range = validateRange(input.from, input.to, now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: conversations } = await client.query(`
      SELECT c.id, c.phone_number, c.contact_name, c.pipeline_state, c.agent_mode, c.attention_state,
             c.order_draft, c.limbo_reason_code, c.limbo_reason_note,
             activity.first_inbound_at AT TIME ZONE 'UTC' AS first_inbound_at,
             activity.period_first_inbound_at AT TIME ZONE 'UTC' AS period_first_inbound_at,
             last_message.created_at AT TIME ZONE 'UTC' AS last_message_at, last_message.direction AS last_message_direction,
             recent.recent_inbound_text,
             EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.direction='outbound'
                     AND m.status <> 'failed' AND m.content ~* 'https?://' AND m.created_at <= $4::timestamp) AS has_outbound_url,
             c.pipeline_state='interested' AS has_product_draft
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT MIN(m.created_at) AS first_inbound_at,
                 MIN(m.created_at) FILTER (WHERE m.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santiago') AT TIME ZONE 'UTC'
                   AND m.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santiago') AT TIME ZONE 'UTC') AS period_first_inbound_at
          FROM messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.created_at <= $4::timestamp
        ) activity ON TRUE
        LEFT JOIN LATERAL (SELECT m.created_at,m.direction FROM messages m WHERE m.conversation_id=c.id
          AND m.created_at <= $4::timestamp AND m.status <> 'failed' ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_message ON TRUE
        LEFT JOIN LATERAL (SELECT string_agg(content,E'\n' ORDER BY created_at) AS recent_inbound_text FROM (
          SELECT content,created_at FROM messages m WHERE m.conversation_id=c.id AND m.direction='inbound'
          AND m.created_at <= $4::timestamp ORDER BY m.created_at DESC,m.id DESC LIMIT 8) r) recent ON TRUE
       WHERE c.organization_id=$1`, [orgId, range.from, range.to, now.toISOString()]);
    const { rows: orders } = await client.query(`SELECT id,conversation_id,customer_phone,total_price,status,
      created_at AT TIME ZONE 'UTC' AS created_at, delivered_at AT TIME ZONE 'UTC' AS delivered_at,
      payment_method,payment_marked_at AT TIME ZONE 'UTC' AS payment_marked_at,payment_cash_amount
      FROM orders WHERE organization_id=$1`, [orgId]);
    const { rows: attributions } = await client.query(`SELECT a.id,a.conversation_id,a.provider,a.campaign_id,a.campaign_name,
      a.source_id,a.source_url,a.headline,a.first_seen_at FROM whatsapp_attributions a
      JOIN conversations c ON c.id=a.conversation_id AND c.organization_id=a.organization_id WHERE a.organization_id=$1`, [orgId]);
    const { rows: proofs } = await client.query(`SELECT p.order_id,p.status,p.extracted_amount,p.extracted_reference,p.bank_movement_id,p.bank_verified_at
      FROM payment_proofs p JOIN orders o ON o.id=p.order_id AND o.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.status='verified'`, [orgId]);
    const result = summarizeDailySales({ conversations, orders, attributions, proofs }, range, now);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = { TIME_ZONE, dayKey, shiftDay, validateRange, identity, summarizeDailySales, getDailySales };
