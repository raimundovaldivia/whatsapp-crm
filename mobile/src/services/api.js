import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEYS = {
  TOKEN:    'crm_token',
  BASE_URL: 'crm_base_url',
};

// Instancia de axios configurable por URL base guardada
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

// Resetear cliente (al cambiar URL o token)
export function resetClient() {
  _client = null;
}

// ── Auth ────────────────────────────────────────────────────────────
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

// ── Delivery endpoints ──────────────────────────────────────────────
export async function getDeliveryOrders() {
  const client = await getClient();
  const res = await client.get('/api/delivery/orders');
  return res.data;
}

export async function optimizeRoute(orders, origin) {
  const client = await getClient();
  const res = await client.post('/api/delivery/optimize', { orders, origin });
  return res.data;
}

export async function updateOrderStatus(id, source, status) {
  const client = await getClient();
  const res = await client.patch(`/api/delivery/orders/${id}/status`, { status, source });
  return res.data;
}

export async function getDailySummary() {
  const client = await getClient();
  const res = await client.get('/api/delivery/summary');
  return res.data;
}
