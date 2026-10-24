const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

const permissions = ['pages_read_engagement', 'pages_manage_metadata', 'pages_read_user_content',
  'pages_manage_engagement', 'instagram_basic', 'instagram_manage_comments'];

function fixture({ granted = permissions, permissionError = false, subscriptionError = false, connection = true,
  pages = [{ id: 'page-7', access_token: 'test-page-token', instagram_business_account: { id: 'ig-7' } }],
  adAccounts = [], adAccountId = null } = {}) {
  const queries = [], calls = [];
  const current = connection && { organization_id: 7, status: 'connected', page_id: 'page-7',
    instagram_account_id: 'ig-7', ad_account_id: adAccountId, user_access_token: 'encrypted-test-token', scopes: permissions };
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (/SELECT .*FROM meta_connections/s.test(sql)) {
      assert.deepEqual(Array.from(params), [7]);
      return { rows: current ? [current] : [] };
    }
    return { rows: [{ auto_reply_messages: false, auto_reply_comments: true }] };
  } };
  const router = load('src/routes/meta.js', {
    jsonwebtoken: { verify: () => ({ orgId: 7 }), sign: payload => { assert.equal(payload.orgId, 7); return 'test-state'; } },
    axios: { get: async () => ({ data: { access_token: 'test-user-token' } }) },
    '../db/database': { getPool: () => pool },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop, JWT_SECRET: 'test-only' },
    '../middleware/commercial-access': { requireSolution: () => noop },
    '../services/meta-platform': {
      requiredEnv: () => 'test-only-value',
      decryptToken: token => { assert.equal(token, 'encrypted-test-token'); return 'test-user-token'; },
      encryptToken: () => 'encrypted-test-page-token', graphError: error => error.message,
      async graphGet(path, token) {
        assert.equal(token, 'test-user-token'); calls.push(path);
        if (path === 'me/permissions') {
          if (permissionError) throw new Error('Meta no disponible');
          return { data: permissions.map(permission => ({ permission, status: granted.includes(permission) ? 'granted' : 'declined' })) };
        }
        if (path === 'me') return { id: 'user-7', name: 'Cuenta de prueba' };
        if (path === 'me/accounts') return { data: pages };
        if (path === 'me/adaccounts') return { data: adAccounts };
        return { data: [] };
      },
      async graphPost(path, token) {
        assert.equal(token, 'test-page-token'); calls.push(path);
        if (subscriptionError && path.startsWith('ig-7/')) throw new Error('Permiso de Instagram pendiente');
        return { success: true };
      },
    },
  }, { URLSearchParams, process: { env: { CRM_PUBLIC_URL: 'https://api.example', FRONTEND_URL: 'https://crm.example' } } });
  return { router, queries, calls };
}

test('la autorización solicita lectura de contenido de usuarios y permisos de comentarios de ambas redes', () => {
  const { router } = fixture();
  for (const permission of permissions) assert.ok(router.SCOPES.includes(permission), permission);
});

test('OAuth social omite permisos de WhatsApp que pueden bloquear una app de Facebook e Instagram', async () => {
  const { router } = fixture();
  for (const query of [{}, { purpose: 'social' }]) {
    const res = response();
    await handler(router, 'get', '/auth-url')({ orgId: 7, query }, res);
    assert.equal(res.code, 200);
    const scopes = new URL(res.body.url).searchParams.get('scope').split(',');
    for (const permission of permissions) assert.ok(scopes.includes(permission));
    assert.equal(scopes.some(p => p.startsWith('whatsapp_')), false);
  }
});

test('OAuth de WhatsApp conserva sus permisos solo cuando se solicita expresamente', async () => {
  const { router } = fixture();
  const res = response();
  await handler(router, 'get', '/auth-url')({ orgId: 7, query: { purpose: 'whatsapp' } }, res);
  assert.equal(res.code, 200);
  const scopes = new URL(res.body.url).searchParams.get('scope').split(',');
  for (const permission of ['whatsapp_business_management', 'whatsapp_business_messaging', 'whatsapp_business_manage_events']) {
    assert.ok(scopes.includes(permission));
  }
});

test('OAuth rechaza propósitos desconocidos o múltiples sin generar autorización', async () => {
  const { router } = fixture();
  for (const purpose of ['otro', ['social', 'whatsapp'], { value: 'social' }, '']) {
    const res = response();
    await handler(router, 'get', '/auth-url')({ orgId: 7, query: { purpose } }, res);
    assert.equal(res.code, 400);
    assert.equal(res.body.url, undefined);
  }
});

test('reconectar conserva los activos de la organización aunque otra marca aparezca primero', async () => {
  const { router, queries, calls } = fixture({
    pages: [{ id: 'other-page', instagram_business_account: { id: 'other-ig' } },
      { id: 'page-7', access_token: 'test-page-token', instagram_business_account: { id: 'ig-7' } }],
    adAccounts: [{ id: 'other-ad' }, { id: 'ad-7' }], adAccountId: 'ad-7',
  });
  const res = response();
  await handler(router, 'get', '/callback')({ query: { state: 'test-state', code: 'test-code' } }, res);
  assert.equal(res.location, 'https://crm.example/?meta_success=1');
  const insert = queries.find(q => /INSERT INTO meta_connections/.test(q.sql));
  assert.equal(insert.params[4], 'page-7');
  assert.equal(insert.params[7], 'ig-7');
  assert.equal(insert.params[9], 'ad-7');
  assert.ok(calls.includes('page-7/subscribed_apps'));
  assert.equal(calls.includes('other-page/subscribed_apps'), false);
});

test('reconectar sin el activo anterior no suscribe otra marca ni reemplaza su cuenta publicitaria', async () => {
  const { router, queries, calls } = fixture({
    pages: [{ id: 'other-page', instagram_business_account: { id: 'other-ig' } }],
    adAccounts: [{ id: 'other-ad' }], adAccountId: 'ad-7',
  });
  const res = response();
  await handler(router, 'get', '/callback')({ query: { state: 'test-state', code: 'test-code' } }, res);
  assert.equal(res.location, 'https://crm.example/?meta_success=1');
  const insert = queries.find(q => /INSERT INTO meta_connections/.test(q.sql));
  assert.equal(insert.params[4], null);
  assert.equal(insert.params[7], null);
  assert.equal(insert.params[9], null);
  assert.equal(calls.some(path => path.endsWith('/subscribed_apps')), false);
  assert.match(queries.find(q => /SET last_error/.test(q.sql)).params[0], /página seleccionada.*no está disponible/);
});

test('una conexión nueva mantiene la selección inicial compatible', async () => {
  const { router, queries } = fixture({ connection: false });
  const res = response();
  await handler(router, 'get', '/callback')({ query: { state: 'test-state', code: 'test-code' } }, res);
  assert.equal(res.location, 'https://crm.example/?meta_success=1');
  assert.equal(queries.find(q => /INSERT INTO meta_connections/.test(q.sql)).params[4], 'page-7');
});

test('no activa comentarios con permisos declarados pero denegados por Meta', async () => {
  const { router, queries } = fixture({ granted: permissions.filter(p => p !== 'instagram_manage_comments') });
  const res = response();
  await handler(router, 'patch', '/automation')({ orgId: 7, body: { autoReplyMessages: false, autoReplyComments: true } }, res);
  assert.equal(res.code, 409);
  assert.deepEqual(Array.from(res.body.missingPermissions), ['instagram_manage_comments']);
  assert.equal(queries.some(q => /UPDATE/.test(q.sql)), false);
});

test('activa comentarios con permisos reales conservando mensajes privados apagados y organización', async () => {
  const { router, queries } = fixture();
  const res = response();
  await handler(router, 'patch', '/automation')({ orgId: 7, body: { autoReplyMessages: false, autoReplyComments: true } }, res);
  assert.equal(res.code, 200);
  const update = queries.find(q => /SET auto_reply_messages/.test(q.sql));
  assert.match(update.sql, /WHERE organization_id=\$3/);
  assert.deepEqual(Array.from(update.params), [false, true, 7]);
});

test('un fallo de Meta no guarda una activación no comprobada', async () => {
  const { router, queries } = fixture({ permissionError: true });
  const res = response();
  await handler(router, 'patch', '/automation')({ orgId: 7, body: { autoReplyMessages: false, autoReplyComments: true } }, res);
  assert.equal(res.code, 502);
  assert.equal(queries.some(q => /UPDATE/.test(q.sql)), false);
});

test('permite apagar comentarios aunque Meta no esté disponible', async () => {
  const { router, queries, calls } = fixture({ permissionError: true });
  const res = response();
  await handler(router, 'patch', '/automation')({ orgId: 7, body: { autoReplyMessages: false, autoReplyComments: false } }, res);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 0);
  assert.deepEqual(Array.from(queries[0].params), [false, false, 7]);
});

test('rechaza activar sin conexión y no modifica otra organización', async () => {
  const { router, queries } = fixture({ connection: false });
  const res = response();
  await handler(router, 'patch', '/automation')({ orgId: 7, body: { autoReplyMessages: false, autoReplyComments: true } }, res);
  assert.equal(res.code, 409);
  assert.equal(queries.some(q => /UPDATE/.test(q.sql)), false);
});

test('conserva un error visible si falla la suscripción al guardar activos', async () => {
  const { router, queries, calls } = fixture({ subscriptionError: true });
  const res = response();
  await handler(router, 'patch', '/assets')({ orgId: 7, body: { pageId: 'page-7' } }, res);
  assert.equal(res.code, 200);
  assert.ok(calls.includes('page-7/subscribed_apps'));
  assert.ok(calls.includes('ig-7/subscribed_apps'));
  const warning = queries.find(q => /SET last_error/.test(q.sql));
  assert.match(warning.params[0], /Instagram.*Permiso/);
  assert.equal(warning.params[2], 7);
});

test('guardar activos no borra el aviso de permisos pendientes aunque se suscriba correctamente', async () => {
  const { router, queries } = fixture({ granted: permissions.filter(p => p !== 'pages_read_user_content') });
  const res = response();
  await handler(router, 'patch', '/assets')({ orgId: 7, body: { pageId: 'page-7' } }, res);
  assert.equal(res.code, 200);
  const warning = queries.find(q => /SET last_error/.test(q.sql));
  assert.match(warning.params[0], /pages_read_user_content/);
  assert.equal(warning.params[1].includes('pages_read_user_content'), false);
  assert.equal(warning.params[2], 7);
});

test('OAuth guarda permisos realmente concedidos y advierte de comentarios pendientes sin perder la conexión', async () => {
  const { router, queries } = fixture({ granted: permissions.filter(p => p !== 'pages_manage_engagement') });
  const res = response();
  await handler(router, 'get', '/callback')({ query: { state: 'test-state', code: 'test-code' } }, res);
  assert.equal(res.location, 'https://crm.example/?meta_success=1');
  const insert = queries.find(q => /INSERT INTO meta_connections/.test(q.sql));
  assert.ok(insert);
  assert.equal(insert.params[0], 7);
  assert.equal(insert.params[11].includes('pages_manage_engagement'), false);
  assert.equal(insert.params[11].includes('instagram_manage_comments'), true);
  const warning = queries.find(q => /SET last_error/.test(q.sql));
  assert.match(warning.params[0], /pages_manage_engagement/);
  assert.equal(warning.params[1], 7);
});
