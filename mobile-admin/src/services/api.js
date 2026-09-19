/**
 * api.js — Cliente HTTP de la app Central (admin).
 *
 * Habla con el mismo backend del CRM (/api/*). Requiere una cuenta con rol
 * owner / admin / supervisor. Guarda el token JWT en AsyncStorage.
 */
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_API_URL, API_TIMEOUT_MS, LOGIN_TIMEOUT_MS } from '../config';

const KEYS = { TOKEN: 'central_token', BASE: 'central_base_url', USER: 'central_user' };

let _client = null;
const sessionListeners = new Set();
export function onSessionExpired(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn); }

async function baseURL() { return (await AsyncStorage.getItem(KEYS.BASE)) || DEFAULT_API_URL; }

async function getClient() {
  if (_client) return _client;
  const token = await AsyncStorage.getItem(KEYS.TOKEN);
  _client = axios.create({
    baseURL: await baseURL(),
    timeout: API_TIMEOUT_MS,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  _client.interceptors.response.use(
    r => r,
    async err => {
      if (err.response?.status === 401) {
        await clearSession();
        sessionListeners.forEach(fn => { try { fn(); } catch {} });
      }
      return Promise.reject(err);
    }
  );
  return _client;
}

function resetClient() { _client = null; }

export async function getSession() {
  const [token, userRaw] = await Promise.all([
    AsyncStorage.getItem(KEYS.TOKEN),
    AsyncStorage.getItem(KEYS.USER),
  ]);
  let user = null;
  try { user = userRaw ? JSON.parse(userRaw) : null; } catch {}
  return { token, user };
}

export async function clearSession() {
  await Promise.all([AsyncStorage.removeItem(KEYS.TOKEN), AsyncStorage.removeItem(KEYS.USER)]);
  resetClient();
}

// ── Auth ────────────────────────────────────────────────────────────────
export async function login(email, password) {
  const url = await baseURL();
  const { data } = await axios.post(`${url}/api/auth/login`, { email, password }, { timeout: LOGIN_TIMEOUT_MS });
  if (!data?.success) throw new Error(data?.error || 'No se pudo iniciar sesión');
  const { token, user } = data.data;
  const role = user.role;
  if (!['owner', 'admin', 'supervisor'].includes(role)) {
    throw new Error('Esta app es solo para administradores. Tu cuenta es de otro tipo.');
  }
  await AsyncStorage.setItem(KEYS.TOKEN, token);
  await AsyncStorage.setItem(KEYS.USER, JSON.stringify(user));
  resetClient();
  return user;
}

// ── Conversaciones (chat) ────────────────────────────────────────────────
export async function getConversations() {
  const c = await getClient();
  const { data } = await c.get('/api/conversations');
  return data.data || [];
}
export async function getMessages(convId, limit = 50) {
  const c = await getClient();
  const { data } = await c.get(`/api/conversations/${convId}/messages?limit=${limit}`);
  return data.data || { conversation: null, messages: [] };
}
export async function sendMessage(convId, content) {
  const c = await getClient();
  const { data } = await c.post(`/api/conversations/${convId}/messages`, { text: content });
  return data;
}
export async function setAgentMode(convId, mode) {   // 'human' | 'ai'
  const c = await getClient();
  const { data } = await c.patch(`/api/conversations/${convId}/agent-mode`, { mode });
  return data;
}
export async function markRead(convId) {
  const c = await getClient();
  try { await c.patch(`/api/conversations/${convId}/read`, {}); } catch {}
}

// ── Pedidos ──────────────────────────────────────────────────────────────
export async function getOrders() {
  const c = await getClient();
  const { data } = await c.get('/api/orders');
  return data.data || data.orders || [];
}
export async function setOrderStatus(orderId, status) {
  const c = await getClient();
  const { data } = await c.patch(`/api/orders/${orderId}/status`, { status });
  return data;
}
export async function getPendingCharges() {
  const c = await getClient();
  const { data } = await c.get('/api/orders/pending-charge');
  return data.data || data.orders || data.charges || [];
}

// ── Repartos / Despachos ─────────────────────────────────────────────────
export async function getDispatches(from, to, driver) {
  const c = await getClient();
  const q = new URLSearchParams({ from, to });
  if (driver) q.set('driver', driver);
  const { data } = await c.get(`/api/delivery/dispatches?${q.toString()}`);
  return data.rows || [];
}
export async function getExpenses(from, to) {
  const c = await getClient();
  const { data } = await c.get(`/api/delivery/expenses?from=${from}&to=${to}`);
  return data.expenses || [];
}
export async function getPendingOrders() {
  const c = await getClient();
  const { data } = await c.get('/api/delivery/orders');
  return data.orders || [];
}

// ── Avisos (admin-alerts) ────────────────────────────────────────────────
export async function getAlerts() {
  const c = await getClient();
  const { data } = await c.get('/api/admin-alerts');
  return data.data || data.alerts || [];
}
export async function dismissAlert(id) {
  const c = await getClient();
  try { await c.delete(`/api/admin-alerts/${id}`); } catch {}
}

// ── Push token ───────────────────────────────────────────────────────────
export async function registerPushToken(expoToken) {
  const c = await getClient();
  try { await c.post('/api/push/register', { token: expoToken, platform: 'expo' }); } catch (e) {
    // silencioso: la app funciona sin push
  }
}
