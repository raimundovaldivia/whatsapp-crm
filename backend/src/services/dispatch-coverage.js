'use strict';

const EARTH_RADIUS_KM = 6371.0088;

function validPoint(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return point?.lat !== null && point?.lat !== '' && point?.lng !== null && point?.lng !== ''
    && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && !(lat === 0 && lng === 0);
}

function distanceKm(from, to) {
  if (!validPoint(from) || !validPoint(to)) return null;
  const radians = degrees => degrees * Math.PI / 180;
  const lat1 = radians(Number(from.lat));
  const lat2 = radians(Number(to.lat));
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(Number(to.lng) - Number(from.lng));
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parsePoints(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 20).map((point, index) => ({
    name: String(point?.name || `Punto ${index + 2}`).trim().slice(0, 80),
    address: String(point?.address || '').trim().slice(0, 300),
    lat: validPoint(point) ? Number(point.lat) : null,
    lng: validPoint(point) ? Number(point.lng) : null,
    geocoded: validPoint(point),
  })).filter(point => point.address);
}

function coverageConfig({ warehouse = null, radiusKm = null, points = [] } = {}) {
  const radius = Number(radiusKm);
  const centers = [];
  if (validPoint(warehouse)) centers.push({
    name: 'Bodega',
    address: String(warehouse.address || '').trim(),
    lat: Number(warehouse.lat),
    lng: Number(warehouse.lng),
  });
  for (const point of parsePoints(points)) {
    if (validPoint(point)) centers.push(point);
  }
  return {
    enabled: Number.isFinite(radius) && radius >= 1 && radius <= 1000 && centers.length > 0,
    radiusKm: Number.isFinite(radius) && radius >= 1 && radius <= 1000 ? radius : null,
    centers,
  };
}

function classify(point, config) {
  if (!config?.enabled) return { status: 'not_configured' };
  if (!validPoint(point)) return { status: 'unlocated', radiusKm: config.radiusKm };
  let nearest = null;
  for (const center of config.centers) {
    const km = distanceKm(point, center);
    if (km !== null && (!nearest || km < nearest.distanceKm)) nearest = { center, distanceKm: km };
  }
  if (!nearest) return { status: 'unlocated', radiusKm: config.radiusKm };
  const rounded = Math.round(nearest.distanceKm * 10) / 10;
  return {
    status: nearest.distanceKm <= config.radiusKm ? 'inside' : 'outside',
    distanceKm: rounded,
    radiusKm: config.radiusKm,
    centerName: nearest.center.name,
  };
}

function annotate(items, config) {
  return (Array.isArray(items) ? items : []).map(item => ({ ...item, coverage: classify(item, config) }));
}

module.exports = { validPoint, distanceKm, parsePoints, coverageConfig, classify, annotate };
