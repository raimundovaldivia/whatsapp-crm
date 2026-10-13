const COVERED_SECTORS = {
  'la serena': [
    'Avenida del Mar', 'Centro', 'Colina El Pino', 'El Milagro', 'El Romeral',
    'La Florida', 'Las Compañías', 'Puertas del Mar', 'San Joaquín', 'Serena Oriente',
  ],
  coquimbo: [
    'Baquedano', 'Bosque San Carlos', 'El Llano', 'El Sauce', 'Guayacán',
    'La Cantera', 'La Herradura', 'Pan de Azúcar', 'Parte Alta', 'Peñuelas',
    'Rinconada', 'San Juan', 'Sindempart', 'Tierras Blancas',
  ],
};

function folded(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function configuredPlaces(zone) {
  const normalized = folded(zone);
  if (!normalized) return [];
  return Object.keys(COVERED_SECTORS).filter(place => normalized.includes(place));
}

function resolveCoveredPlace(message, zone) {
  const text = folded(message);
  for (const place of configuredPlaces(zone)) {
    if (text.includes(place)) return place;
    if (COVERED_SECTORS[place].some(sector => text.includes(folded(sector)))) return place;
  }
  return null;
}

function isCoverageRejection(response) {
  const text = folded(response);
  return [
    /\bno\s+(?:despachamos|repartimos|entregamos|enviamos|llegamos|cubrimos)\b/,
    /\b(?:fuera|no\s+esta)\s+(?:de|dentro\s+de)\s+(?:nuestra\s+)?(?:zona|cobertura)\b/,
    /\b(?:zona|sector)\s+(?:no\s+cubierta|sin\s+cobertura)\b/,
  ].some(pattern => pattern.test(text));
}

function promptSection(zone) {
  const cleanZone = String(zone || '').trim();
  if (!cleanZone) return '';
  const places = configuredPlaces(cleanZone);
  const sectorLines = places.map(place => {
    const label = place === 'la serena' ? 'La Serena' : 'Coquimbo';
    return `- ${label}: ${COVERED_SECTORS[place].join(', ')}.`;
  });
  return `## Regla estricta de cobertura de reparto
La zona configurada es: ${cleanZone}.
- Los nombres indicados son comunas completas, no una lista exhaustiva de barrios.
- Si el cliente dice que su sector pertenece a una comuna cubierta, considéralo cubierto.
- Si solo menciona un sector que no reconoces, pregunta a qué comuna pertenece. NUNCA concluyas ni digas que no despachamos solo porque desconoces el nombre del sector.
- Solo puedes decir que una dirección está fuera de cobertura cuando el cliente haya confirmado una comuna que no aparece en la zona configurada.${sectorLines.length ? `\nSectores conocidos que pertenecen a comunas cubiertas:\n${sectorLines.join('\n')}` : ''}`;
}

function guardResponse({ message, response, zone }) {
  if (!String(zone || '').trim() || !isCoverageRejection(response)) return response;
  const coveredPlace = resolveCoveredPlace(message, zone);
  if (coveredPlace) {
    const label = coveredPlace === 'la serena' ? 'La Serena' : 'Coquimbo';
    return `Sí, despachamos en ${label}. Ese sector está dentro de nuestra zona de reparto. ¿Me indicas la dirección exacta para continuar?`;
  }
  return `Despachamos dentro de ${String(zone).trim()}. Para confirmarlo bien, ¿ese sector corresponde a alguna de esas comunas?`;
}

module.exports = {
  configuredPlaces,
  guardResponse,
  isCoverageRejection,
  promptSection,
  resolveCoveredPlace,
};
