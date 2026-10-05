const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response } = require('./helpers.cjs');

test('customer identity remains consistent across providers, historical phones and profile changes', async () => {
  const engine = new PGlite();
  class Pool {
    async query(sql, params) {
      const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    }
  }
  const db = load('src/db/database.js', { pg: { Pool } });
  try {
    await engine.exec(`
      CREATE TABLE contacts (id SERIAL PRIMARY KEY, organization_id INT, phone TEXT, name TEXT,
        client_type TEXT, contact_type TEXT, source TEXT, last_seen_at TIMESTAMP, updated_at TIMESTAMP,
        email TEXT, address TEXT, address1 TEXT, city TEXT, UNIQUE(organization_id, phone));
      CREATE TABLE conversations (id SERIAL PRIMARY KEY, organization_id INT, phone_number TEXT,
        contact_name TEXT, whatsapp_channel_id INT, updated_at TIMESTAMP, last_message_at TIMESTAMP,
        unread_count INT DEFAULT 0);
      CREATE TABLE messages (id SERIAL PRIMARY KEY, conversation_id INT);
      CREATE TABLE whatsapp_channels (id INT, name TEXT, phone_number TEXT, provider TEXT);
      CREATE TABLE whatsapp_configs (organization_id INT, provider TEXT, display_phone_number TEXT, twilio_phone_number TEXT);
      INSERT INTO whatsapp_channels VALUES (1,'Kapso','111','kapso'), (2,'Evolution','222','evolution');
      INSERT INTO contacts (organization_id, phone, name) VALUES
        (1,'56994073111','Roxana Del Rosario Flores'), (2,'56994073111','Otra persona'),
        (1,'994073111','Nombre antiguo');
      INSERT INTO conversations (organization_id, phone_number, contact_name, whatsapp_channel_id) VALUES
        (1,'56994073111','roxi',2), (1,'+56994073111','Roxana',1),
        (1,'994073111','alias',NULL), (2,'56994073111','otro alias',2);
    `);
    let rows = await db.getAllConversations(1);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r.contact_name === 'Roxana Del Rosario Flores'));
    assert.equal((await db.getConversationById(1, 1)).contact_name, 'Roxana Del Rosario Flores');
    assert.equal((await db.getConversationById(4, 2)).contact_name, 'Otra persona');
    assert.equal(await db.getConversationById(4, 1), null);
    await db.touchLead(1, '+56994073111', 'roxi');
    const evolution = await db.upsertConversation(1, '56994073111', 'roxi', 2);
    const kapso = await db.upsertConversation(1, '56994073111', 'Roxi WhatsApp', 1);
    assert.notEqual(evolution.id, kapso.id);
    assert.equal(evolution.contact_name, 'Roxana Del Rosario Flores');
    assert.equal(kapso.contact_name, evolution.contact_name);
    assert.equal((await db.getContact(1, '56994073111')).name, evolution.contact_name);

    const router = load('src/routes/contacts.js', { '../db/database': db, '../middleware/auth': { requireAuth: (_req,_res,next) => next(), requireRole: () => (_req,_res,next) => next() } });
    const res = response();
    await handler(router, 'patch', '/+56994073111')({orgId:1, params:{phone:'+56994073111'}, body:{name:'Roxana Flores'}},res);
    assert.equal(res.code, 200);
    await db.touchLead(1, '994073111', 'roxi');
    await db.upsertConversation(1, '56994073111', 'roxi', 2);
    rows = await db.getAllConversations(1);
    assert.ok(rows.every(r => r.contact_name === 'Roxana Flores'));
    assert.equal((await db.getConversationById(4, 2)).contact_name, 'Otra persona');

    await engine.exec("INSERT INTO contacts (organization_id,phone,name) VALUES (1,'933333333','Nombre Guardado')");
    await db.touchLead(1, '56933333333', 'apodo');
    assert.equal((await db.getContact(1, '56933333333')).name, 'Nombre Guardado');

    const other = await db.upsertConversation(1, '56911111111', 'Roxana Flores', 2);
    assert.notEqual(other.id, evolution.id); // Names never establish identity.
    await engine.exec("INSERT INTO contacts (organization_id,phone,name) VALUES (1,'56922222222','Cliente')");
    await db.touchLead(1, '922222222', 'ana');
    assert.equal((await db.getContact(1, '56922222222')).name, 'Ana');
  } finally { await engine.close(); }
});

