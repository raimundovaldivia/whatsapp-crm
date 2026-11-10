const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { loadInstagramQuotes } = require('../src/services/instagram-quotes');
const { formatQuotedReply } = require('../src/services/social-events');
const meta = require('../src/services/meta-platform');
const promotions = require('../src/services/promotion-context');

test('recupera la oferta enviada desde Instagram y la conserva para el turno siguiente del mismo chat', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE meta_threads(id int, organization_id int, crm_conversation_id int, channel text, external_user_id text);
    CREATE TABLE meta_connections(organization_id int, status text, instagram_account_id text, page_access_token text);
    CREATE TABLE meta_messages(thread_id int, external_message_id text UNIQUE, direction text, raw_payload jsonb,
      content text, created_at timestamptz, sent_by text, instagram_reply_context jsonb);
    INSERT INTO meta_threads VALUES(9,7,91,'instagram','client'),(10,8,92,'instagram','other');
    INSERT INTO meta_connections VALUES(7,'connected','shop','mock');
  `);
  const content = 'Te dejo ubicación?';
  let remote = { id: 'promo', from: { id: 'shop' }, to: { data: [{ id: 'client' }] },
    created_time: '2026-11-10T15:38:00Z', message: 'Hoy estamos despachando. Bandejas XL 30 UNIDADES $7.000' };
  async function reply(id, parent) {
    await db.query('INSERT INTO meta_messages(thread_id,external_message_id,direction,raw_payload,content) VALUES(9,$1,\'inbound\',$2,$3)',
      [id, JSON.stringify({recipient: {id: 'shop'}, message: { reply_to: { mid: parent } }}), content]);
    return { direction: 'inbound', whatsapp_message_id: 'social:instagram:' + id, content };
  }
  const incoming = await reply('first', 'promo');
  t.mock.method(meta, 'decryptToken', () => 'test');
  const graph = t.mock.method(meta, 'graphGet', async (id, token, params) => {
    assert.equal(id, remote.id);
    assert.equal(token, 'test');
    assert.match(params.fields, /from,to,message/);
    return remote;
  });
  const [linked] = await loadInstagramQuotes(db, 7, 91, [incoming]);
  assert.equal(linked.content, content);
  assert.match(formatQuotedReply(linked), /de la tienda citado[\s\S]*7\.000[\s\S]*Te dejo ubicación/);
  assert.equal(linked.instagramQuote.page_access_token, undefined);
  const next = { direction: 'inbound', content: 'Dos bandejas' };
  const nextTurn = await loadInstagramQuotes(db, 7, 91, [incoming, next]);
  assert.match(formatQuotedReply(nextTurn[0]), /7\.000/);
  assert.equal(formatQuotedReply(nextTurn[1]), next.content);
  assert.equal(graph.mock.callCount(), 1);
  assert.deepEqual(await loadInstagramQuotes(db, 8, 91, [incoming]), [incoming]);
  assert.deepEqual(await loadInstagramQuotes(db, 7, 92, [incoming]), [incoming]);

  const mismatch = await reply('second', 'other-parent');
  await db.query("INSERT INTO meta_messages(thread_id,external_message_id,direction,content) VALUES(10,'other-parent','outbound','otro chat')");
  remote = { ...remote, id: 'other-parent', to: { data: [{ id: 'other' }] } };
  assert.deepEqual(await loadInstagramQuotes(db, 7, 91, [mismatch]), [mismatch]);

  const deleted = await reply('third', 'deleted');
  graph.mock.mockImplementation(async () => { throw new Error('Message unavailable'); });
  assert.deepEqual(await loadInstagramQuotes(db, 7, 91, [deleted]), [deleted]);
});

test('la cantidad por bandeja, otros SKU, citas vencidas y precios escritos por el cliente', () => {
  const products = ['Huevos XL mixtos · Bandeja de 30','Huevos XL cafés · Bandeja de 20','Huevos L cafés · Bandeja de 30']
    .map((title, id) => ({ id, title, price: 12000, stock: 3 }));
  const now = new Date('2026-11-10T20:00:00Z');
  const quote = { direction: 'outbound', created_at: now, content: 'Hoy estamos despachando. Bandejas XL 30 UNIDADES $7.000' };
  const promo = (q, when = now) => promotions.fromHistory([{ direction: 'inbound', instagramQuote: q }], products, when);
  assert.deepEqual(promo(quote).specialPrices, { 'huevos xl mixtos bandeja de 30': 7000 });
  assert.equal(promo(quote, new Date('2026-11-11T12:00:00Z')).active, false);
  assert.equal(promo({ ...quote, direction: 'inbound' }), null);
  assert.equal(promo({ ...quote, content: quote.content + ' desde 10 bandejas' }), null);
});
