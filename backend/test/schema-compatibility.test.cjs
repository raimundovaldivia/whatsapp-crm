const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const offers = require('../src/services/campaign-offers-store');

test('integrated setup preserves recovery and campaign offers without mixing their schemas or tenants', async () => {
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
  try {
    const setup = load('src/db/setup.js', { pg: { Pool } });
    await setup.setupDatabase();
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b');
      INSERT INTO conversations(id,organization_id,phone_number) VALUES(1,1,'56911111111'),(2,2,'56922222222');
      INSERT INTO products(id,organization_id,title,price,stock) VALUES(1,1,'Huevos',10000,10);
      INSERT INTO personal_offers(organization_id,conversation_id,inbound_anchor,discount_amount,price_reason_source,price_reason_confidence,status,expires_at)
      VALUES(1,1,NOW(),1000,'manual',1,'sent',NOW()+INTERVAL '1 day');
    `);
    const pool = new Pool();
    const draft = await offers.createDraft(pool, 1, 1, {
      product_id: '1', offer_price: 8000, scope: 'all_units',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    await offers.markSent(pool, 1, draft.id, null);
    const beforeRecovery = (await query('SELECT * FROM personal_offers ORDER BY id')).rows;
    const beforeCampaigns = (await query('SELECT * FROM campaign_offers ORDER BY id')).rows;
    await setup.setupDatabase();
    assert.deepEqual((await query('SELECT * FROM personal_offers ORDER BY id')).rows, beforeRecovery);
    assert.deepEqual((await query('SELECT * FROM campaign_offers ORDER BY id')).rows, beforeCampaigns);
    const own = await offers.activeForConversation(pool, 1, 1);
    assert.equal(own.length, 1);
    assert.equal(own[0].offer_price, 8000);
    assert.equal((await offers.activeForConversation(pool, 2, 1)).length, 0);
    await assert.rejects(offers.markSent(pool, 2, draft.id, null), /Oferta no encontrada/);
    assert.deepEqual((await query('SELECT * FROM campaign_offers ORDER BY id')).rows, beforeCampaigns);
    assert.ok((await query("SELECT to_regclass('referral_rewards') AS rewards, to_regclass('delivery_customer_events') AS delivery")).rows[0].rewards);
    assert.ok((await query("SELECT to_regclass('delivery_customer_events') AS delivery")).rows[0].delivery);
  } finally {
    await engine.close();
  }
});
