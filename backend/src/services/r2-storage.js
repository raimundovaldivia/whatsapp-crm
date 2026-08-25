/**
 * r2-storage.js — Subida de imágenes a Cloudflare R2
 *
 * R2 es 100% compatible con S3 API. Gratis hasta 10 GB storage.
 *
 * Variables de entorno requeridas:
 *   R2_ACCOUNT_ID       — ID de tu cuenta Cloudflare
 *   R2_ACCESS_KEY_ID    — R2 API Token → Key ID
 *   R2_SECRET_ACCESS_KEY — R2 API Token → Secret
 *   R2_BUCKET_NAME      — Nombre del bucket (ej: "crm-products")
 *   R2_PUBLIC_URL       — URL pública del bucket (ej: "https://pub-xxx.r2.dev")
 *
 * Cómo obtener credenciales:
 *   1. cloudflare.com → R2 → Create Bucket → nombre: crm-products
 *   2. R2 → Manage API Tokens → Create Token → permisos: Object Read & Write
 *   3. Settings → Bucket → Public Access → Allow Access
 *   4. Copiar: Account ID, Access Key ID, Secret, y la URL pública
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const path  = require('path');
const crypto = require('crypto');

const isConfigured = () =>
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL;

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Descarga una imagen de cualquier URL y la sube a R2.
 * @param {string} sourceUrl — URL de origen (ej: Shopify CDN)
 * @param {string} prefix    — Carpeta en el bucket (ej: "products")
 * @returns {string} URL pública en R2
 */
async function uploadFromUrl(sourceUrl, prefix = 'products') {
  if (!isConfigured()) {
    throw new Error('R2 no configurado. Agrega las variables R2_* en Railway.');
  }

  // Descargar imagen
  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'WhatsApp-CRM/1.0' },
  });

  const contentType = response.headers['content-type'] || 'image/jpeg';
  const ext = extensionFromContentType(contentType);

  // Nombre único basado en hash del source URL
  const hash = crypto.createHash('md5').update(sourceUrl).digest('hex').slice(0, 12);
  const key  = `${prefix}/${hash}${ext}`;

  // Subir a R2
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         key,
    Body:        Buffer.from(response.data),
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}

/**
 * Sube un buffer directamente a R2.
 * @param {Buffer} buffer
 * @param {string} filename — nombre de archivo con extensión
 * @param {string} contentType
 * @param {string} prefix
 */
async function uploadBuffer(buffer, filename, contentType, prefix = 'products') {
  if (!isConfigured()) {
    throw new Error('R2 no configurado.');
  }

  const hash = crypto.randomBytes(6).toString('hex');
  const ext  = path.extname(filename) || extensionFromContentType(contentType);
  const key  = `${prefix}/${hash}${ext}`;

  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         key,
    Body:        buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}

function extensionFromContentType(ct) {
  if (ct.includes('png'))  return '.png';
  if (ct.includes('gif'))  return '.gif';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('svg'))  return '.svg';
  return '.jpg';
}

module.exports = { uploadFromUrl, uploadBuffer, isConfigured };
