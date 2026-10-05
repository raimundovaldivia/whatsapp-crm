import axios from 'axios';

// En producción VITE_BACKEND_URL = URL del backend de Railway (ej: https://whatsapp-crm-api-production-f804.up.railway.app)
// En desarrollo = localhost:3001
const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const api = axios.create({ baseURL: `${BASE_URL}/api`, timeout: 12000 });

// Inyectar token JWT en cada request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('crm_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Si el token expira, redirigir al login
api.interceptors.response.use(
  r => r,
  err => {
    const url = String(err.config?.url || '');
    const isAuthAttempt = url.endsWith('/auth/login') || url.endsWith('/auth/register');
    if (err.response?.status === 401 && !isAuthAttempt) {
      localStorage.removeItem('crm_token');
      localStorage.removeItem('crm_user');
      localStorage.removeItem('crm_org');
      // Evita un bucle de recarga si varias solicitudes fallan a la vez.
      if (window.location.pathname !== '/') window.location.replace('/');
    }
    return Promise.reject(err);
  }
);

export const authAPI = {
  register: (data) => api.post('/auth/register', data).then(r => r.data.data),
  login: (data) => api.post('/auth/login', data).then(r => r.data.data),
  me: () => api.get('/auth/me').then(r => r.data.data),
};

export const setupAPI = {
  status: () => api.get('/setup/status').then(r => r.data.data),
  connectWhatsApp: (data) => api.post('/setup/whatsapp', data).then(r => r.data),
  shopifyStatus: () => api.get('/setup/shopify-status').then(r => r.data),
  whatsappStatus: () => api.get('/setup/whatsapp-status').then(r => r.data),
  complete: () => api.post('/setup/complete').then(r => r.data),
  getShopifyAuthUrl: (shop) => api.get(`/shopify-oauth/auth-url?shop=${shop}`).then(r => r.data),
};

export const conversationsAPI = {
  getAll: () => api.get('/conversations').then(r => r.data.data),
  getByPhone: (phone) => api.get('/conversations/search-by-phone', { params: { phone } }).then(r => r.data.conversations || []),
  getMessages: (id) => api.get(`/conversations/${id}/messages`).then(r => r.data.data),
  sendMessage: (id, text) => api.post(`/conversations/${id}/messages`, { text }).then(r => r.data.data),
  sendMedia: (id, data) => api.post(`/conversations/${id}/media`, data, { timeout: 120000 }).then(r => r.data.data),
  setAgentMode: (id, mode) => api.patch(`/conversations/${id}/agent-mode`, { mode }).then(r => r.data.data),
  markAsRead: (id) => api.patch(`/conversations/${id}/read`),
  getOrders: (id) => api.get(`/conversations/${id}/orders`).then(r => r.data.data),
  sendEscalationFeedback: (id, feedback) => api.post(`/conversations/${id}/escalation-feedback`, { feedback }).then(r => r.data),
  deleteMessages: (id) => api.delete(`/conversations/${id}/messages`).then(r => r.data),
  startConversation: (data) => api.post('/conversations/start', data).then(r => r.data),
  sendTemplate: (id, data) => api.post(`/conversations/${id}/send-template`, data).then(r => r.data),
  getUnanswered: (hours = 48) => api.get(`/conversations/unanswered?hours=${hours}`).then(r => r.data),
  retryUnanswered: (hours = 48) => api.post('/conversations/retry-unanswered', { hours }, { timeout: 120000 }).then(r => r.data),
};

export const settingsAPI = {
  testBot: (data) => api.post('/settings/test-bot', data, { timeout: 30000 }).then(r => r.data),
};

export const assistantAPI = {
  chat:           (data) => api.post('/assistant/chat', data, { timeout: 40000 }).then(r => r.data),
  getHistory:     ()     => api.get('/assistant/history').then(r => r.data),
  clearHistory:   ()     => api.delete('/assistant/history').then(r => r.data),
};

// Store context and delivery info — now served from /api/settings
export const storeSettingsAPI = {
  getStoreContext:  () => api.get('/settings/store-context', { timeout: 20000 }).then(r => r.data),
  saveStoreContext: (context) => api.post('/settings/store-context', { context }).then(r => r.data),
  syncStoreContext: () => api.post('/settings/store-context/sync', {}, { timeout: 30000 }).then(r => r.data),
  getDeliveryInfo:  () => api.get('/settings/delivery-info').then(r => r.data),
  saveDeliveryInfo: (info) => api.post('/settings/delivery-info', info).then(r => r.data),
};

export const templatesAPI = {
  getAll:    () => api.get('/templates').then(r => r.data),
  getAutomation: () => api.get('/templates/automation').then(r => r.data),
  saveAutomation: (assignments) => api.put('/templates/automation', { assignments }).then(r => r.data),
  create:    (data) => api.post('/templates', data).then(r => r.data),
  delete:    (name) => api.delete(`/templates/${encodeURIComponent(name)}`).then(r => r.data),
  generate:  (goal, category = 'MARKETING', language = 'es') =>
               api.post('/templates/generate', { goal, category, language }, { timeout: 30000 }).then(r => r.data),
};

export const ordersAPI = {
  getAll:      () => api.get('/orders').then(r => r.data.data),
  getStats:    () => api.get('/orders/stats').then(r => r.data.data),
  getById:     (id) => api.get(`/orders/${id}`).then(r => r.data.data),
  setStatus:   (id, status) => api.patch(`/orders/${id}/status`, { status }).then(r => r.data.data),
  resendLink:  (id) => api.post(`/orders/${id}/resend-link`).then(r => r.data),
  syncShopify: (id) => api.post(`/orders/${id}/sync-shopify`).then(r => r.data.data),
};

export const catalogoAPI = {
  getAll:  (params) => api.get('/catalogo', { params }).then(r => r.data),
  sync:    () => api.post('/catalogo/sync').then(r => r.data),
};

export const dashboardAPI = {
  getWins: () => api.get('/dashboard/wins').then(r => r.data.data),
};

export const paymentProofsAPI = {
  getAll:  (status) => api.get('/payment-proofs', { params: status ? { status } : {} }).then(r => r.data.proofs),
  getAccounts: (month) => api.get('/payment-proofs/accounts', { params: month ? { month } : {} }).then(r => r.data),
  imageUrl: (id)   => `${BASE_URL}/api/payment-proofs/${id}/image`,
  update:  (id, data) => api.patch(`/payment-proofs/${id}`, data).then(r => r.data.proof),
};

export const reengagementAPI = {
  getCandidates: (forceRefresh = false) =>
    api.get(`/reengagement/candidates${forceRefresh ? '?refresh=true' : ''}`).then(r => r.data),
  getCalibration: () => api.get('/reengagement/calibration').then(r => r.data),
  calibrate:      () => api.post('/reengagement/calibrate').then(r => r.data),
  getTemplates:   () => api.get('/reengagement/templates').then(r => r.data),
  aiPickTemplate: (phone, templates) =>
    api.post('/reengagement/ai-pick-template', { phone, templates }).then(r => r.data),
  send:     (data) => api.post('/reengagement/send', data).then(r => r.data),
  sendBulk: (items) => api.post('/reengagement/send-bulk', { items }, { timeout: 600000 }).then(r => r.data),
};

export const adminAlertsAPI = {
  list:    ()   => api.get('/admin-alerts').then(r => r.data),
  flush:   ()   => api.post('/admin-alerts/flush').then(r => r.data),
  dismiss: (id) => api.delete(`/admin-alerts/${id}`).then(r => r.data),
};

export const metaAPI = {
  status:       () => api.get('/meta/status').then(r => r.data),
  authUrl:      () => api.get('/meta/auth-url').then(r => r.data.url),
  assets:       () => api.get('/meta/assets').then(r => r.data),
  selectAssets: data => api.patch('/meta/assets', data).then(r => r.data),
  disconnect:   () => api.delete('/meta/connection').then(r => r.data),
  threads:      () => api.get('/meta/threads').then(r => r.data.threads),
  messages:     id => api.get(`/meta/threads/${id}/messages`).then(r => r.data.messages),
  sendMessage:  (id, text) => api.post(`/meta/threads/${id}/messages`, { text }).then(r => r.data.message),
  insights:     params => api.get('/meta/ads/insights', { params }).then(r => r.data),
  campaigns:    () => api.get('/meta/ads/campaigns').then(r => r.data.campaigns),
  publish:      data => api.post('/meta/publish', data, { timeout: 45000 }).then(r => r.data),
};

export const API_BASE = BASE_URL;

export { api };
export default api;
