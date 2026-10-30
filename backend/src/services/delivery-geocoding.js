'use strict';

const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 30 * 1000;
const cooldowns = new Map();
const inFlight = new Map();
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const addressKey = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300) : '';
const reference = /^(?:pasado|frente\s+a|al\s+lado|cerca\s+de|referencia|recibe|entrega|reja|port[oó]n|fondo\s+de)\b/i;

// Only the provider query is cleaned. Original addresses and delivery notes stay intact.
function geocodeQuery(address) {
  const parts = addressKey(address).replace(/\(([^)]*)\)/g, (whole, inside) => reference.test(inside.trim()) ? '' : whole)
    .split(',').map(p => p.trim()).filter(Boolean);
  const cleaned = [];
  for (let part of parts) {
    if (reference.test(part)) continue;
    if (cleaned.length && /^(?:casa|depto\.?|dpto\.?|departamento|sitio|torre|piso|edificio|condominio)\s*(?:n[°º.]?\s*)?[a-z-]*\d/i.test(part)) continue;
    if (!/\b(?:parcela|lote|fundo|ruta|km)\b/i.test(part)) {
      part = part.replace(/(\d[a-z]?\s+)\b(?:casa|depto\.?|dpto\.?|departamento|sitio|torre|piso|edificio)\s*.*$/i, '$1').trim();
    }
    if (part && !cleaned.some(p => fold(p) === fold(part))) cleaned.push(part);
  }
  return cleaned.join(', ');
}

function validPoint(point) {
  return point && typeof point.lat === 'number' && typeof point.lng === 'number'
    && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180
    && !(point.lat === 0 && point.lng === 0);
}

function selectResult(data, query) {
  if (data?.status !== 'OK') return null;
  const head = query.split(',')[0];
  const rural = /\b(?:parcela|lote|fundo|km)\b/i.test(query);
  const numbers = head.match(/\b\d+[a-z]?\b/gi) || [];
  const number = rural ? null : numbers.at(-1);
  const candidates = (data.results || []).filter(result => {
    const components = result.address_components || [];
    const country = components.find(c => c.types?.includes('country'));
    const streetNumber = components.find(c => c.types?.includes('street_number'));
    if (country?.short_name !== 'CL' || !validPoint(result.geometry?.location)) return false;
    if (!['ROOFTOP', 'RANGE_INTERPOLATED'].includes(result.geometry.location_type)) return false;
    if (rural) {
      const identifiers = value => fold(value).match(/\b\d+[a-z]?(?:[-.]\d+[a-z]?)*/g) || [];
      const expected = identifiers(query), actual = identifiers(result.formatted_address);
      if (result.partial_match || !expected.length || expected.some(n => !actual.includes(n))) return false;
    } else if (!number) return false;
    if (number && fold(streetNumber?.long_name) !== fold(number)) return false;
    if (number) {
      const words = value => fold(value).replace(/\b(?:av|avda|avenida|pje|pasaje|calle|nro|numero|de|del|la|las|los|el)\b/g, ' ')
        .split(/[^a-z]+/).filter(w => w.length > 1);
      const street = components.find(c => c.types?.includes('route'));
      // Neighborhoods after the house number must not count as the street name.
      const requested = words(head.slice(0, head.lastIndexOf(number))), returned = words(street?.long_name);
      if (requested.length && requested.filter(w => returned.includes(w)).length / requested.length < 0.6) return false;
    }
    const parts = query.split(',').map(fold);
    const city = parts.at(-1) === 'chile' ? parts.at(-2) : parts.at(-1);
    if (parts.length > 1 && city && !components.some(c =>
      c.types?.some(t => ['locality', 'administrative_area_level_3', 'sublocality'].includes(t))
      && [fold(c.long_name), fold(c.short_name)].includes(city))) return false;
    return true;
  });
  // An ambiguous search must not silently choose the first of multiple places.
  if (candidates.length !== 1) return null;
  return candidates[0];
}

async function geocodeMany({ pool, axios, apiKey, orgId, addresses, now = Date.now, log = () => {}, retryNegative = false }) {
  if (!Number.isSafeInteger(Number(orgId)) || Number(orgId) <= 0) throw new Error('Invalid organization');
  const unique = [...new Set((Array.isArray(addresses) ? addresses : []).map(addressKey).filter(Boolean))];
  const output = Object.fromEntries(unique.map(k => [k, null]));
  if (!unique.length) return output;
  const { rows } = await pool.query(
    `SELECT address_key, lat, lng, found, created_at FROM geocode_cache
      WHERE organization_id = $1 AND address_key = ANY($2)`, [orgId, unique]);
  const cached = new Set();
  for (const row of rows) {
    const point = row.lat == null || row.lng == null ? null : { lat: Number(row.lat), lng: Number(row.lng) };
    if (row.found && validPoint(point)) { output[row.address_key] = point; cached.add(row.address_key); }
    else if (!row.found) {
      const age = now() - new Date(row.created_at).getTime();
      if (!retryNegative && Number.isFinite(age) && age >= 0 && age < NEGATIVE_TTL_MS) cached.add(row.address_key);
    }
  }
  if (!apiKey) return output;
  const scope = String(orgId);
  const pending = unique.filter(k => !cached.has(k));
  async function locate(key) {
    if ((cooldowns.get(scope) || 0) > now()) return null;
    const flightKey = `${scope}:${key}`;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const work = (async () => {
      try {
        const query = geocodeQuery(key);
        if (!query) return null;
        const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: { address: query, key: apiKey, region: 'cl', language: 'es', components: 'country:CL' }, timeout: 8000,
        });
        const selected = selectResult(data, query);
        if (selected) {
          const point = selected.geometry.location;
          const saved = await pool.query(`INSERT INTO geocode_cache (organization_id, address_key, lat, lng, found)
            VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT (organization_id, address_key)
            DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, found = TRUE, created_at = NOW()
            WHERE geocode_cache.found IS NOT TRUE OR geocode_cache.lat IS NULL OR geocode_cache.lng IS NULL
            RETURNING lat, lng`, [orgId, key, point.lat, point.lng]);
          if (saved.rows.length) return { lat: point.lat, lng: point.lng };
          // A concurrent manual correction wins over this provider response.
          const current = await pool.query('SELECT lat, lng FROM geocode_cache WHERE organization_id = $1 AND address_key = $2 AND found = TRUE', [orgId, key]);
          const existing = current.rows[0];
          const existingPoint = existing?.lat == null || existing?.lng == null ? null : { lat: Number(existing.lat), lng: Number(existing.lng) };
          return validPoint(existingPoint) ? existingPoint : null;
        }
        if (data?.status === 'ZERO_RESULTS' || data?.status === 'OK') {
          // Genuine no-match or an imprecise/ambiguous result: retry after a bounded TTL.
          await pool.query(`INSERT INTO geocode_cache (organization_id, address_key, found)
            VALUES ($1, $2, FALSE) ON CONFLICT (organization_id, address_key)
            DO UPDATE SET lat = NULL, lng = NULL, found = FALSE, created_at = NOW()
            WHERE geocode_cache.found IS NOT TRUE`, [orgId, key]);
        } else {
          // Billing, quota and provider errors are never persisted as address failures.
          cooldowns.set(scope, now() + ERROR_BACKOFF_MS);
          if (cooldowns.size > 500) cooldowns.delete(cooldowns.keys().next().value);
          log('provider_unavailable');
        }
      } catch {
        cooldowns.set(scope, now() + ERROR_BACKOFF_MS);
        if (cooldowns.size > 500) cooldowns.delete(cooldowns.keys().next().value);
        log('lookup_unavailable'); // Never log Axios URLs, keys, addresses or provider error text.
      }
      return null;
    })();
    inFlight.set(flightKey, work);
    try { return await work; } finally { inFlight.delete(flightKey); }
  }
  for (let i = 0; i < pending.length; i += 5) {
    await Promise.all(pending.slice(i, i + 5).map(async key => { output[key] = await locate(key); }));
  }
  return output;
}

module.exports = { addressKey, geocodeQuery, selectResult, validPoint, geocodeMany, NEGATIVE_TTL_MS, ERROR_BACKOFF_MS };
