const COVERED_SECTORS = {
  'la serena': [
    'Alfalfares', 'Avenida del Mar', 'Barrio Universitario', 'Compañía Alta', 'Compañía Baja', 'Colina El Pino', 'El Milagro', 'El Romeral',
    'La Antena', 'La Florida', 'La Pampa', 'Las Compañías', 'Pampa Alta', 'Puertas del Mar', 'San Joaquín', 'Serena Oriente',
  ],
  coquimbo: [
    'Baquedano', 'Bosque San Carlos', 'El Llano', 'El Sauce', 'Guayacán',
    'El Porvenir', 'La Cantera', 'La Herradura', 'Punta Mira', 'Pan de Azúcar', 'Parte Alta', 'Peñuelas',
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
  const text = ' ' + folded(message) + ' ';
  const mentions = name => text.includes(' ' + folded(name) + ' ');
  const places = Object.keys(COVERED_SECTORS);
  const communes = places.filter(mentions);
  const matches = communes.length ? communes : places.filter(place => COVERED_SECTORS[place].some(mentions));
  return matches.length === 1 && configuredPlaces(zone).includes(matches[0]) ? matches[0] : null;
}

function isCoverageRejection(response) {
  const parts = String(response || '').trim().split(/(?<=[.!?])\s+|\n+/);
  return parts.some(isRejectionSentence);
}

function isRejectionSentence(sentence) {
  const text = folded(sentence);
  if (/\b(?:hoy|manana|domingo|horario|cupos?|ruta llena|agotad[oa]s?)\b/.test(text)
      && !/\b(?:fuera de|sin cobertura|no (?:esta|pertenece) (?:en|a|dentro)|no cubrimos)\b/.test(text)) return false;
  return [
    /\bno\s+(?:despachamos|repartimos|entregamos|enviamos|llegamos|cubrimos)\b/,
    /\bno (?:tenemos|hay|contamos con|hacemos|realizamos|ofrecemos) (?:servicio de )?(?:reparto|despacho|entrega|envio|cobertura)s?\b/,
    /\b(?:fuera de|no (?:esta|queda|se encuentra) (?:en|dentro de)|no (?:forma parte de|pertenece a)) (?:la |nuestra )?(?:zona|area|cobertura|radio)\b/,
    /\b(?:zona|sector|barrio) (?:no (?:esta )?cubiert[oa]|sin cobertura)\b/,
    /\bno (?:esta|estamos|se encuentra) (?:cubiert[oa]s?|dentro del radio)\b/,
    /\b(?:el |ese |este )?sector no (?:tiene|cuenta con) (?:despacho|reparto|cobertura)\b/,
    /\b(?:solo|unicamente) (?:despachamos|repartimos|llegamos|entregamos|enviamos) (?:en|a) (?:la serena|coquimbo)\b/,
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
- Una respuesta breve como «Punta Mira» a una pregunta por sector indica el destino. Usa la comuna ya confirmada en este pedido, salvo que cambie la dirección. Confirma cobertura sin prometer una fecha o un cupo.
- Si el cliente dice que su sector pertenece a una comuna cubierta, considéralo cubierto.
- Si solo menciona un sector que no reconoces, pregunta a qué comuna pertenece. NUNCA concluyas ni digas que no despachamos solo porque desconoces el nombre del sector.
- Solo puedes decir que una dirección está fuera de cobertura cuando el cliente haya confirmado una comuna que no aparece en la zona configurada.${sectorLines.length ? `\nSectores conocidos que pertenecen a comunas cubiertas:\n${sectorLines.join('\n')}` : ''}`;
}

function replaceRejection(response, replacement) {
  const parts = String(response).trim().split(/(?<=[.!?])\s+|\n+/);
  let replaced = false;
  const corrected = parts.flatMap(part => {
    if (!isRejectionSentence(part)) return [part];
    if (replaced) return [];
    replaced = true;
    return [replacement];
  });
  return replaced ? corrected.join(' ') : response;
}

function guardResponse({ message, response, zone }) {
  if (!String(zone || '').trim() || !isCoverageRejection(response)) return response;
  const coveredPlace = resolveCoveredPlace(message, zone);
  if (coveredPlace) {
    const label = coveredPlace === 'la serena' ? 'La Serena' : 'Coquimbo';
    return replaceRejection(response, `Sí, despachamos en ${label}. Ese sector está dentro de nuestra zona de reparto.`);
  }
  return replaceRejection(response, `Despachamos dentro de ${String(zone).trim()}. Para confirmarlo bien, ¿ese sector corresponde a alguna de esas comunas?`);
}

module.exports = {
  configuredPlaces,
  guardResponse,
  isCoverageRejection,
  promptSection,
  resolveCoveredPlace,
};
