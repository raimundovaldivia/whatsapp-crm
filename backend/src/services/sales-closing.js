'use strict';

const TIME_ZONE = 'America/Santiago';
const SAME_DAY_OFFER_CUTOFF_MINUTES = 12 * 60 + 50;
const SAME_DAY_ORDER_CUTOFF_MINUTES = 13 * 60;
const VERY_HOT_IDLE_MINUTES = 5;
const HOT_IDLE_MINUTES = 15;
const MAX_HOT_FOLLOW_UPS = 2;

function chileParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour) % 24;
  const minute = Number(values.minute);
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return {
    year, month, day, hour, minute, weekday,
    isoDate: `${values.year}-${values.month}-${values.day}`,
    totalMinutes: hour * 60 + minute,
  };
}

function sameChileDay(first, second) {
  if (!first || !second) return false;
  return chileParts(first).isoDate === chileParts(second).isoDate;
}

function startedBeforeOfferCutoff(startedAt, now = new Date()) {
  if (!startedAt) return false;
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime()) || !sameChileDay(started, now)) return false;
  const parts = chileParts(started);
  return parts.weekday >= 1 && parts.weekday <= 6
    && parts.totalMinutes < SAME_DAY_OFFER_CUTOFF_MINUTES;
}

function sameDayPolicy({ now = new Date(), startedAt = null, holdUntil = null } = {}) {
  const current = chileParts(now);
  const dispatchDay = current.weekday >= 1 && current.weekday <= 6;
  const offerOpen = dispatchDay && current.totalMinutes < SAME_DAY_OFFER_CUTOFF_MINUTES;
  const orderOpen = dispatchDay && current.totalMinutes < SAME_DAY_ORDER_CUTOFF_MINUTES;
  const startedInTime = startedBeforeOfferCutoff(startedAt, now);
  const holdDate = holdUntil ? new Date(holdUntil) : null;
  const hasHold = !!holdDate && !Number.isNaN(holdDate.getTime()) && sameChileDay(holdDate, now);
  const holdActive = hasHold && holdDate.getTime() > new Date(now).getTime();
  const protectedOrder = startedInTime || hasHold;
  return {
    dispatchDay,
    offerOpen,
    orderOpen,
    startedInTime,
    hasHold,
    holdActive,
    protectedOrder,
    canContinueSameDay: orderOpen && (offerOpen || startedInTime || holdActive),
    needsHumanReview: protectedOrder && !orderOpen,
    minutesUntilOrderCutoff: orderOpen
      ? Math.max(0, SAME_DAY_ORDER_CUTOFF_MINUTES - current.totalMinutes)
      : 0,
  };
}

function normalizedDraft(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function hasItems(draft) {
  return Array.isArray(draft.items) && draft.items.length > 0;
}

function closingStage(conversation = {}) {
  const draft = normalizedDraft(conversation.order_draft);
  if (!hasItems(draft)) return 'product';
  if (!draft.customer_name && !conversation.contact_name) return 'name';
  if (!draft.address) return 'address';
  if (!draft.city) return 'city';
  return 'confirmation';
}

function leadTemperature(conversation = {}) {
  const draft = normalizedDraft(conversation.order_draft);
  if (conversation.pipeline_state === 'collecting_order') {
    const concreteSignals = [
      hasItems(draft), draft.customer_name, draft.address, draft.city,
      draft.delivery_requested_today, draft.customer_phone,
    ].filter(Boolean).length;
    return concreteSignals >= 1 ? 'very_hot' : 'hot';
  }
  return conversation.pipeline_state === 'interested' ? 'hot' : 'warm';
}

function followUpDelayMinutes(conversation = {}) {
  const temperature = leadTemperature(conversation);
  if (temperature === 'very_hot') return VERY_HOT_IDLE_MINUTES;
  if (temperature === 'hot') return HOT_IDLE_MINUTES;
  return null;
}

function buildHotFollowUpMessage(conversation = {}, now = new Date()) {
  const stage = closingStage(conversation);
  const policy = sameDayPolicy({
    now,
    startedAt: conversation.sales_started_at,
    holdUntil: conversation.same_day_hold_until,
  });
  const firstName = String(conversation.contact_name || '').trim().split(/\s+/)[0];
  const greeting = firstName && !/^(cliente|\+?\d+)$/i.test(firstName) ? `${firstName}, ` : '';
  const requests = {
    product: '¿qué producto y cantidad necesitas?',
    name: 'solo me falta tu nombre para continuar.',
    address: 'solo me falta la dirección de entrega.',
    city: 'solo me falta confirmar la comuna o ciudad.',
    confirmation: 'ya tengo los datos. ¿Confirmas que está todo correcto?',
  };
  const request = requests[stage] || requests.confirmation;

  if (policy.canContinueSameDay && policy.protectedOrder && !policy.offerOpen) {
    return `${greeting}como comenzaste tu pedido antes del cierre, mantengo la opción de despacho para hoy 😊 ${request}`;
  }
  if (policy.offerOpen) {
    return `${greeting}para alcanzar el despacho de hoy, ${request} 😊`;
  }
  return `${greeting}${request.charAt(0).toUpperCase()}${request.slice(1)}`;
}

function closingPromptSection(conversation = {}, now = new Date()) {
  const policy = sameDayPolicy({
    now,
    startedAt: conversation.sales_started_at,
    holdUntil: conversation.same_day_hold_until,
  });
  if (policy.canContinueSameDay && policy.protectedOrder && !policy.offerOpen) {
    return `## Protección de cierre comercial\nEl cliente comenzó el pedido antes de las 12:50. Mantén la opción de despacho para hoy mientras completa el pedido, hasta las 13:00. No le digas que perdió el despacho ni cambies el acuerdo por haber respondido después de las 12:50. Pide únicamente el dato pendiente.`;
  }
  if (policy.offerOpen) {
    return `## Cierre comercial de hoy\nTodavía se puede iniciar un pedido con opción de despacho para hoy. Deja de ofrecerla a clientes nuevos desde las 12:50. El cierre real para completar pedidos protegidos es a las 13:00.`;
  }
  if (policy.needsHumanReview) {
    return `## Pedido iniciado antes del corte, pendiente de revisión\nEl pedido comenzó antes de las 12:50 pero ya pasaron las 13:00. Continúa ayudando a completar los datos, no le digas que perdió el despacho y no prometas hoy. Indica que estás confirmando el despacho con el equipo y deriva a atención humana.`;
  }
  return `## Cierre comercial de hoy\nYa pasó la hora para ofrecer despacho el mismo día. Para pedidos nuevos, ofrece el próximo día de despacho disponible; no digas “mañana” sin verificar el calendario.`;
}

function isHotClosingHour(now = new Date()) {
  const parts = chileParts(now);
  return parts.weekday >= 1 && parts.weekday <= 6
    && parts.totalMinutes >= 9 * 60
    && parts.totalMinutes < SAME_DAY_ORDER_CUTOFF_MINUTES;
}

module.exports = {
  TIME_ZONE,
  SAME_DAY_OFFER_CUTOFF_MINUTES,
  SAME_DAY_ORDER_CUTOFF_MINUTES,
  VERY_HOT_IDLE_MINUTES,
  HOT_IDLE_MINUTES,
  MAX_HOT_FOLLOW_UPS,
  chileParts,
  startedBeforeOfferCutoff,
  sameDayPolicy,
  closingStage,
  leadTemperature,
  followUpDelayMinutes,
  buildHotFollowUpMessage,
  closingPromptSection,
  isHotClosingHour,
};
