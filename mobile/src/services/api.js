import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEYS = {
  TOKEN:    'crm_token',
  BASE_URL: 'crm_base_url',
};

let _client = null;

async function getClient() {
  if (_client) return _client;
  const baseURL = await AsyncStorage.getItem(STORAGE_KEYS.BASE_URL);
  const token   = await AsyncStorage.getItem(STORAGE_KEYS.TOKEN);
  _client = axios.create({
    baseURL: baseURL || 'https://your-backend.railway.app',
    timeout: 15000,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return _client;
}

export function resetClient() {
  _client = null;
}

// ── Auth ─────────────────────────────────────────────────────────────
export async function login(baseUrl, email, password) {
  const url = baseUrl.replace(/\/$/, '');
  const res = await axios.post(`${url}/api/auth/login`, { email, password }, { timeout: 10000 });
  if (res.data.token) {
    await AsyncStorage.setItem(STORAGE_KEYS.TOKEN, res.data.token);
    await AsyncStorage.setItem(STORAGE_KEYS.BASE_URL, url);
    resetClient();
  }
  return res.data;
}

export async function logout() {
  await AsyncStorage.multiRemove([STORAGE_KEYS.TOKEN, STORAGE_KEYS.BASE_URL]);
  resetClient();
}

export async function getSavedCredentials() {
  const [token, baseUrl] = await AsyncStorage.multiGet([STORAGE_KEYS.TOKEN, STORAGE_KEYS.BASE_URL]);
  return { token: token[1], baseUrl: baseUrl[1] };
}

// ── Rutas asignadas (repartidor) ──────────────────────────────────────
export async function getActiveRoute() {
  const client = await getClient();
  const res = await client.get('/api/delivery/routes/active');
  return res.data;
}

/**
 * Marcar una parada como entregada, cancelada o pendiente.
 * @param {number} routeId  ID de la ruta
 * @param {string} stopKey  Clave de la parada: "shopify_<id>" o "bot_<id>"
 * @param {string} status   'entregado' | 'cancelled' | 'pending'
 */
export async function updateStopStatus(routeId, stopKey, status) {
  const client = await getClient();
  const res = await client.patch(`/api/delivery/routes/${routeId}/stops/${stopKey}`, { status });
  return res.data;
}

// ── Resumen del día ───────────────────────────────────────────────────
export async function getDailySummary() {
  const client = await getClient();
  const res = await client.get('/api/delivery/summary');
  return res.data;
}
