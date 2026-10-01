const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('Santander learns a manually confirmed payer and auto-matches only one exact future order', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const r = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...r, rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }

  try {
    const setup = load('src/db/setup.js', { pg: { Pool } });
    await setup.setupDatabase();
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
      INSERT INTO conversations(id,organization_id,phone_number,contact_name) VALUES(1,1,'+56911112222','María Cliente');
      INSERT INTO contacts(id,organization_id,phone,name) VALUES(1,1,'+56911112222','María Cliente');
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,created_at)
      VALUES(1,1,1,'+56911112222','María Cliente','[]',10000,'entregado',NOW()-INTERVAL '1 day');
      INSERT INTO bank_movements(id,organization_id,movement_key,date,kind,amount,description,payer,status)
      VALUES(1,1,'m1',CURRENT_DATE,'abono',10000,'Transf. de MARIA PAGADORA','MARIA PAGADORA','pending');
    `);

    const db = load('src/db/database.js', { pg: { Pool } });
    const recon = load('src/services/reconciliation.js', { '../db/database': db });
    const manual = await recon.confirm(1, 1, [{ source: 'bot', id: '1' }], 7);
    assert.equal(manual.learnedIdentity.contact_phone, '11112222');
    assert.equal((await query('SELECT status FROM orders WHERE id=1')).rows[0].status, 'paid');
    const identity = (await query('SELECT * FROM bank_contact_identities WHERE organization_id=1')).rows[0];
    assert.equal(identity.bank_name, 'santander');
    assert.equal(identity.payer_normalized, 'maria pagadora');
    assert.equal(identity.contact_id, 1);
    assert.equal(identity.active, true);

    await engine.exec(`
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,created_at)
      VALUES(2,1,1,'+56911112222','María Cliente','[]',15000,'entregado',NOW()-INTERVAL '1 day');
      INSERT INTO bank_movements(id,organization_id,movement_key,date,kind,amount,description,payer,status)
      VALUES(2,1,'m2',CURRENT_DATE,'abono',15000,'Transf. de MARIA PAGADORA','MARIA PAGADORA','pending');
    `);
    const automatic = await recon.autoMatchPending(1);
    assert.equal(automatic.matched, 1);
    assert.equal((await query('SELECT status FROM orders WHERE id=2')).rows[0].status, 'paid');
    const autoMovement = (await query('SELECT status,match_method,bank_identity_id FROM bank_movements WHERE id=2')).rows[0];
    assert.equal(autoMovement.status, 'matched');
    assert.equal(autoMovement.match_method, 'automatic_identity');
    assert.equal(autoMovement.bank_identity_id, identity.id);
    const learnedStats = await recon.stats(1);
    assert.equal(learnedStats.learned_identities, 1);
    assert.equal(learnedStats.automatic_matched, 1);

    await engine.exec(`
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,created_at)
      VALUES(3,1,1,'+56911112222','María Cliente','[]',5000,'entregado',NOW()-INTERVAL '1 day'),
            (4,1,1,'+56911112222','María Cliente','[]',5000,'entregado',NOW()-INTERVAL '1 day');
      INSERT INTO bank_movements(id,organization_id,movement_key,date,kind,amount,description,payer,status)
      VALUES(3,1,'m3',CURRENT_DATE,'abono',5000,'Transf. de MARIA PAGADORA','MARIA PAGADORA','pending');
    `);
    assert.equal((await recon.autoMatchPending(1)).matched, 0, 'two possible orders must remain for manual review');
    assert.equal((await query('SELECT status FROM bank_movements WHERE id=3')).rows[0].status, 'pending');

    await recon.unmatch(1, 2);
    assert.equal((await query('SELECT active FROM bank_contact_identities WHERE id=$1', [identity.id])).rows[0].active, false);
    assert.equal((await query('SELECT status FROM orders WHERE id=2')).rows[0].status, 'entregado');
  } finally {
    await engine.close();
  }
});
