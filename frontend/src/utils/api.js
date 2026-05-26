import axios from 'axios';

// En producción VITE_BACKEND_URL = URL del backend de Render (ej: https://whatsapp-crm-api.onrender.com)
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
    if (err.response?.status === 401) {
      localStorage.removeItem('crm_token');
      localStorage.removeItem('crm_user');
      localStorage.removeItem('crm_org');
      window.location.href = '/';
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
  connectShopify: (data) => api.post('/setup/shopify', data).then(r => r.data),
  shopifyStatus: () => api.get('/setup/shopify-status').then(r => r.data),
  complete: () => api.post('/setup/complete').then(r => r.data),
};

export const conversationsAPI = {
  getAll: () => api.get('/conversations').then(r => r.data.data),
  getMessages: (id) => api.get(`/conversations/${id}/messages`).then(r => r.data.data),
  sendMessage: (id, text) => api.post(`/conversations/${id}/messages`, { text }).then(r => r.data.data),
  setAgentMode: (id, mode) => api.patch(`/conversations/${id}/agent-mode`, { mode }).then(r => r.data.data),
  markAsRead: (id) => api.patch(`/conversations/${id}/read`),
  getOrders: (id) => api.get(`/conversations/${id}/orders`).then(r => r.data.data),
  sendEscalationFeedback: (id, feedback) => api.post(`/conversations/${id}/escalation-feedback`, { feedback }).then(r => r.data),
  deleteMessages: (id) => api.delete(`/conversations/${id}/messages`).then(r => r.data),
  startConversation: (data) => api.post('/conversations/start', data).then(r => r.data),
  sendTemplate: (id, data) => api.post(`/conversations/${id}/send-template`, data).then(r => r.data),
};

export const reengagementAPI = {
  getCandidates:        (refresh = false) => api.get(`/reengagement/candidates${refresh ? '?refresh=true' : ''}`, { timeout: 180000 }).then(r => r.data),
  generate:             (phone) => api.post('/reengagement/generate', { phone }).then(r => r.data),
  send:                 (data) => api.post('/reengagement/send', data).then(r => r.data),
  sendBulk:             (items) => api.post('/reengagement/send-bulk', { items }).then(r => r.data),
  getTemplates:         () => api.get('/reengagement/templates').then(r => r.data),
  fillTemplateVars:     (phone, templateBody) => api.post('/reengagement/fill-template-vars', { phone, templateBody }).then(r => r.data),
  calibrate:            () => api.post('/reengagement/calibrate', {}, { timeout: 120000 }).then(r => r.data),
  getCalibration:       () => api.get('/reengagement/calibration').then(r => r.data),
  getAccuracy:          () => api.get('/reengagement/accuracy').then(r => r.data),
  // Bulk template generation from Shopify catalog
  generateBulkTemplates: () => api.post('/reengagement/generate-templates', {}, { timeout: 60000 }).then(r => r.data),
  submitTemplates:       (templates) => api.post('/reengagement/submit-templates', { templates }, { timeout: 60000 }).then(r => r.data),
};

export const templatesAPI = {
  getAll:    () => api.get('/templates').then(r => r.data),
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

export { api };
export default api;
