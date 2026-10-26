export function trackingTokenFromPath(pathname) {
  if (!/^\/seguimiento(?:\/|$)/.test(pathname)) return null;
  return /^\/seguimiento\/([A-Za-z0-9_-]{32,96})\/?$/.exec(pathname)?.[1] || '';
}

export function trackingLookupFromPath(pathname) {
  if (/^\/seguimiento\/?$/.test(pathname)) return { storeSlug: null };
  const match = /^\/tienda\/([a-z0-9][a-z0-9_-]{0,99})\/seguimiento\/?$/.exec(pathname);
  return match ? { storeSlug: match[1] } : null;
}

export async function fetchOrderStatus(baseUrl, input, signal, fetcher = fetch) {
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/seguimiento/consultar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
  });
  if (!response.ok) {
    const message = response.status === 404 ? 'No encontramos un pedido con esos datos en esta tienda. Revisa el teléfono y el número de pedido.'
      : response.status === 400 ? 'Revisa el teléfono y el número de pedido.'
        : response.status === 429 ? 'Has realizado varias consultas. Vuelve a intentarlo en 15 minutos.'
          : 'No pudimos consultar el pedido. Inténtalo nuevamente.';
    throw new Error(message);
  }
  return response.json();
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
