const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response } = require('./helpers.cjs');
const future = () => new Date(Date.now() + 3600000).toISOString();
const textPost = () => ({ platform: 'facebook', media_type: 'text', message: 'Texto aprobado', scheduled_for: future() });
const url = 'https://cdn.example.com/archivo.mp4';

function transport(overrides = {}) {
  const calls = [];
  const api = {
    GRAPH_VERSION: 'v26.0', decryptToken: () => 'mock-token',
    graphPost: async (endpoint, token, body) => { calls.push({ endpoint, body }); return endpoint.endsWith('video_reels') ? { video_id: '123', success: true } : { id: '456' }; },
    graphGet: async () => ({ status_code: 'FINISHED', status: { video_status: 'ready' } }),
    ...overrides,
  };
  const service = load('src/services/social-publishing.js', {
    './meta-platform': api, './safe-media': { publicTarget: async () => ({}) },
    axios: { post: async (endpoint, body, options) => { calls.push({ endpoint, body, options }); return { data: { success: true } }; } },
  }, { setTimeout: fn => { fn(); } });
  return { ...service, calls };
}

test('transportes: Facebook texto, imagen, video y Reel; Instagram imagen, video, Reel e historia', async () => {
  for (const [platform, type, expected] of [
    ['facebook','text','page/feed'], ['facebook','image','page/photos'], ['facebook','video','page/videos'],
    ['facebook','reel','page/video_reels'], ['instagram','image','ig/media'], ['instagram','video','ig/media'],
    ['instagram','reel','ig/media'], ['instagram_story','image','ig/media'],
  ]) {
    const t = transport();
    const post = { platform, media_type: type, message: 'Texto', image_url: type === 'text' ? '' : url };
    await t.publishContent({ status: 'connected', page_id: 'page', instagram_account_id: 'ig' }, post);
    assert.equal(t.calls[0].endpoint, expected);
    if (platform === 'instagram' && type !== 'image') assert.equal(t.calls[0].body.media_type, 'REELS');
    if (platform === 'instagram_story') assert.equal(t.calls[0].body.media_type, 'STORIES');
    if (platform === 'facebook' && type === 'reel') {
      assert.equal(t.calls[1].endpoint, 'https://rupload.facebook.com/video-upload/v26.0/123');
      assert.equal(t.calls[1].options.maxRedirects, 0);
      assert.equal(t.calls[2].body.video_state, 'PUBLISHED');
    }
  }
});

test('validación y procesamiento: no publica contenido inválido ni contenedores fallidos', async () => {
  const t = transport();
  for (const post of [
    { platform: 'tiktok' }, { platform: 'instagram', media_type: 'text', message: 'hola' },
    { platform: 'facebook', media_type: 'text', message: '' }, { platform: 'instagram', image_url: 'http://example.com/a.jpg' },
    { platform: 'instagram', image_url: 'https://user:password@example.com/a.jpg' },
    { platform: 'instagram', image_url: url, message: 'x'.repeat(2201) },
  ]) assert.ok(t.validateContent(post));
  const broken = transport({ graphGet: async () => ({ status_code: 'ERROR' }) });
  await assert.rejects(broken.publishContent({ status: 'connected', instagram_account_id: 'ig' }, { platform: 'instagram', media_type: 'reel', image_url: url }), /procesar/);
  assert.equal(broken.calls.length, 1);
  const slow = transport({ graphGet: async () => ({ status_code: 'IN_PROGRESS' }) });
  await assert.rejects(slow.publishContent({ status: 'connected', instagram_account_id: 'ig' }, { platform: 'instagram', image_url: url }), /procesando/);
  assert.equal(slow.calls.length, 1);
});

test('API: exige sesión y owner/admin, aplica Marketing y valida antes de persistir', async () => {
  const users = { 11: { id: 11, organization_id: 1, role: 'admin' }, 12: { id: 12, organization_id: 1, role: 'agent' } };
  const auth = load('src/middleware/auth.js', { '../db/database': { getUserById: async id => users[id] } });
  let disabled = false;
  const writes = [];
  const router = load('src/routes/social-stories.js', {
    '../middleware/auth': auth,
    '../middleware/commercial-access': { requireSolution: key => async (req, res, next) => { assert.equal(key, 'marketing'); if (disabled) return res.status(403).json({ error: 'disabled' }); next(); } },
    '../services/social-publishing': transport(),
    '../services/social-stories': { createPost: async (...args) => { writes.push(args); return { id: 1, checks: { ok: true } }; } },
  });
  for (const id of [null, 12, 11]) {
    const req = { headers: id ? { authorization: `Bearer ${auth.generateToken(users[id])}` } : {}, method: 'POST', path: '/', originalUrl: '/api/social-stories', query: {}, body: { ...textPost(), organization_id: 999 } };
    const res = response(); let allowed = true;
    for (const layer of router.stack.filter(l => !l.route)) {
      let next = false; await layer.handle(req, res, () => { next = true; });
      if (!next) { allowed = false; break; }
    }
    if (allowed) await handler(router, 'post', '/')(req, res);
    assert.equal(res.code, id === 11 ? 201 : id === 12 ? 403 : 401);
  }
  assert.equal(writes.length, 1); assert.equal(writes[0][0], 1); assert.equal(writes[0][2], 'user:11');
  disabled = true; const denied = response(); let passed = false;
  await router.stack[2].handle({ orgId: 1 }, denied, () => { passed = true; });
  assert.equal(denied.code, 403); assert.equal(passed, false);
  for (const body of [null, { ...textPost(), platform: 'invalid' }, { ...textPost(), message: {} }, { ...textPost(), scheduled_for: '2026-11-04T12:00' }, { ...textPost(), media_type: 'reel', image_url: 'http://localhost/video' }]) {
    const res = response(); await handler(router, 'post', '/')({ orgId: 1, userId: 11, body }, res); assert.equal(res.code, 400);
  }
  assert.equal(writes.length, 1);
});

test('el descargador público bloquea direcciones privadas y no adjunta credenciales del servicio', async () => {
  let privateIp = false; const calls = [];
  const media = load('src/services/safe-media.js', {
    'node:dns': { promises: { lookup: async () => [{ address: privateIp ? '127.0.0.1' : '8.8.8.8', family: 4 }] } },
    axios: { get: async (url, options) => { calls.push(options); return { status: 200, data: Buffer.alloc(0), headers: { 'content-type': 'image/png' } }; } },
  });
  await media.downloadMedia('https://api.kapso.ai/image', { publicOnly: true, kapso_api_key: 'mock-key' });
  assert.equal(calls[0].headers['X-API-Key'], undefined); assert.equal(calls[0].maxRedirects, 0);
  privateIp = true; await assert.rejects(media.publicTarget('https://localhost/image'), /no público/);
  assert.equal(calls.length, 1);
});

test('cola real en PostgreSQL embebido: migración, estados, aislamiento, permisos, edición y duplicados', async t => {
  const engine = new PGlite();
  t.after(() => engine.close());
  const query = (sql, params) => engine.query(sql, params?.map(value => typeof value?.toISOString === 'function' ? value.toISOString() : value));
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await engine.exec(`CREATE TABLE organizations(id INTEGER PRIMARY KEY);
    INSERT INTO organizations VALUES(1),(2);
    CREATE TABLE users(id INTEGER PRIMARY KEY, organization_id INTEGER, role TEXT);
    INSERT INTO users VALUES(11,1,'admin'),(22,2,'admin');
    CREATE TABLE meta_connections(organization_id INTEGER, status TEXT, page_id TEXT, instagram_account_id TEXT, instagram_username TEXT, page_access_token TEXT);
    INSERT INTO meta_connections VALUES(1,'connected','page1','ig1','test1','mock'),(2,'connected','page2','ig2','test2','mock');`);
  const readSql = name => fs.readFileSync(path.join(__dirname, '../src/db', name), 'utf8');
  await engine.exec(readSql('social-stories.sql'));
  await engine.exec(`INSERT INTO social_scheduled_posts(organization_id,image_url,scheduled_for) VALUES(1,'https://cdn.example.com/old.png',NOW())`);
  await engine.exec(readSql('social-post-scheduling.sql'));
  await engine.exec(readSql('social-post-scheduling.sql'));
  const old = (await query('SELECT * FROM social_scheduled_posts')).rows[0];
  assert.equal(old.platform, 'instagram_story'); assert.equal(old.media_type, 'image');
  await query('DELETE FROM social_scheduled_posts');
  let disabled = false, failPublish = false, duringCheck;
  const sent = [];
  const png = Buffer.alloc(24); png.write('PNG', 1); png.writeUInt32BE(1080, 16); png.writeUInt32BE(1920, 20);
  const publisher = transport();
  const service = load('src/services/social-stories.js', {
    '../db/database': { getPool: () => pool },
    './social-publishing': { validateContent: publisher.validateContent, publishContent: async (conn, post) => {
      sent.push(post); if (failPublish) throw Object.assign(new Error('do not log token'), { request: {} }); return 'external-1';
    } },
    './safe-media': { publicTarget: async value => { if (value.includes('127.0.0.1')) throw new Error('private'); if (duringCheck) { const fn = duringCheck; duringCheck = null; await fn(); } }, downloadMedia: async () => ({ data: png, contentType: 'image/png' }) },
    './commercial': { assertModule: async (orgId, module) => { assert.equal(module, 'marketing'); if (disabled) throw new Error('disabled'); } },
  });
  const make = async (input = textPost(), org = 1) => service.createPost(org, input, `user:${org === 1 ? 11 : 22}`);
  const approve = async post => service.approvePost(post.organization_id, post.id, `user:${post.organization_id === 1 ? 11 : 22}`, post.revision);
  const due = post => query('UPDATE social_scheduled_posts SET scheduled_for=NOW() - INTERVAL \'1 minute\' WHERE id=$1', [post.id]);

  await t.test('todos los formatos conservan texto, fecha y estado; historias anteriores siguen válidas', async () => {
    for (const platform of ['facebook','instagram','instagram_story']) {
      for (const type of platform === 'instagram_story' ? ['image'] : ['image','video','reel']) {
        const post = await make({ ...textPost(), platform, media_type: type, image_url: url });
        assert.equal(post.status, 'review'); assert.equal(post.message, 'Texto aprobado');
        assert.equal((await approve(post)).post.status, 'approved');
        await service.cancelPost(1, post.id, 'user:11');
      }
    }
  });
  await t.test('ninguna empresa puede consultar, editar, aprobar o cancelar publicaciones ajenas', async () => {
    const post = await make();
    assert.equal(await service.getPost(2, post.id), null);
    assert.equal((await service.updatePost(2, post.id, { message: 'otro' }, 'user:22')).error, 'not_found');
    assert.equal((await service.approvePost(2, post.id, 'user:22')).error, 'not_found');
    assert.equal((await service.cancelPost(2, post.id, 'user:22')).error, 'not_found');
    assert.equal((await service.listPosts(2)).length, 0);
    assert.equal((await service.getEvents(2, post.id)).length, 0);
  });
  await t.test('edición invalida aprobación y rechaza revisiones antiguas', async () => {
    const post = await make(); await approve(post);
    const edited = await service.updatePost(1, post.id, { message: 'Nuevo texto' }, 'user:11');
    assert.equal(edited.post.status, 'review'); assert.equal(edited.post.approved_by, null);
    assert.equal((await approve(post)).error, 'conflict');
    assert.equal((await service.updatePost(1, post.id, { revision: 0, message: 'viejo' }, 'user:11')).error, 'conflict');
    await due(post); await service.runDuePosts(); assert.equal(sent.length, 0);
  });
  await t.test('fecha pasada y URL privada nunca llegan a aprobación', async () => {
    const past = await make({ ...textPost(), scheduled_for: '2020-01-01T00:00:00Z' });
    assert.equal(past.status, 'draft'); assert.equal((await approve(past)).error, 'not_reviewable');
    const blocked = await make({ ...textPost(), media_type: 'image', image_url: 'https://127.0.0.1/private' });
    assert.equal(blocked.status, 'draft');
  });
  await t.test('se publica una vez al vencer; antes no; ejecución repetida o concurrente no duplica', async () => {
    const post = await make(); await approve(post);
    await service.runDuePosts(); assert.equal(sent.length, 0);
    await due(post); await Promise.all([service.runDuePosts(), service.runDuePosts()]);
    assert.equal(sent.length, 1); assert.equal(sent[0].message, post.message);
    assert.equal((await service.getPost(1, post.id)).status, 'published');
    await service.runDuePosts(); assert.equal(sent.length, 1);
  });
  await t.test('cancelar, revocar permiso, deshabilitar Marketing o cambiar de cuenta impide envío', async () => {
    for (const action of ['cancel', 'role', 'module', 'account']) {
      const post = await make(); await approve(post);
      if (action === 'cancel') await service.cancelPost(1, post.id, 'user:11');
      if (action === 'role') await query("UPDATE users SET role='agent' WHERE id=11");
      if (action === 'module') disabled = true;
      if (action === 'account') await query("UPDATE meta_connections SET page_id='different' WHERE organization_id=1");
      await due(post); await service.runDuePosts(); assert.equal(sent.length, 1);
      assert.equal((await service.getPost(1, post.id)).status, action === 'cancel' ? 'cancelled' : 'failed');
      disabled = false; await query("UPDATE users SET role='admin' WHERE id=11");
      await query("UPDATE meta_connections SET page_id='page1' WHERE organization_id=1");
    }
  });
  await t.test('una cancelación concurrente con chequeos no se sobrescribe', async () => {
    const post = await make({ ...textPost(), media_type: 'image', image_url: url });
    duringCheck = () => service.cancelPost(1, post.id, 'user:11');
    assert.equal((await service.updatePost(1, post.id, { message: 'edición tardía' }, 'user:11')).error, 'conflict');
    assert.equal((await service.getPost(1, post.id)).status, 'cancelled');
  });
  await t.test('resultado incierto queda fallido sin reenvío ni secretos; publishing interrumpido tampoco reintenta', async () => {
    const post = await make(); await approve(post); await due(post); failPublish = true;
    await service.runDuePosts(); await service.runDuePosts(); assert.equal(sent.length, 2);
    const failed = await service.getPost(1, post.id); assert.equal(failed.status, 'failed'); assert.doesNotMatch(failed.last_error, /token/);
    await query("UPDATE social_scheduled_posts SET status='publishing', updated_at=NOW()-INTERVAL '30 minutes' WHERE id=$1", [post.id]);
    await service.runDuePosts(); assert.equal(sent.length, 2); assert.equal((await service.getPost(1, post.id)).status, 'failed');
  });
});
