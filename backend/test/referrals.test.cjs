const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');

const normalizePhone = value => {
  let phone = String(value || '').replace(/\D/g, '');
  if (/^9\d{8}$/.test(phone)) phone = `56${phone}`;
  return phone;
};
const normalizeName = value => String(value || '').trim() || null;

function referralService(query) {
  const client = { query: (sql, params) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) ? Promise.resolve({rows:[]}) : query(sql,params), release() {} };
  return load('src/services/referrals.js', {
    '../db/database': { getPool: () => ({ query, connect:async()=>client }), normalizePhone, normalizeName },
    './referral-engine': { purchases:async()=>[] },
  });
}

test('extrae solamente códigos de referidos completos', () => {
  const service = referralService(async () => ({ rows: [] }));
  assert.equal(service.extractReferralCode('Hola, vengo con ref-a1b2c3d4.'), 'REF-A1B2C3D4');
  assert.equal(service.extractReferralCode('REF-123'), null);
  assert.equal(service.extractReferralCode('XREF-A1B2C3D4'), null);
});

test('captura WhatsApp con organización, conversación y teléfono normalizado', async () => {
  const calls = [];
  const service = referralService(async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM conversations/.test(sql)) return { rows: [{ phone_number: '912345678', contact_name: 'Ana', referral_code_id: 7, referrer_phone: '56987654321', referred_contact_id: 9 }] };
    if (/INSERT INTO referrals/.test(sql)) return { rows: [{ id: 11, organization_id: 3, status: 'pending' }] };
    return { rows: [], rowCount: 1 };
  });
  const captured = await service.captureInboundReferral(3, 21, 'Hola, vengo referido con REF-A1B2C3D4');
  assert.equal(captured.id, 11);
  assert.deepEqual(Array.from(calls[0].params), [3, 21, 'REF-A1B2C3D4']);
  assert.equal(calls[1].params[0], 3);
  assert.equal(calls[1].params[3], '56912345678');
  assert.equal(calls[2].params[0], 3);
});

test('rechaza autorreferencia detectada por WhatsApp sin escribir', async () => {
  let writes = 0;
  const service = referralService(async sql => {
    if (/FROM conversations/.test(sql)) return { rows: [{ phone_number: '912345678', referral_code_id: 7, referrer_phone: '56912345678' }] };
    writes += 1;
    return { rows: [] };
  });
  assert.equal(await service.captureInboundReferral(3, 21, 'REF-A1B2C3D4'), null);
  assert.equal(writes, 0);
});

test('el listado de referidos aplica organización a todas sus lecturas', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT slug/.test(sql)) return { rows: [{ slug: 'tienda' }] };
    if (/FROM referral_program_settings/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0, pending: 0, qualified: 0, rewarded: 0, rejected: 0 }] };
    return { rows: [] };
  } };
  const router = load('src/routes/referrals.js', {
    '../db/database': { getPool: () => pool, normalizeName },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/referrals': { normalizedReferralPhone: normalizePhone },
  });
  const res = response();
  await handler(router, 'get', '/')({ orgId: 42, query: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.params[0] === 42));
});

test('cambios de estado inválidos se rechazan antes de consultar la base', async () => {
  let touched = false;
  const router = load('src/routes/referrals.js', {
    '../db/database': { getPool: () => ({ connect: async () => { touched = true; } }), normalizeName },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../services/referrals': { normalizedReferralPhone: normalizePhone },
  });
  const res = response();
  await handler(router, 'patch', '/12/status')({ orgId: 1, params: { id: '12' }, body: { status: 'paid' } }, res);
  assert.equal(res.code, 400);
  assert.equal(touched, false);
});

test('el enlace público resuelve por organización y código sin exponer otra empresa', async () => {
  const calls = [];
  const router = load('src/routes/referral-public.js', {
    '../db/database': {
      normalizePhone,
      getPool: () => ({ query: async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT o.id/.test(sql)) return { rows: [{ organization_id: 5, referral_code_id: 8, display_phone_number: '+56 9 1111 2222' }] };
        return { rows: [], rowCount: 1 };
      } }),
    },
  });
  const res = response();
  res.redirect = (status, url) => { res.code = status; res.location = url; return res; };
  await handler(router, 'get', '/mi-tienda/REF-A1B2C3D4')({ params: { slug: 'mi-tienda', code: 'ref-a1b2c3d4' } }, res);
  assert.equal(res.code, 302);
  assert.match(res.location, /^https:\/\/wa\.me\/56911112222\?text=/);
  assert.deepEqual(Array.from(calls[0].params), ['mi-tienda', 'REF-A1B2C3D4']);
  assert.deepEqual(Array.from(calls[1].params), [5, 8]);
});

test('el esquema impide relaciones cruzadas entre organizaciones', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(`
      CREATE TABLE organizations (id SERIAL PRIMARY KEY, name TEXT, slug TEXT UNIQUE);
      CREATE TABLE users (id SERIAL PRIMARY KEY, organization_id INTEGER REFERENCES organizations(id));
      CREATE TABLE contacts (id SERIAL PRIMARY KEY, organization_id INTEGER NOT NULL REFERENCES organizations(id), phone TEXT NOT NULL, UNIQUE(organization_id, phone));
      INSERT INTO organizations(name, slug) VALUES ('Uno','uno'),('Dos','dos');
      INSERT INTO users(organization_id) VALUES (1),(2);
      INSERT INTO contacts(organization_id, phone) VALUES (1,'56911111111'),(2,'56922222222'),(1,'56933333333');
    `);
    const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'referrals.sql'), 'utf8');
    await engine.exec(sql);
    await engine.query(
      `INSERT INTO referral_codes(organization_id, referrer_contact_id, code, created_by)
       VALUES ($1,$2,$3,$4)`, [1, 1, 'REF-A1B2C3D4', 1]
    );
    await assert.rejects(() => engine.query(
      `INSERT INTO referral_codes(organization_id, referrer_contact_id, code, created_by)
       VALUES ($1,$2,$3,$4)`, [1, 2, 'REF-B1B2C3D4', 1]
    ));
    await assert.rejects(() => engine.query(
      `INSERT INTO referrals(organization_id, referral_code_id, referred_contact_id, referred_phone)
       VALUES ($1,$2,$3,$4)`, [1, 1, 2, '56933333333']
    ));
    await engine.query(
      `INSERT INTO referrals(organization_id, referral_code_id, referred_contact_id, referred_phone)
       VALUES ($1,$2,$3,$4)`, [1, 1, 3, '56933333333']
    );
    await engine.query('DELETE FROM contacts WHERE organization_id = $1 AND id = $2', [1, 3]);
    const { rows } = await engine.query('SELECT organization_id, referred_contact_id FROM referrals WHERE organization_id = $1', [1]);
    assert.equal(rows[0].organization_id, 1);
    assert.equal(rows[0].referred_contact_id, null);
  } finally {
    await engine.close();
  }
});
