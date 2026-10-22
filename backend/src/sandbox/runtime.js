// Opt-in development runtime. Never enable against an existing database.
const crypto = require('node:crypto');

function validateEnvironment(env) {
  if (env.CRM_SANDBOX !== '1') throw new Error('CRM_SANDBOX=1 requerido');
  if (env.NODE_ENV !== 'development') throw new Error('Sandbox requiere NODE_ENV=development');
  const url = new URL(env.DATABASE_URL);
  if (env.CRM_SANDBOX_PLATFORM === 'railway') {
    if (env.RAILWAY_PROJECT_NAME !== 'whatsapp-crm-qa' || env.RAILWAY_ENVIRONMENT_NAME !== 'qa'
        || url.protocol !== 'postgresql:' || url.hostname !== 'qa-db.railway.internal'
        || url.port !== '5432' || url.pathname !== '/crm_sandbox'
        || url.username !== 'crm_sandbox' || !/^[a-f0-9]{64}$/.test(url.password)
        || url.search || url.hash) {
      throw new Error('Railway sandbox requiere proyecto QA y base privada exclusiva');
    }
  } else if (url.protocol !== 'postgresql:' || url.hostname !== 'db' || url.port !== '5432'
      || url.pathname !== '/crm_sandbox' || url.username !== 'crm_sandbox'
      || url.password !== 'crm_sandbox' || url.search || url.hash) {
    throw new Error('Sandbox solo admite la base db:5432/crm_sandbox de Compose');
  }
  for (const key of Object.keys(env)) {
    if (env[key] && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|APP_SECRET|API_SECRET|ENCRYPTION_KEY|WEBHOOK_SECRET|WHATSAPP_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY|PGHOST|PGSERVICE|PGSERVICEFILE|PGHOSTADDR|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGOPTIONS|NODE_OPTIONS)/i.test(key)) {
      throw new Error(`Sandbox no admite credenciales ni overrides externos: ${key}`);
    }
  }
  if (!env.SANDBOX_OWNER_PASSWORD || env.SANDBOX_OWNER_PASSWORD.length < 12) {
    throw new Error('SANDBOX_OWNER_PASSWORD debe tener al menos 12 caracteres');
  }
}

function blocked() {
  throw Object.assign(new Error('SANDBOX: integración externa bloqueada'), { code: 'SANDBOX_EGRESS_BLOCKED' });
}

function installNetworkGuards(env = process.env) {
  if (env.CRM_SANDBOX_PLATFORM === 'railway') {
    const net = require('node:net');
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const params = Array.isArray(args[0]) ? args[0] : args;
      const options = typeof params[0] === 'object' ? params[0]
        : { port: params[0], host: typeof params[1] === 'string' ? params[1] : 'localhost' };
      if (options.path || options.host !== 'qa-db.railway.internal' || Number(options.port) !== 5432) blocked();
      return connect.apply(this, args);
    };
  }
  // Defense in depth; Compose's internal network is the network boundary.
  const axios = require('axios');
  axios.defaults.adapter = async () => blocked();
  globalThis.fetch = async () => blocked();
  for (const module of ['node:http', 'node:https']) {
    const client = require(module);
    client.request = blocked;
    client.get = blocked;
  }
}

function installSimulators() {
  const outbox = [];
  const simulate = provider => async (to, content) => {
    const id = `sandbox-${crypto.randomUUID()}`;
    const event = { id, provider, to: String(to), kind: typeof content === 'string' ? 'text' : 'media' };
    outbox.push(event);
    if (outbox.length > 1000) outbox.shift();
    console.log('[SANDBOX WhatsApp simulado]', JSON.stringify(event));
    return { messageId: id, messages: [{ id }], key: { id }, status: 'sent', simulated: true };
  };
  for (const name of ['whatsapp', 'twilio-whatsapp', 'kapso-whatsapp', 'evolution-whatsapp']) {
    const provider = require(`../services/${name}`);
    provider.sendTextMessage = simulate(name);
    provider.sendMediaMessage = simulate(name);
    if (provider.sendTemplate) provider.sendTemplate = simulate(name);
    if (provider.markAsRead) provider.markAsRead = async () => ({ simulated: true });
  }
  const ai = require('../services/ai-provider');
  ai.client.messages.create = async () => ({
    content: [{ type: 'text', text: '[SANDBOX] Respuesta ficticia de IA. No se llamó a ningún proveedor.' }],
    stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 },
  });
  require('../services/broadcast-worker').start = () => {};
  return outbox;
}

function initialize(env = process.env) {
  validateEnvironment(env);
  // Sessions intentionally expire on every sandbox restart. Never reuse a production secret.
  env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  installNetworkGuards(env);
  const outbox = installSimulators();
  console.log('[SANDBOX] Integraciones simuladas/bloqueadas; trabajos automáticos desactivados.');
  return { outbox };
}

module.exports = { validateEnvironment, installNetworkGuards, installSimulators, initialize };
