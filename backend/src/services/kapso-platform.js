/**
 * kapso-platform.js — Kapso Platform API (multi-tenant)
 *
 * Permite que tus clientes conecten su propio WhatsApp en ~5 minutos
 * sin escribir ningún dato manualmente. El flujo es:
 *
 *   1. Tu backend crea un "customer" en Kapso (una vez por organización)
 *   2. Generas un "setup link" para ese customer
 *   3. El cliente hace clic → login con Facebook → conecta su WhatsApp
 *   4. Kapso redirige al cliente a tu FRONTEND_URL con phone_number_id en la URL
 *   5. Tu frontend llama a /api/setup/kapso/save → config guardada automáticamente
 *
 * Variable de entorno requerida:
 *   KAPSO_API_KEY  → API Key del dueño de la plataforma (app.kapso.ai → Settings → API Keys)
 *                    Esta es UNA SOLA key global, no por cliente.
 *
 * Docs: https://docs.kapso.ai/docs/platform/customer-guide
 */

const axios = require('axios');

const PLATFORM_URL = 'https://api.kapso.ai/platform/v1';

function getClient() {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) throw new Error('KAPSO_API_KEY no está configurada en las variables de entorno');
  return axios.create({
    baseURL: PLATFORM_URL,
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

/**
 * Crea un "customer" en Kapso para una organización.
 * Si ya existe (external_customer_id ya usado), Kapso devuelve error — usar upsert.
 *
 * @param {string|number} orgId   - ID de la org en tu DB (usado como external_customer_id)
 * @param {string}        orgName - Nombre de la organización
 * @returns {{ id, name, external_customer_id }}
 */
async function createCustomer(orgId, orgName) {
  const client = getClient();
  const { data } = await client.post('/customers', {
    customer: {
      name:                 orgName || `Org ${orgId}`,
      external_customer_id: String(orgId),
    },
  });
  return data.data;
}

/**
 * Genera un setup link para que el cliente conecte su WhatsApp.
 * El link expira en 30 días y es de un solo uso.
 *
 * @param {string} kapsoCustomerId   - ID del customer en Kapso
 * @param {string} successRedirectUrl - URL a donde redirigir cuando el cliente termine
 * @param {string} failureRedirectUrl - URL a donde redirigir si falla
 * @returns {{ id, url, expires_at }}
 */
async function generateSetupLink(kapsoCustomerId, successRedirectUrl, failureRedirectUrl) {
  const client = getClient();
  const { data } = await client.post(`/customers/${kapsoCustomerId}/setup_links`, {
    setup_link: {
      success_redirect_url: successRedirectUrl,
      failure_redirect_url: failureRedirectUrl || successRedirectUrl.replace('success', 'failure'),
    },
  });
  return data.data;
}

/**
 * Obtiene un customer de Kapso por su ID interno.
 */
async function getCustomer(kapsoCustomerId) {
  const client = getClient();
  const { data } = await client.get(`/customers/${kapsoCustomerId}`);
  return data.data;
}

/**
 * Busca el customer de Kapso por external_customer_id (= orgId).
 * Útil para recuperar el ID de Kapso si se perdió en DB.
 */
async function findCustomerByExternalId(orgId) {
  try {
    const client = getClient();
    const { data } = await client.get('/customers', {
      params: { external_customer_id: String(orgId) },
    });
    const customers = data.data || [];
    return customers[0] || null;
  } catch {
    return null;
  }
}

/**
 * Registra un webhook de mensajes para un número de teléfono específico.
 * Usa el endpoint correcto de la Platform API v1.
 *
 * Endpoint: POST /platform/v1/whatsapp/phone_numbers/{phone_number_id}/webhooks
 * Docs: https://docs.kapso.ai/api/platform/v1/webhooks/create-webhook.md
 *
 * @param {string} phoneNumberId  - Meta phone number ID
 * @param {string} webhookUrl     - URL pública del backend (ej: https://backend.onrender.com/kapso-webhook)
 * @param {string} [secretKey]    - Opcional: secret para verificar firmas HMAC
 * @returns {{ id, url, events, active }}
 */
async function registerNumberWebhook(phoneNumberId, webhookUrl, secretKey = null) {
  const client = getClient();
  // Kapso requiere secret_key obligatorio — generar uno si no se provee
  const crypto = require('crypto');
  const secret = secretKey || crypto.randomBytes(24).toString('hex');

  const { data } = await client.post(
    `/whatsapp/phone_numbers/${phoneNumberId}/webhooks`,
    {
      whatsapp_webhook: {
        url:             webhookUrl,
        secret_key:      secret,
        events:          ['whatsapp.message.received', 'whatsapp.message.delivered', 'whatsapp.message.read'],
        active:          true,
        payload_version: 'v2',  // evento en header X-Webhook-Event, no en body
      },
    }
  );
  return { ...data.data, generatedSecret: secret };
}

module.exports = { createCustomer, generateSetupLink, getCustomer, findCustomerByExternalId, registerNumberWebhook };
