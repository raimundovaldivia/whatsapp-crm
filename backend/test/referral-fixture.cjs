const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const rules = require('../src/services/referral-rules');
const normalizePhone = x => { const s=String(x||'').replace(/\D/g,'');return /^9\d{8}$/.test(s)?`56${s}`:s; };


async function fixture(t, options = {}) {
  const pg = new PGlite(); t.after(()=>pg.close());
  await pg.exec(`
    -- Legacy commerce TIMESTAMP columns contain UTC; do not inherit the host offset.
    SET TIME ZONE 'UTC';
    CREATE TABLE organizations(id SERIAL PRIMARY KEY,slug TEXT);
    CREATE TABLE users(id SERIAL PRIMARY KEY,organization_id INTEGER);
    CREATE TABLE contacts(id SERIAL PRIMARY KEY,organization_id INTEGER NOT NULL,phone TEXT,name TEXT,opt_out BOOLEAN DEFAULT FALSE);
    CREATE TABLE orders(id SERIAL PRIMARY KEY,organization_id INTEGER,customer_phone TEXT,customer_name TEXT,
      total_price TEXT,items TEXT DEFAULT '[]',status TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),
      delivered_at TIMESTAMP,payment_marked_at TIMESTAMP,shopify_order_id TEXT,shopify_draft_id TEXT,invoice_url TEXT);
    CREATE TABLE shopify_orders(organization_id INTEGER,shopify_order_id TEXT,customer_phone TEXT,total_price NUMERIC,
      financial_status TEXT,crm_status TEXT,shopify_created_at TIMESTAMP,synced_at TIMESTAMP,delivered_at TIMESTAMP,payment_marked_at TIMESTAMP);
    CREATE TABLE order_returns(organization_id INTEGER,source TEXT,order_id TEXT,status TEXT);
    CREATE TABLE products(id SERIAL PRIMARY KEY,organization_id INTEGER,title TEXT,stock INTEGER,active BOOLEAN DEFAULT TRUE,updated_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE delivery_routes(id SERIAL PRIMARY KEY,organization_id INTEGER,status TEXT,orders JSONB,started_at TIMESTAMP);
    CREATE TABLE conversations(id SERIAL PRIMARY KEY,organization_id INTEGER,phone_number TEXT,contact_name TEXT,agent_mode TEXT DEFAULT 'ai',pipeline_state TEXT,delivery_state TEXT);
    INSERT INTO organizations VALUES(1,'one'),(2,'two');
    INSERT INTO users VALUES(1,1),(2,2);
    INSERT INTO contacts(organization_id,phone,name) VALUES(1,'56911111111','Ana'),(2,'56922222222','Otra empresa');
    INSERT INTO products(organization_id,title,stock) VALUES(1,'Bandeja 30 huevos',10),(2,'Bandeja ajena',10);
    INSERT INTO orders(organization_id,customer_phone,total_price,status,created_at,delivered_at)
      VALUES(1,'56911111111','10000','paid',NOW()-INTERVAL '30 days',NOW()-INTERVAL '29 days');
  `);
  for (const file of ['referrals.sql','referrals-rewards-v2.sql','referrals-rewards-v2.sql']) await pg.exec(fs.readFileSync(path.join(__dirname,'../src/db',file),'utf8'));
  const locks = [];
  const query = async (sql,args) => {
    if (sql.includes('pg_advisory_xact_lock')) { locks.push([...args]); return {rows:[]}; }
    const result = await pg.query(sql,args); return {...result,rowCount:result.affectedRows ?? result.rows.length};
  };
  // PGlite has one connection. Lease it for the entire transaction so concurrent
  // service calls cannot interleave BEGIN/COMMIT on that connection. This tests
  // competing requests with serialized transactions, not PostgreSQL lock contention.
  let available = Promise.resolve();
  const connect = async () => {
    const previous = available;
    let release;
    available = new Promise(resolve => { release = resolve; });
    await previous;
    return { query, release };
  };
  const pool = { connect, query: async (sql,args) => {
    const client = await connect();
    try { return await client.query(sql,args); } finally { client.release(); }
  } };
  const db={getPool:()=>pool,normalizePhone,normalizeName:x=>String(x||'')};
  const engine=load('src/services/referral-engine.js',{'../db/database':db,'./referral-rules':rules,'./delivery-items':{syncOrderIntoUnstartedRoutes:options.syncRoutes || (async()=>{})}});
  await engine.saveSettings(1,1,{enabled:true,rules:{...(options.rules || rules.DEFAULT_RULES),gift_product_id:1}});
  const code=await engine.createCode(1,1,1);
  await query("UPDATE referral_codes SET rules_adopted_at=NOW()-INTERVAL '7 days' WHERE id=$1",[code.id]);
  const addReferral=async(n=1)=>{
    const phone=`5693333333${n}`;
    const {rows:[r]}=await query(`INSERT INTO referrals(organization_id,referral_code_id,referred_phone,created_at)
      VALUES(1,$1,$2,NOW()-INTERVAL '2 days') RETURNING *`,[code.id,phone]);
    return r;
  };
  const addOrder=async(phone,status='paid',org=1)=>{
    const {rows:[o]}=await query(`INSERT INTO orders(organization_id,customer_phone,customer_name,total_price,status,created_at,delivered_at,items)
      VALUES($1,$2,'Cliente','10000',$3,NOW()-INTERVAL '1 day',CASE WHEN $3='paid' THEN NOW() ELSE NULL END,'[{"title":"Huevos","quantity":1,"price":10000}]') RETURNING *`,[org,phone,status]);
    return o;
  };
  const capture = load('src/services/referrals.js', {'../db/database':db,'./referral-engine':engine});
  return {pg,query,pool,db,engine,code,addReferral,addOrder,capture,locks};
}

module.exports = { fixture };
