const test = require('node:test');
const assert = require('node:assert/strict');
const { load, response, noop } = require('./helpers.cjs');

function fixture(statuses = ['IN_PROGRESS', 'FINISHED']) {
  const routes = new Map(), calls = [], waits = [];
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (path, ...handlers) => routes.set(method + ' ' + path, handlers.at(-1));
  }
  const deps = {
    express: { Router: () => router },
    jsonwebtoken: {},
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../middleware/commercial-access': { requireSolution: () => noop },
    '../db/database': { getPool: () => ({ async query(sql, params) {
      assert.match(sql, /WHERE organization_id = \$1/);
      assert.deepEqual(Array.from(params), [7]);
      return { rows: [{ status: 'connected', page_id: 'page-7', instagram_account_id: 'ig-7', page_access_token: 'encrypted-test-token' }] };
    } }) },
    '../services/meta-platform': {
      decryptToken(value) { assert.equal(value, 'encrypted-test-token'); return 'test-token'; },
      graphError: error => error.message,
      async graphGet(path, token, params) {
        assert.equal(token, 'test-token');
        assert.equal(path, 'container-7');
        assert.equal(params.fields, 'status_code,status');
        const status = statuses[Math.min(calls.filter(call => call.kind === 'status').length, statuses.length - 1)];
        calls.push({ kind: 'status', status });
        return { status_code: status };
      },
      async graphPost(path, token, data) {
        assert.equal(token, 'test-token');
        calls.push({ kind: 'post', path, data });
        if (path === 'ig-7/media') return { id: 'container-7' };
        assert.equal(path, 'ig-7/media_publish');
        assert.equal(data.creation_id, 'container-7');
        return { id: 'published-7' };
      },
    },
  };
  const extra = { setTimeout(resolve, delay) { waits.push(delay); resolve(); } };
  deps['../services/social-publishing'] = load('src/services/social-publishing.js', {
    './meta-platform': deps['../services/meta-platform'],
    './safe-media': { publicTarget: async () => ({}) },
  }, extra);
  const loaded = load('src/routes/meta.js', deps, extra);
  return { publish: routes.get('post /publish'), calls, waits, loaded };
}

test('Instagram espera que la foto termine y publica exactamente su contenedor una sola vez', async () => {
  const f = fixture();
  const res = response();
  await f.publish({ orgId: 7, body: { platform: 'instagram', mediaUrl: 'https://example.com/photo.jpg', message: 'Texto aprobado' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.id, 'published-7');
  assert.deepEqual(f.calls.map(c => c.kind === 'post' ? c.path : c.status), ['ig-7/media', 'IN_PROGRESS', 'FINISHED', 'ig-7/media_publish']);
  assert.equal(f.calls[0].data.image_url, 'https://example.com/photo.jpg');
  assert.equal(f.calls[0].data.caption, 'Texto aprobado');
  assert.deepEqual(f.waits, [2000]);
});

test('Instagram mantiene la espera de videos y reels', async () => {
  for (const mediaType of ['video', 'reel']) {
    const f = fixture(['FINISHED']);
    const res = response();
    await f.publish({ orgId: 7, body: { platform: 'instagram', mediaType, mediaUrl: 'https://example.com/video.mp4' } }, res);
    assert.equal(res.code, 200);
    assert.equal(f.calls[0].data.video_url, 'https://example.com/video.mp4');
    assert.equal(f.calls[0].data.media_type, 'REELS');
    assert.deepEqual(f.calls.map(c => c.kind === 'post' ? c.path : c.status), ['ig-7/media', 'FINISHED', 'ig-7/media_publish']);
  }
});

test('un medio con error o vencido nunca llega a media_publish', async () => {
  for (const status of ['ERROR', 'EXPIRED']) {
    const f = fixture([status]);
    const res = response();
    await f.publish({ orgId: 7, body: { platform: 'instagram', mediaUrl: 'https://example.com/photo.jpg' } }, res);
    assert.equal(res.code, 502);
    assert.equal(f.calls.filter(c => c.path === 'ig-7/media_publish').length, 0);
    assert.equal(f.waits.length, 0);
  }
});

test('el procesamiento pendiente tiene un límite y no publica ni crea contenedores adicionales', async () => {
  const f = fixture(['IN_PROGRESS']);
  const res = response();
  await f.publish({ orgId: 7, body: { platform: 'instagram', mediaUrl: 'https://example.com/photo.jpg' } }, res);
  assert.equal(res.code, 502);
  assert.equal(f.calls.filter(c => c.path === 'ig-7/media').length, 1);
  assert.equal(f.calls.filter(c => c.path === 'ig-7/media_publish').length, 0);
  assert.equal(f.calls.filter(c => c.kind === 'status').length, 60);
});
