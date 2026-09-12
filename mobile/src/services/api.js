/**
 * api.js — Cliente HTTP de la app de despachos
 *
 * Habla con /api/delivery/* y /api/auth/* del backend del CRM. Un usuario con
 * rol 'repartidor' no tiene acceso a nada más (lo bloquea el middleware).
 */
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_API_URL, API_TIMEOUT_MS, LOGIN_TIMEOUT_MS } from '../config';

const STORAGE_KEYS = {
  TOKEN:    'crm_token',
  BASE_URL: 'crm_base_url',
  USER:     'crm_user',
};

let _client = null;

// ── Sesión expirada ──────────────────────────────────────────────────
// El token JWT dura 7 días. Cuando el backend responde 401, la app tiene que
// volver al login sola: antes quedaba mostrando "Token inválido" en cada
// pantalla sin salida. App.js se suscribe acá.
const sessionListeners = new Set();
export function onSessionExpired(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
async function handleUnauthorized() {
  await clearSession();
  sessionListeners.forEach(fn => { try { fn(); } catch {} });
}

async function getClient() {
  if (_client) return _client;
  const baseURL = (await AsyncStorage.getItem(STORAGE_KEYS.BASE_URL)) || DEFAULT_API_URL;
  const token   = await AsyncStorage.getItem(STORAGE_KEYS.TOKEN);
  _client = axios.create({
    baseURL,
    timeout: API_TIMEOUT_MS,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  _client.interceptors.response.use(
    r => r,
    async err => {
      if (err.response?.status === 401) await handleUnauthorized();
      throw err;
    }
  );
  return _client;
}

export function resetClient() {
  _client = null;
}

// ── Auth ─────────────────────────────────────────────────────────────

/**
 * Inicia sesión contra el backend.
 *
 * El backend responde { success, data: { token, user, organization } }.
 * La versión anterior leía `res.data.token` (siempre undefined) y por eso el
 * login nunca pasaba. Se acepta también la forma plana por si cambia.
 */
export async function login(baseUrl, email, password) {
  const url = (baseUrl || DEFAULT_API_URL).replace(/\/$/, '');

  // Render (plan gratis) duerme el servidor. El primer intento suele despertarlo
  // y puede cortar por timeout; se reintenta una vez, para entonces ya está
  // despierto y responde. Solo se reintenta ante fallo de red/timeout, nunca
  // ante credenciales incorrectas (401).
  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await axios.post(
        `${url}/api/auth/login`,
        { email, password },
        { timeout: LOGIN_TIMEOUT_MS }
      );
      break;
    } catch (err) {
      const isNetworkOrTimeout = !err.response; // sin respuesta = red/timeout, no credenciales
      if (attempt === 1 && isNetworkOrTimeout) continue;
      throw err;
    }
  }

  const payload = res.data?.data || res.data || {};
  const token   = payload.token;
  const user    = payload.user || null;

  if (!token) {
    throw new Error(res.data?.error || 'El servidor no devolvió un token');
  }

  await AsyncStorage.multiSet([
    [STORAGE_KEYS.TOKEN,    token],
    [STORAGE_KEYS.BASE_URL, url],
    [STORAGE_KEYS.USER,     JSON.stringify(user || {})],
  ]);
  resetClient();

  return { token, user, organization: payload.organization || null };
}

async function clearSession() {
  await AsyncStorage.multiRemove([STORAGE_KEYS.TOKEN, STORAGE_KEYS.USER]);
  resetClient();
}

export async function logout() {
  await clearSession();
}

export async function getSavedSession() {
  const [[, token], [, baseUrl], [, userJson]] = await AsyncStorage.multiGet([
    STORAGE_KEYS.TOKEN, STORAGE_KEYS.BASE_URL, STORAGE_KEYS.USER,
  ]);
  let user = null;
  try { user = userJson ? JSON.parse(userJson) : null; } catch {}
  return { token, baseUrl: baseUrl || DEFAULT_API_URL, user };
}

/** Valida el token guardado contra el backend. Devuelve el usuario o null. */
export async function validateSession() {
  const client = await getClient();
  const res = await client.get('/api/auth/me');
  const user = res.data?.data?.user || null;
  if (user) await AsyncStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
  return user;
}

// ── Rutas asignadas (repartidor) ──────────────────────────────────────

/**
 * Rutas activas del repartidor ('sent' o 'in_progress').
 * Devuelve { routes: [...], route: <la más reciente> }.
 */
export async function getActiveRoutes() {
  const client = await getClient();
  const res = await client.get('/api/delivery/routes/active');
  return {
    routes: res.data?.routes || (res.data?.route ? [res.data.route] : []),
    route:  res.data?.route  || null,
  };
}

/** Detalle de una ruta (para refrescar paradas al volver a la pantalla). */
export async function getRoute(routeId) {
  const client = await getClient();
  const res = await client.get(`/api/delivery/routes/${routeId}`);
  return res.data?.route || null;
}

/**
 * Marcar una parada como entregada, cancelada o pendiente.
 *
 * El stopKey va en el BODY, no en la URL: los pedidos Shopify tienen IDs con
 * barras ("gid://shopify/Order/123") y Express no los matchea como parámetro.
 *
 * @param {number} routeId
 * @param {string} stopKey        "shopify_<id>" o "bot_<id>"
 * @param {string} status         'entregado' | 'cancelled' | 'pending'
 * @param {string} [paymentMethod] 'efectivo' | 'transferencia' | 'otro' — solo al entregar.
 *        Si es transferencia, el pedido queda en "Por cobrar" en el CRM
 *        hasta que llegue el comprobante.
 */
export async function updateStopStatus(routeId, stopKey, status, paymentMethod, note, extras) {
  const client = await getClient();
  const body = { stopKey, status };
  if (paymentMethod) body.paymentMethod = paymentMethod;
  if (note && note.trim()) body.note = note.trim();
  if (Array.isArray(extras) && extras.length) body.extras = extras;
  const res = await client.patch(`/api/delivery/routes/${routeId}/stops`, body);
  return res.data;
}

// Catálogo para venta en ruta ("bandejas extras"). Devuelve { enabled, products }.
export async function getSellCatalog() {
  const client = await getClient();
  const res = await client.get('/api/delivery/catalog');
  return res.data;
}

// ── Resumen del día ───────────────────────────────────────────────────
export async function getDailySummary() {
  const client = await getClient();
  const res = await client.get('/api/delivery/summary');
  return res.data;
}
