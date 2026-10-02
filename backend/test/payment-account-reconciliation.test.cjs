const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

async function database() {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }
  const setup = load('src/db/setup.js', { pg: { Pool } });
  await setup.setupDatabase();
  const db = load('src/db/database.js', { pg: { Pool } });
  return { engine, query, db };
}

test('voucher and bank movement verify one order together and the operation is reversible', async () => {
  const { engine, query, db } = await database();
  try {
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'A','a');
      INSERT INTO conversations(id,organization_id,phone_number,contact_name) VALUES(1,1,'+56911112222','Cliente Uno');
      INSERT INTO contacts(id,organization_id,phone,name,client_type) VALUES(1,1,'+56911112222','Cliente Uno','personal');
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,payment_method,created_at,delivered_at)
      VALUES(1,1,1,'+56911112222','Cliente Uno','[]',40000,'entregado','transferencia','2026-09-20','2026-09-20');
      INSERT INTO payment_proofs(id,organization_id,conversation_id,order_id,media_id,customer_phone,customer_name,status,
                                 extracted_amount,extracted_date,extracted_reference,ai_confidence,amount_matches,created_at)
      VALUES(1,1,1,1,'media-1','+56911112222','Cliente Uno','pre_verified',40000,'2026-09-21','REF-777','high',TRUE,'2026-09-21');
      INSERT INTO bank_movements(id,organization_id,movement_key,date,kind,amount,description,payer,doc_number,status)
      VALUES(1,1,'m1','2026-09-21','abono',40000,'Transferencia Cliente Uno','Cliente Uno','REF-777','pending');
    `);
    const recon = load('src/services/reconciliation.js', { '../db/database': db });
    const result = await recon.confirm(1, 1, [{ source:'bot', id:'1' }], 9);
    assert.equal(result.proofVerification.verified.id, 1);
    assert.ok(result.proofVerification.evidence.score >= 60);

    const proof = (await query(`SELECT status,bank_movement_id,reconciliation_score,reconciliation_confidence,verification_method
                                  FROM payment_proofs WHERE id=1`)).rows[0];
    assert.equal(proof.status, 'verified');
    assert.equal(proof.bank_movement_id, 1);
    assert.equal(proof.verification_method, 'bank_reconciliation_manual');
    assert.equal((await query('SELECT status FROM orders WHERE id=1')).rows[0].status, 'paid');

    await recon.unmatch(1, 1);
    const reverted = (await query('SELECT status,bank_movement_id,reconciliation_score FROM payment_proofs WHERE id=1')).rows[0];
    assert.equal(reverted.status, 'pre_verified');
    assert.equal(reverted.bank_movement_id, null);
    assert.equal(reverted.reconciliation_score, null);
    assert.equal((await query('SELECT status FROM orders WHERE id=1')).rows[0].status, 'entregado');
  } finally {
    await engine.close();
  }
});

test('two compatible vouchers remain for human review instead of being auto-verified', async () => {
  const { engine, query, db } = await database();
  try {
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'A','a');
      INSERT INTO conversations(id,organization_id,phone_number,contact_name) VALUES(1,1,'+56922223333','Cliente Dos');
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,payment_method,created_at,delivered_at)
      VALUES(1,1,1,'+56922223333','Cliente Dos','[]',12000,'entregado','transferencia','2026-09-20','2026-09-20');
      INSERT INTO payment_proofs(organization_id,conversation_id,order_id,media_id,status,extracted_amount,amount_matches,created_at)
      VALUES(1,1,1,'media-a','pre_verified',12000,TRUE,'2026-09-21'),
            (1,1,1,'media-b','pre_verified',12000,TRUE,'2026-09-21');
      INSERT INTO bank_movements(id,organization_id,movement_key,date,kind,amount,payer,status)
      VALUES(1,1,'m1','2026-09-21','abono',12000,'Cliente Dos','pending');
    `);
    const recon = load('src/services/reconciliation.js', { '../db/database': db });
    const result = await recon.confirm(1, 1, [{ source:'bot', id:'1' }], 9);
    assert.equal(result.proofVerification.verified, null);
    assert.equal(result.proofVerification.candidates, 2);
    assert.deepEqual((await query('SELECT DISTINCT status FROM payment_proofs')).rows.map(r => r.status), ['pre_verified']);
  } finally {
    await engine.close();
  }
});

test('monthly account starts at zero in September and carries debt into October', async () => {
  const { engine, db } = await database();
  try {
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'A','a');
      INSERT INTO conversations(id,organization_id,phone_number,contact_name) VALUES(1,1,'+56933334444','Empresa Cliente');
      INSERT INTO contacts(id,organization_id,phone,name,client_type) VALUES(1,1,'+56933334444','Empresa Cliente','empresa');
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,payment_method,created_at,delivered_at)
      VALUES(1,1,1,'+56933334444','Empresa Cliente','[]',90000,'entregado','transferencia','2026-08-20','2026-08-20'),
            (2,1,1,'+56933334444','Empresa Cliente','[]',40000,'entregado','transferencia','2026-09-20','2026-09-20'),
            (3,1,1,'+56933334444','Empresa Cliente','[]',12000,'entregado','efectivo','2026-09-21','2026-09-21');
      INSERT INTO orders(id,organization_id,conversation_id,customer_phone,customer_name,items,total_price,status,payment_method,
                         payment_cash_amount,payment_transfer_amount,created_at,delivered_at)
      VALUES(4,1,1,'+56933334444','Empresa Cliente','[]',20000,'entregado','mixto',8000,12000,'2026-09-22','2026-09-22');
    `);
    const accounts = load('src/services/payment-accounts.js', { '../db/database': db });
    const september = await accounts.getAccounts(1, '2026-09');
    assert.equal(september.accounts.length, 1);
    assert.equal(september.accounts[0].client_type, 'empresa');
    assert.equal(september.accounts[0].opening_balance, 0, 'August is outside the declared baseline');
    assert.equal(september.accounts[0].charges, 52000, 'mixed orders charge only their transfer portion');
    assert.equal(september.accounts[0].closing_balance, 52000);
    assert.equal(september.summary.orders, 3);
    assert.equal(september.summary.order_total, 72000, 'monthly order total includes full cash and mixed orders');
    assert.equal(september.summary.transfer_orders, 2);

    const october = await accounts.getAccounts(1, '2026-10');
    assert.equal(october.accounts[0].opening_balance, 52000);
    assert.equal(october.accounts[0].charges, 0);
    assert.equal(october.accounts[0].closing_balance, 52000);
  } finally {
    await engine.close();
  }
});
