const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const express = require('express');
const media = require('../src/services/social-media');
const { load } = require('./helpers.cjs');
const secret = 'social-media-local-test-secret-'.repeat(3);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-social-media-test-'));
  const old = { ...process.env };
  process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
  process.env.CRM_PUBLIC_URL = 'https://crm-api.example';
  process.env.NODE_ENV = 'test';
  t.after(async () => {
    for (const key of ['RAILWAY_VOLUME_MOUNT_PATH', 'CRM_PUBLIC_URL', 'NODE_ENV']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
    assert.equal(path.dirname(dir), os.tmpdir());
    await fs.rm(dir, { recursive: true, force: true });
  });
  const image = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#ffc83d' } }).png().toBuffer();
  return { dir, base64: image.toString('base64') };
}

const tokenFrom = result => new URL(result.url).pathname.split('/').at(-1).replace(/\.jpg$/, '');

test('prepares a real PNG as a public JPEG without publishing or storing metadata', async t => {
  const { base64 } = await fixture(t);
  const result = await media.create(7, base64, secret);
  assert.match(result.url, /^https:\/\/crm-api\.example\/social-media\//);
  const info = await sharp(await media.read(tokenFrom(result), secret)).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, 80); assert.equal(info.height, 100);
  assert.equal(info.exif, undefined);
});

test('rejects oversized, corrupted and non-image input without storing files', async t => {
  const { dir } = await fixture(t);
  const invalid = [null, {}, 'not base64', 'AAAA=', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
    Buffer.from('<html><script>alert(1)</script></html>').toString('base64'),
    Buffer.alloc(media.MAX_BYTES + 1).toString('base64')];
  for (const value of invalid) await assert.rejects(media.create(7, value, secret), e => e.status === 400);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('bounds decoded image dimensions and concurrent conversions', async t => {
  const { base64 } = await fixture(t);
  const huge = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(media.create(7, huge.toString('base64'), secret), e => e.status === 400);
  const first = media.create(7, base64, secret);
  const second = media.create(8, base64, secret);
  await assert.rejects(media.create(7, base64, secret), e => e.status === 429);
  await assert.rejects(media.create(9, base64, secret), e => e.status === 429);
  await Promise.all([first, second]);
  assert.ok((await media.create(9, base64, secret)).url);
});

test('capabilities cannot be modified, used as session tokens, or reused after expiry', async t => {
  const { base64 } = await fixture(t);
  const result = await media.create(7, base64, secret);
  const token = tokenFrom(result);
  const claims = jwt.decode(token);
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, orgId: 8 })).toString('base64url');
  const invalid = [parts.join('.'), jwt.sign({ orgId: 7, userId: 1, role: 'owner' }, secret),
    jwt.sign({ orgId: 8, id: claims.id }, secret, { audience: 'social-media-image', expiresIn: '1h' }),
    jwt.sign({ orgId: 7, id: claims.id }, secret, { audience: 'social-media-image', expiresIn: -1 }),
    jwt.sign({ orgId: 7, id: '../../secret' }, secret, { audience: 'social-media-image', expiresIn: '1h' })];
  for (const value of invalid) await assert.rejects(media.read(value, secret), e => e.status === 404);
  assert.ok((await media.read(token, secret)).length);
});

test('only expires this store’s files and preserves other stores', async t => {
  const { dir, base64 } = await fixture(t);
  const first = await media.create(7, base64, secret);
  const other = await media.create(8, base64, secret);
  const firstFile = path.join(dir, 'social-media', '7', `${jwt.decode(tokenFrom(first)).id}.jpg`);
  const old = new Date(Date.now() - (media.TTL_SECONDS + 60) * 1000);
  await fs.utimes(firstFile, old, old);
  await media.create(7, base64, secret);
  await assert.rejects(fs.stat(firstFile), { code: 'ENOENT' });
  assert.ok((await media.read(tokenFrom(other), secret)).length);
});

test('requires a persistent volume and HTTPS origin in production before writing', async t => {
  const { base64 } = await fixture(t);
  process.env.NODE_ENV = 'production';
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  await assert.rejects(media.create(7, base64, secret), e => e.status === 503);
  process.env.NODE_ENV = 'test';
  process.env.CRM_PUBLIC_URL = 'http://crm-api.example';
  await assert.rejects(media.create(7, base64, secret), e => e.status === 503);
});

test('HTTP upload enforces authentication, role and marketing access; public JPEG needs its capability', async t => {
  const { base64 } = await fixture(t);
  let marketing = true;
  const auth = load('src/middleware/auth.js', {
    '../db/database': { getUserById: async id => ({ id, organization_id: 7, role: id === 1 ? 'owner' : 'agent', auth_version: 0 }) },
  }, { process: { env: { JWT_SECRET: secret } } });
  const router = load('src/routes/meta.js', {
    '../middleware/auth': auth,
    '../services/social-media': media,
    '../middleware/commercial-access': { requireSolution: key => {
      assert.equal(key, 'marketing');
      return (_req, res, next) => marketing ? next() : res.status(403).json({ error: 'Marketing no disponible' });
    } },
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.get('/social-media/:token.jpg', router.serveMedia);
  app.use('/api/meta', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = id => jwt.sign({ userId: id, orgId: 7, role: id === 1 ? 'owner' : 'agent', authVersion: 0 }, secret, { expiresIn: '1h' });
  const upload = token => fetch(`${origin}/api/meta/media`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify({ base64, orgId: 8 }) });
  assert.equal((await upload()).status, 401);
  assert.equal((await upload(session(2))).status, 403);
  marketing = false;
  assert.equal((await upload(session(1))).status, 403);
  marketing = true;
  const response = await upload(session(1));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(jwt.decode(tokenFrom(result)).orgId, 7);
  assert.equal((await upload(tokenFrom(result))).status, 401);
  const image = await fetch(`${origin}${new URL(result.url).pathname}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${origin}/social-media/${session(1)}.jpg`)).status, 404);
});
