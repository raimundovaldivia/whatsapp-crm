// Forma canónica de una oferta. Debe coincidir con canonicalOffer en backend/src/services/broadcast-drafts.js:
// la huella de aprobación la calculan ambos lados.
export function canonicalOffer(offer) {
  return {
    product_id: String(offer.product_id ?? ''),
    offer_price: Number(offer.offer_price ?? 0),
    expires_at: String(offer.expires_at ?? ''),
    scope: offer.scope ?? 'all_units',
  };
}

// Lista canónica de ofertas de un destinatario, ordenada por producto (igual que en el backend).
export function canonicalOffers(offers) {
  return (Array.isArray(offers) ? offers : [])
    .map(canonicalOffer)
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
}

export function offerKey(offer) {
  return offer ? JSON.stringify(offer) : null;
}

export const OFFER_FIELD_LABELS = {
  product_id: 'producto', offer_price: 'precio', expires_at: 'vencimiento',
  scope: 'alcance', recipients: 'destinatario', margin_confirmed: 'confirmación de margen',
};

export const MAX_OFFERS_PER_RECIPIENT = 5;

export function offerCatalog(data) {
  const products = Array.isArray(data) ? data : data?.products;
  if (!Array.isArray(products)) throw new Error('No se recibió el catálogo de productos.');
  return products.filter(product => product.active && !product.deprecated_at);
}

export function offerExpiryInput(value) {
  if (!value) return '';
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// Restore text only into the current filtered audience. Never trust approvals,
// channel IDs, pricing, force flags, or contact metadata supplied by a file.
export function restoreDraftEntries(data, audience) {
  const rows = Array.isArray(data) ? data : data?.contacts;
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('Carga entre 1 y 100 borradores.');
  const phoneOf = value => String(value || '').replace(/\D/g, '');
  const chosen = new Map(audience.map(contact => [phoneOf(contact.phone), contact]));
  if (rows.length !== chosen.size) throw new Error('Los borradores deben coincidir con todos los contactos seleccionados.');
  const seen = new Set();
  return rows.map(row => {
    const phone = phoneOf(row.phone);
    const contact = chosen.get(phone);
    if (!/^\d{8,15}$/.test(phone) || !contact || seen.has(phone) || contact.opt_out || contact.identity_blocked) {
      throw new Error('Hay un destinatario repetido, excluido o fuera de la selección.');
    }
    if (typeof row.message !== 'string' || !row.message.trim() || row.message.length > 1200 || /\{\{|\}\}/.test(row.message)) {
      throw new Error(`Revisa el texto para ${phone}: debe tener entre 1 y 1.200 caracteres y no usar variables.`);
    }
    seen.add(phone);
    const message = row.message.trim();
    return {
      contact, reason: 'Borrador guardado recuperado para revisión. Verifica su texto y completa las ofertas.',
      previewText: message, offerChecks: [], requireOffer: true,
      item: { phone: contact.phone, originalPhone: contact.phone, contactName: contact.name, message, previewText: message, offers: [] },
    };
  });
}

export function offersList(entry) {
  return Array.isArray(entry?.item?.offers) ? entry.item.offers : [];
}

export function reviewPayload(entries) {
  return entries.map(entry => ({
    phone: String(entry.item.phone).replace(/\D/g, ''),
    message: String(entry.item.message || '').trim(),
    offers: canonicalOffers(offersList(entry)),
  }));
}

export async function reviewFingerprint(entries) {
  const bytes = new TextEncoder().encode(JSON.stringify(reviewPayload(entries)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function editReviewedEntry(plan, index, message) {
  return { ...plan, entries: plan.entries.map((entry, i) => i === index ? {
    ...entry, previewText: message, item: { ...entry.item, message, previewText: message },
  } : entry) };
}

// Dos ofertas del mismo producto para un destinatario no se pueden autorizar.
export function duplicateOfferProducts(entry) {
  const ids = offersList(entry).map(o => String(o.product_id ?? ''));
  return ids.filter((id, i) => id !== '' && ids.indexOf(id) !== i);
}

// Una oferta solo está lista si cada una fue validada tal como está escrita ahora.
export function offerReady(entry) {
  const offers = offersList(entry);
  if (entry.requireOffer && !offers.length) return false;
  if (!offers.length) return true;
  if (duplicateOfferProducts(entry).length) return false;
  const checks = entry.offerChecks || [];
  return offers.every((offer, i) => checks[i]?.ok === true && checks[i].key === offerKey(offer));
}

export function canApproveDrafts(plan, reviewed) {
  return !!plan?.entries?.length && plan.entries.every((entry, i) => reviewed.has(i)
    && typeof entry.item.message === 'string' && entry.item.message.trim().length > 0 && entry.item.message.length <= 1200
    && !/\{\{|\}\}/.test(entry.item.message) && offerReady(entry));
}

// Reemplaza la lista de ofertas de un destinatario y pide validarla de nuevo.
export function setEntryOffers(plan, index, offers) {
  return { ...plan, entries: plan.entries.map((entry, i) => i === index
    ? { ...entry, item: { ...entry.item, offers }, offerChecks: [] } : entry) };
}

export function offersSnapshot(entry) {
  return JSON.stringify(offersList(entry));
}

// Guarda resultados de validación solo si la lista no cambió mientras se validaba.
export function setEntryOfferChecks(plan, index, results, snapshot) {
  return { ...plan, entries: plan.entries.map((entry, i) => i === index && offersSnapshot(entry) === snapshot
    ? { ...entry, offerChecks: offersList(entry).map((offer, k) => ({
      ...(results[k] || { ok: false, missing: ['validación'], errors: [] }), key: offerKey(offer),
    })) } : entry) };
}

// Pone la oferta en cada destinatario, reemplazando la del mismo producto si ya existía.
export function applyOfferToAll(plan, fields) {
  const productId = String(fields.product_id ?? '');
  return { ...plan, entries: plan.entries.map(entry => {
    const others = offersList(entry).filter(o => String(o.product_id ?? '') !== productId);
    const offers = [...others, { ...fields, recipients: [entry.item.phone] }];
    return { ...entry, item: { ...entry.item, offers }, offerChecks: [] };
  }) };
}

// Códigos estables agrupan exclusiones aunque el detalle incluya días o nombres.
export function summarizeDraftAudience(prepared, excluded = []) {
  const labels = {
    unavailable: 'Contacto no disponible', opt_out: 'Baja o contacto excluido',
    audience: 'Fuera del público elegido', recent_decline: 'Rechazo en las últimas 48 horas',
    recent_issue: 'Reclamo o gestión sensible reciente', recent_campaign: 'Campaña reciente sin respuesta',
    instruction: 'Exclusión según la instrucción', manual: 'Excluido durante la revisión',
  };
  const groups = new Map();
  for (const item of excluded) {
    const key = item.reasonCode || item.reason || 'Sin motivo informado';
    const group = groups.get(key) || { key, label: labels[key] || item.reason || key, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return { total: prepared + excluded.length, prepared, excluded: excluded.length, reasons: [...groups.values()] };
}
