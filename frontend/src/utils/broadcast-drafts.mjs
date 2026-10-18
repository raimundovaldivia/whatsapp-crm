export function reviewPayload(entries) {
  return entries.map(entry => ({ phone: String(entry.item.phone).replace(/\D/g, ''), message: String(entry.item.message || '').trim() }));
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

export function canApproveDrafts(plan, reviewed) {
  return !!plan?.entries?.length && plan.entries.every((entry, i) => reviewed.has(i)
    && typeof entry.item.message === 'string' && entry.item.message.trim().length > 0 && entry.item.message.length <= 1200
    && !/\{\{|\}\}/.test(entry.item.message));
}
