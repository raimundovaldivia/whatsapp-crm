const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('la migración y el reclamo de seguimiento respetan organización, baja y duplicados', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool { query(...args) { return query(...args); } async connect() { return { query, release() {} }; } async end() {} }
  try {
    const setup = load('src/db/setup.js', { pg: { Pool } });
    await setup.setupDatabase();
    await setup.setupDatabase();
    const db = load('src/db/database.js', { pg: { Pool } });

    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES (1,'Diez Ríos','diez-rios'),(2,'Otra','otra');
      INSERT INTO conversations(id,organization_id,phone_number,contact_name,pipeline_state,agent_mode,last_inbound_at,last_message_at,order_draft)
      VALUES
        (1,1,'56911111111','Ana','collecting_order','ai',NOW()-INTERVAL '30 minutes',NOW()-INTERVAL '10 minutes','{"items":[{"product_name":"XL","quantity":2}]}'),
        (2,2,'56922222222','Berta','collecting_order','ai',NOW()-INTERVAL '30 minutes',NOW()-INTERVAL '10 minutes','{"items":[{"product_name":"XL","quantity":2}]}'),
        (3,1,'56933333333','Cata','collecting_order','ai',NOW()-INTERVAL '30 minutes',NOW()-INTERVAL '10 minutes','{"items":[{"product_name":"XL","quantity":2}]}'),
        (4,1,'56944444444','Dani','collecting_order','ai',NOW()-INTERVAL '30 minutes',NOW()-INTERVAL '10 minutes','{"items":[{"product_name":"XL","quantity":2}]}'),
        (5,1,'56955555555','Ema','collecting_order','ai',NOW()-INTERVAL '30 minutes',NOW()-INTERVAL '10 minutes','{"items":[{"product_name":"XL","quantity":2}]}');
      INSERT INTO contacts(organization_id,phone,name,opt_out) VALUES (1,'56911111111','Ana',FALSE),(2,'56922222222','Berta',FALSE),(1,'56933333333','Cata',TRUE);
      INSERT INTO messages(conversation_id,direction,content,sent_by,created_at) VALUES
        (1,'outbound','¿Cuál es tu dirección?','ai',NOW()-INTERVAL '10 minutes'),
        (2,'outbound','¿Cuál es tu dirección?','ai',NOW()-INTERVAL '10 minutes'),
        (3,'outbound','¿Cuál es tu dirección?','ai',NOW()-INTERVAL '10 minutes'),
        (4,'outbound','¿Cuál es tu dirección?','ai',NOW()-INTERVAL '10 minutes'),
        (4,'inbound','Aquí va mi dirección','client',NOW()-INTERVAL '1 minute'),
        (5,'outbound','Envíame el comprobante','ai',NOW()-INTERVAL '10 minutes');
      INSERT INTO payment_proofs(organization_id,conversation_id,media_id,created_at)
      VALUES (1,5,'proof-5',NOW()-INTERVAL '1 minute');
    `);

    assert.equal(await db.claimHotClosingFollowUp(1, 2, 'address'), null, 'no puede reclamar otra organización');
    assert.equal(await db.claimHotClosingFollowUp(1, 3, 'address'), null, 'respeta la baja');
    assert.equal(await db.claimHotClosingFollowUp(1, 4, 'address'), null, 'no envía si el cliente respondió mientras se preparaba el seguimiento');
    assert.equal(await db.claimHotClosingFollowUp(1, 5, 'payment'), null, 'no envía si llegó un comprobante de pago');
    assert.ok(await db.claimHotClosingFollowUp(1, 1, 'address'));
    assert.equal(await db.claimHotClosingFollowUp(1, 1, 'address'), null, 'no duplica la misma etapa');
    assert.ok(await db.claimHotClosingFollowUp(1, 1, 'confirmation'), 'permite una segunda etapa');
    assert.equal(await db.claimHotClosingFollowUp(1, 1, 'city'), null, 'máximo dos intentos');

    await engine.exec("UPDATE conversations SET sales_started_at=NOW(), same_day_hold_until=NOW()+INTERVAL '10 minutes' WHERE id=1");
    const cleared = await db.clearSameDayHold(1, 1);
    assert.equal(cleared.sales_started_at, null, 'cierra el intento de despacho del día');
    assert.equal(cleared.same_day_hold_until, null, 'libera la reserva si se acuerda otra fecha');
  } finally {
    await engine.close();
  }
});
