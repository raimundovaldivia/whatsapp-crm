const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

// SVG is not an accepted upload; block its decoder before inspecting metadata.
sharp.block({ operation: ['VipsForeignLoadSvg'] });

const MAX_BYTES = 6 * 1024 * 1024;
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_FILES = 100;
const AUDIENCE = 'social-media-image';
const locks = new Set();

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function directory(orgId) {
  if (!Number.isSafeInteger(orgId) || orgId < 1) throw failure('Tienda inválida');
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (process.env.NODE_ENV === 'production' && !volume) {
    throw failure('El almacenamiento de imágenes no está disponible.', 503);
  }
  return path.join(volume || path.join(__dirname, '../../data'), 'social-media', String(orgId));
}

function publicOrigin() {
  let url;
  try { url = new URL(process.env.CRM_PUBLIC_URL); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw failure('El enlace público de imágenes no está configurado.', 503);
  }
  return url.origin;
}

async function create(orgId, base64, secret) {
  const dir = directory(orgId);
  const origin = publicOrigin();
  if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(MAX_BYTES / 3) * 4
      || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw failure('Elige una imagen JPG, PNG o WebP de hasta 6 MB.');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== base64) throw failure('La imagen no es válida o supera el límite de 6 MB.');
  if (locks.has(orgId) || locks.size >= 2) throw failure('Hay imágenes procesándose. Inténtalo nuevamente en unos segundos.', 429);
  locks.add(orgId);
  try {
    let image;
    try {
      const source = sharp(bytes, { limitInputPixels: 16000000, failOn: 'warning' });
      const info = await source.metadata();
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages || 1) > 1) throw new Error('format');
      // Decode/re-encode rather than hosting arbitrary bytes or embedded metadata.
      image = await source.rotate().resize({ width: 1440, height: 1920, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
    } catch {
      throw failure('No se pudo leer la imagen. Elige un JPG, PNG o WebP válido, sin animación.');
    }
    if (image.length > MAX_BYTES) throw failure('La imagen es demasiado grande. Usa una resolución menor.');
    await fs.mkdir(dir, { recursive: true });
    let count = 0;
    for (const name of await fs.readdir(dir)) {
      if (!/^[a-f0-9]{40}\.jpg$/.test(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > TTL_SECONDS * 1000) await fs.unlink(file);
      else count += 1;
    }
    if (count >= MAX_FILES) throw failure('Esta tienda alcanzó el límite de imágenes de esta semana.', 429);
    const id = crypto.randomBytes(20).toString('hex');
    const token = jwt.sign({ orgId, id }, secret, { algorithm: 'HS256', audience: AUDIENCE, expiresIn: TTL_SECONDS });
    await fs.writeFile(path.join(dir, `${id}.jpg`), image, { flag: 'wx', mode: 0o600 });
    return { url: `${origin}/social-media/${token}.jpg`, contentType: 'image/jpeg', expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString() };
  } finally {
    locks.delete(orgId);
  }
}

async function read(token, secret) {
  if (typeof token !== 'string' || token.length > 1024) throw failure('Imagen no disponible.', 404);
  let grant;
  try { grant = jwt.verify(token, secret, { algorithms: ['HS256'], audience: AUDIENCE }); }
  catch { throw failure('Imagen no disponible.', 404); }
  if (!Number.isSafeInteger(grant.orgId) || grant.orgId < 1 || !/^[a-f0-9]{40}$/.test(grant.id || '')
      || !Number.isInteger(grant.exp)) throw failure('Imagen no disponible.', 404);
  try { return await fs.readFile(path.join(directory(grant.orgId), `${grant.id}.jpg`)); }
  catch { throw failure('Imagen no disponible.', 404); }
}

module.exports = { create, read, MAX_BYTES, TTL_SECONDS };
