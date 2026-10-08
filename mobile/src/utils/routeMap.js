// Missing values must stay missing: Number(null) and Number('') both produce 0.
function coordinate(value, min, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export function stopCoordinates(stop) {
  const lat = coordinate(stop?.lat, -90, 90);
  const lng = coordinate(stop?.lng, -180, 180);
  // 0,0 is a common placeholder, not a delivery address.
  return lat === null || lng === null || (lat === 0 && lng === 0) ? null : { lat, lng };
}

export function routeStops(route) {
  const optimized = Array.isArray(route?.optimized_route) ? route.optimized_route : [];
  const stops = optimized.length ? optimized : Array.isArray(route?.orders) ? route.orders : [];
  // The saved array order is authoritative, including a driver's manual reorder.
  return stops.map((stop, index) => ({ ...stop, stopNumber: index + 1 }));
}

export function navigationDestination(stop) {
  const coordinates = stopCoordinates(stop);
  if (coordinates) return `${coordinates.lat},${coordinates.lng}`;
  return typeof stop?.fullAddress === 'string' ? stop.fullAddress.trim() : '';
}

export function navigationUrl(stop) {
  const destination = navigationDestination(stop);
  return destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving` : null;
}
