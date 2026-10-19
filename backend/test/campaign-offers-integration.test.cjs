const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const store = require('../src/services/campaign-offers-store');
const rules = require('../src/services/campaign-offers');

const T0 = new Date('2026-10-19T13:00:00.000Z');
const LATER = new Date('2026-10-19T16:00:00.000Z');
const EXPIRES = '2026-10-19T23:59:00.000Z';

async function setup() {
  const engine = new PGlite();
  await engine.exec(`
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, organization_id INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, organization_id INTEGER);
    CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO products VALUES (51,'Huevos Jumbo cafés · Bandeja de 20');
    INSERT INTO organizations VALUES (1,'A');
    INSERT INTO conversations VALUES (10,1),(11,1);
    INSERT INTO messages VALUES (100,10),(101,10),(102,10);
    INSERT INTO orders VALUES (500,1),(501,1);
  `);
  await engine.exec(fs.readFileSync(path.join(__dirname, '../src/db/campaign-offers.sql'), 'utf8'));
  const pool = { query: (sql, params) => engine.query(sql, params) };
  return { engine, pool };
}

const fields = { product_id: '51', offer_price: 8000, expires_at: EXPIRES, scope: 'all_units', recipients: ['56967692870'] };

test('la migración es idempotente y agrega las columnas nuevas', async () => {
  const { engine } = await setup();
  await engine.exec(fs.readFileSync(path.join(__dirname, '../src/db/campaign-offers.sql'), 'utf8'));
  const cols = (await engine.query(`SELECT column_name FROM information_schema.columns WHERE table_name='campaign_offers'`)).rows.map(r => r.column_name);
  for (const c of ['product_id', 'offer_price', 'scope', 'superseded_at', 'expired_at', 'status']) assert.ok(cols.includes(c), c);
});

test('la última oferta enviada reemplaza a las pendientes anteriores', async () => {
  const { pool } = await setup();
  const a = await store.createDraft(pool, 1, 10, fields);
  await store.markSent(pool, 1, a.id, 100, T0);
  const b = await store.createDraft(pool, 1, 10, { ...fields, product_id: '50' });
  await store.markSent(pool, 1, b.id, 101, new Date('2026-10-19T14:00:00.000Z'));
  const latest = await store.latestForConversation(pool, 1, 10);
  assert.equal(latest.id, b.id);
  const { rows } = await pool.query(`SELECT status FROM campaign_offers WHERE id = $1`, [a.id]);
  assert.equal(rows[0].status, 'superseded');
});

test('canje y cancelación: vuelve a sent si la vigencia corresponde', async () => {
  const { pool } = await setup();
  const o = await store.createDraft(pool, 1, 10, fields);
  await store.markSent(pool, 1, o.id, 100, T0);
  const redeemed = await store.redeem(pool, 1, o.id, 500, T0);
  assert.equal(redeemed.status, 'redeemed');
  const released = await store.releaseOnCancel(pool, 1, 500, T0);
  assert.equal(released.status, 'sent');
  assert.equal(released.redeemed_order_id, null);
});

test('cancelar después de la vigencia deja la oferta expirada y no permite otro pedido', async () => {
  const { pool } = await setup();
  const o = await store.createDraft(pool, 1, 10, fields);
  await store.markSent(pool, 1, o.id, 100, T0);
  await store.redeem(pool, 1, o.id, 500, T0);
  const released = await store.releaseOnCancel(pool, 1, 500, new Date('2026-10-20T01:00:00.000Z'));
  assert.equal(released.status, 'expired');
  await assert.rejects(store.redeem(pool, 1, o.id, 501, new Date('2026-10-20T01:00:00.000Z')), /no está disponible/);
});

test('un despacho con problemas conserva la oferta en el pedido aunque haya vencido', async () => {
  const { pool } = await setup();
  const o = await store.createDraft(pool, 1, 10, fields);
  await store.markSent(pool, 1, o.id, 100, T0);
  await store.redeem(pool, 1, o.id, 500, T0);
  const expired = await store.expireDue(pool, 1, new Date('2026-10-20T01:00:00.000Z'));
  assert.equal(expired.length, 0, 'una oferta canjeada no se marca expirada');
  const { rows } = await pool.query(`SELECT status, redeemed_order_id FROM campaign_offers WHERE id = $1`, [o.id]);
  assert.equal(rows[0].status, 'redeemed');
  assert.equal(rows[0].redeemed_order_id, 500);
});

test('expireDue marca como expirada una oferta enviada y vencida', async () => {
  const { pool } = await setup();
  const o = await store.createDraft(pool, 1, 11, fields);
  await store.markSent(pool, 1, o.id, 102, T0);
  const expired = await store.expireDue(pool, 1, new Date('2026-10-20T01:00:00.000Z'));
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, 'expired');
  assert.ok(expired[0].expired_at);
});

test('toPromotionContext entrega el precio por el mismo camino que las promociones del bot', async () => {
  const { pool } = await setup();
  const o = await store.createDraft(pool, 1, 10, fields);
  const sent = await store.markSent(pool, 1, o.id, 100, T0);
  const promo = rules.toPromotionContext({ ...sent, product_title: 'Huevos Jumbo cafés · Bandeja de 20' }, T0);
  assert.equal(promo.active, true);
  assert.equal(promo.specialPrices['51'].unitPrice, 8000);
  assert.equal(promo.offers[0].price, 8000);
});
