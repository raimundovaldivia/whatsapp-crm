const crypto = require('crypto');
const axios = require('axios');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta configurar ${name}`);
  return value;
}

function encryptionKey() {
  const source = process.env.META_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!source || source.length < 32) throw new Error('Falta META_TOKEN_ENCRYPTION_KEY (32+ caracteres)');
  return crypto.createHash('sha256').update(source).digest();
}

function encryptToken(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptToken(value) {
  if (!value) return null;
  const [version, iv, tag, payload] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !payload) throw new Error('Token Meta almacenado con formato inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
}

function appSecretProof(token) {
  return crypto.createHmac('sha256', requiredEnv('META_APP_SECRET')).update(token).digest('hex');
}

async function graphGet(path, token, params = {}) {
  const response = await axios.get(`${GRAPH_URL}/${String(path).replace(/^\//, '')}`, {
    params: { ...params, access_token: token, appsecret_proof: appSecretProof(token) },
    timeout: 20000,
  });
  return response.data;
}

async function graphPost(path, token, data = {}) {
  const response = await axios.post(`${GRAPH_URL}/${String(path).replace(/^\//, '')}`, {
    ...data,
    access_token: token,
    appsecret_proof: appSecretProof(token),
  }, { timeout: 30000 });
  return response.data;
}

function graphError(error) {
  const detail = error.response?.data?.error;
  if (!detail) return error.message;
  return detail.error_user_msg || detail.message || error.message;
}

module.exports = {
  GRAPH_VERSION,
  GRAPH_URL,
  requiredEnv,
  encryptToken,
  decryptToken,
  graphGet,
  graphPost,
  graphError,
};
