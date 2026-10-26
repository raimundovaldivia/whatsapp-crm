export function trackingTokenFromPath(pathname) {
  if (!/^\/seguimiento(?:\/|$)/.test(pathname)) return null;
  return /^\/seguimiento\/([A-Za-z0-9_-]{32,96})\/?$/.exec(pathname)?.[1] || '';
}

export async function fetchTrackingStatus(baseUrl, token, signal, fetcher = fetch) {
  if (!/^[A-Za-z0-9_-]{32,96}$/.test(token)) return { active: false, status: 'invalid' };
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/seguimiento/${token}/status`, {
    cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
  });
  if (response.status === 404) return { active: false, status: 'invalid' };
  if (response.status !== 410 && !response.ok) throw new Error('Seguimiento temporalmente no disponible');
  const state = await response.json();
  // Un enlace cerrado nunca conserva las coordenadas de una actualización anterior.
  if (response.status === 410 || !state.active) {
    return { active: false, status: state.status === 'delivered' ? 'delivered' : 'finished' };
  }
  return state;
}
