// Forma canónica de la oferta. Debe coincidir con canonicalOffer en backend/src/services/broadcast-drafts.js:
// la huella de aprobación la usa en ambos lados.
export function canonicalOffer(offer) {
  if (!offer) return null;
  return {
    product_id: String(offer.product_id ?? ''),
    offer_price: Number(offer.offer_price ?? 0),
    expires_at: String(offer.expires_at ?? ''),
    scope: offer.scope ?? 'all_units',
  };
}

export function offerKey(offer) {
  return offer ? JSON.stringify(offer) : null;
}

export const OFFER_FIELD_LABELS = {
  product_id: 'producto', offer_price: 'precio', expires_at: 'vencimiento',
  scope: 'alcance', recipients: 'destinatario', margin_confirmed: 'confirmación de margen',
};

export function reviewPayload(entries) {
  return entries.map(entry => ({
    phone: String(entry.item.phone).replace(/\D/g, ''),
    message: String(entry.item.message || '').trim(),
    offer: canonicalOffer(entry.item.offer),
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

// Una oferta solo está lista si fue validada tal como está escrita ahora.
export function offerReady(entry) {
  if (!entry.item.offer) return true;
  return entry.offerCheck?.ok === true && entry.offerCheckKey === offerKey(entry.item.offer);
}

export function canApproveDrafts(plan, reviewed) {
  return !!plan?.entries?.length && plan.entries.every((entry, i) => reviewed.has(i)
    && typeof entry.item.message === 'string' && entry.item.message.trim().length > 0 && entry.item.message.length <= 1200
    && !/\{\{|\}\}/.test(entry.item.message) && offerReady(entry));
}

export function setEntryOffer(plan, index, offer) {
  return { ...plan, entries: plan.entries.map((entry, i) => i === index
    ? { ...entry, item: { ...entry.item, offer }, offerCheck: null, offerCheckKey: null } : entry) };
}

export function setEntryOfferCheck(plan, index, check, key) {
  return { ...plan, entries: plan.entries.map((entry, i) => i === index && offerKey(entry.item.offer) === key
    ? { ...entry, offerCheck: check, offerCheckKey: key } : entry) };
}

// Copia los datos de la oferta a todos los destinatarios; `results` viene de la validación de cada uno.
export function applyOfferToAll(plan, fields, results) {
  return { ...plan, entries: plan.entries.map((entry, i) => {
    const offer = { ...fields, recipients: [entry.item.phone] };
    return { ...entry, item: { ...entry.item, offer }, offerCheck: results[i] ?? null, offerCheckKey: offerKey(offer) };
  }) };
}
