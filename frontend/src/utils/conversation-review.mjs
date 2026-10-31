export function parseReviewPhones(text) {
  const lines = String(text || '').split(/[\n;,]+/).map(s => s.trim()).filter(Boolean);
  const phones = lines.map(line => {
    let phone = line.replace(/[+\s()-]/g, '');
    if (/^9\d{8}$/.test(phone)) phone = `56${phone}`;
    if (!/^569\d{8}$/.test(phone)) throw new Error('Pega sólo teléfonos móviles chilenos, uno por línea.');
    return phone;
  });
  const unique = [...new Set(phones)];
  if (!unique.length || unique.length > 500) throw new Error('Se necesitan entre 1 y 500 teléfonos únicos.');
  return unique;
}
export function reviewCounts(contacts = []) {
  const counts = { total: contacts.length, completed: 0, drafts: 0, excluded: 0, manual: 0, errors: 0, pending: 0, stale: 0 };
  for (const row of contacts) {
    if (row.state === 'done') {
      counts.completed++;
      if (row.result?.decision === 'draft') counts.drafts++;
      else if (row.result?.decision === 'excluded' || row.result?.decision === 'pause') counts.excluded++;
      else counts.manual++;
    } else if (row.state === 'error') counts.errors++;
    else if (row.state === 'stale') counts.stale++;
    else counts.pending++;
  }
  return counts;
}
export const REVIEW_LABELS = {
  pending: 'Pendiente', processing: 'Analizando', error: 'Error: reintentar', stale: 'Cambió el contexto',
  draft: 'Borrador por revisar', excluded: 'Excluido', manual: 'Revisión manual', pause: 'En pausa', analyzing: 'Analizando',
};
