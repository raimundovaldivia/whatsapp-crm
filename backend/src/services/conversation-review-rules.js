'use strict';
const { createHash } = require('node:crypto');
const { todayISOChile } = require('./business-date');

const VERSION = 'evidence-review-v1';
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const body = message => String(message.content || '');
const OPT_OUT = /\b(?:no me (?:escrib\w*|contact\w*)|no (?:quiero|deseo) (?:recibir )?(?:mas )?(?:mensajes|publicidad|promociones)|no me (?:manden|envien) (?:mas )?(?:mensajes|publicidad|promociones)|(?:darme|dame) de baja|stop)\b/;
const DECLINE = /\b(?:ya no necesito|no (?:necesito|quiero) (?:comprar|pedir)|no (?:necesito|quiero) huevos(?!\s+(?:blancos|cafes|mixtos|jumbo|xl|l|m)\b)|no por ahora|no gracias|no me interesa|te aviso cuando necesite|les aviso cuando necesite)\b/;
const ISSUE = /\b(?:reclamo|no (?:llego|recibi)|pedido (?:incompleto|equivocado)|huevos (?:rotos|malos)|cobro duplicado)\b/;
const INTENT = /\b(?:quiero|necesito|traigame|anotame|confirmo|me llevo|reservame|encarg\w*)\b/;

function businessWeek(now = new Date()) {
  const today = todayISOChile(now);
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return { today, start: date.toISOString().slice(0, 10) };
}

function eligibility(context, now = new Date()) {
  const { today, start } = businessWeek(now);
  const messages = context.messages || [];
  const inbound = messages.filter(m => m.direction === 'inbound');
  const reasons = [];
  const add = (code, reason, message) => reasons.push({ code, reason, ...(message ? { messageId: String(message.id), quote: body(message), date: message.created_at } : {}) });
  if (!context.contacts?.length) add('unknown_contact', 'No hay un contacto verificado en esta tienda.');
  if (context.contacts?.some(c => c.opt_out)) add('opt_out', 'El contacto tiene una baja comercial registrada.');
  if (context.contacts?.some(c => c.client_type === 'empresa')) add('business', 'Empresa excluida de esta acción para personas.');
  for (let i = 0; i < inbound.length; i++) {
    const m = inbound[i];
    const text = fold(body(m));
    const previous = messages.filter(p => p.direction === 'outbound' && new Date(p.created_at) <= new Date(m.created_at)).at(-1);
    if (OPT_OUT.test(text) || /^(salir|baja)[.!\s]*$/.test(text)
      || (/^no[.!\s]*$/.test(text) && /(?:recibir|mensajes|promociones)[\s\S]*(?:responde|escribe)\s+["']?no\b/.test(fold(body(previous || {}))))) {
      add('opt_out', 'Pidió no recibir más mensajes. Requiere resolver la baja antes de cualquier campaña.', m); break;
    }
  }
  const recent = inbound.filter(m => todayISOChile(new Date(m.created_at)) >= start);
  const decline = [...recent].reverse().find(m => DECLINE.test(fold(body(m))));
  // A later explicit request can supersede a temporary decline; "gracias" cannot.
  if (decline && !recent.some(m => new Date(m.created_at) > new Date(decline.created_at)
    && INTENT.test(fold(body(m))) && !/\bno\b/.test(fold(body(m))))) {
    add('declined', 'Rechazó o pospuso la compra esta semana; dejar en pausa.', decline);
  }
  const issue = [...inbound].reverse().find(m => ISSUE.test(fold(body(m))));
  if (issue && !inbound.some(m => new Date(m.created_at) > new Date(issue.created_at)
    && /\b(?:ya llego|ya recibi|quedo resuelto|problema resuelto|todo solucionado)\b/.test(fold(body(m))))) {
    add('unresolved_issue', 'Hay un reclamo sin resolución explícita del cliente; revisar atención primero.', issue);
  }
  if ((context.orderEvents || []).some(o => {
    const date = todayISOChile(new Date(o.date));
    return date >= start && date <= today;
  })) add('ordered_this_week', 'Tiene un pedido creado esta semana, incluido un pedido pendiente o cancelado.');
  if (context.pendingScheduled?.length) add('scheduled_order', 'Tiene un pedido futuro pendiente.');
  const lastInbound = inbound.at(-1);
  const campaign = (context.campaigns || []).find(c => new Date(c.created_at) > new Date(lastInbound?.created_at || 0)
    && new Date(c.created_at) >= new Date(now.getTime() - 7 * 86400000));
  if (campaign) add('recent_outreach', 'Recibió una campaña en los últimos 7 días y aún no responde.');
  if (!inbound.length) add('no_chat', 'No hay mensajes entrantes disponibles para entender su interés.');
  return { eligible: reasons.length === 0, reasons, businessDate: today, weekStart: start };
}

// No silent substring truncation. Oversize messages are split with the same source ID.
function messageChunks(messages, maxChars = 24000) {
  const chunks = []; let chunk = []; let size = 0;
  for (const message of messages) {
    const content = body(message);
    const width = maxChars - 1000;
    for (let offset = 0; offset < Math.max(1, content.length); offset += width) {
      const part = { id: String(message.id), date: message.created_at, direction: message.direction,
        type: message.type, text: content.slice(offset, offset + width), offset };
      const length = JSON.stringify(part).length;
      if (chunk.length && size + length > maxChars) { chunks.push(chunk); chunk = []; size = 0; }
      chunk.push(part); size += length;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function evidenceFacts(raw, messages) {
  if (!Array.isArray(raw)) throw new Error('La IA no devolvió evidencia válida.');
  const source = new Map(messages.map(m => [String(m.id), m]));
  const allowed = new Set(['product', 'preference', 'quantity', 'intent', 'objection', 'delivery', 'question', 'decline', 'complaint', 'resolution', 'business', 'box_interest']);
  return raw.map(fact => {
    const m = source.get(String(fact.messageId));
    if (!allowed.has(fact.kind) || !m || m.direction !== 'inbound' || typeof fact.quote !== 'string'
      || !fact.quote.trim() || !body(m).includes(fact.quote) || !String(fact.value || '').trim()) {
      throw new Error('La evidencia propuesta no coincide con un mensaje entrante real.');
    }
    return { kind: fact.kind, value: String(fact.value).slice(0, 500), messageId: String(m.id),
      quote: fact.quote, date: m.created_at, conversationId: m.conversation_id, provider: m.provider };
  });
}

function snapshot(context, instruction) {
  return createHash('sha256').update(JSON.stringify({ version: VERSION, instruction,
    contacts: context.contacts, messages: context.messages, orders: context.orderEvents,
    purchases: context.purchases, campaigns: context.campaigns, catalog: context.catalog,
    scheduled: context.pendingScheduled, total: context.totalMessages })).digest('hex');
}

function coverage(context) {
  const messages = context.messages || [];
  const missingMedia = messages.filter(m => m.direction === 'inbound' && ['audio', 'image', 'video', 'document'].includes(m.type)
    && !body(m).startsWith('🎤 '));
  return { available: context.totalMessages, loaded: messages.length,
    complete: messages.length === context.totalMessages, mediaPending: missingMedia.length,
    firstDate: messages[0]?.created_at || null, lastDate: messages.at(-1)?.created_at || null,
    scope: 'Historial guardado en el CRM de canales comerciales; no certifica mensajes anteriores a la sincronización.' };
}

module.exports = { VERSION, fold, businessWeek, eligibility, messageChunks, evidenceFacts, snapshot, coverage };
