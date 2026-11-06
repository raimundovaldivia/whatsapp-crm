const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const tiers = require('../src/services/quantity-pricing');
const pricing = require('../src/services/order-pricing');
const { loadBotCatalog } = require('../src/services/bot-catalog');
const config = {
  'JC-EXTRA-30': { totals: [9900,17900,24900,31900,38900,44900], box_size: 6, units_per_tray: 30 },
  'JC-SUPER-EXTRA-20': { totals: [7900,13900,19900,24900,29900], box_size: 5, units_per_tray: 20 },
};
const products = [
  {id: 60, sku:'JC-EXTRA-30', title:'Huevos Extra de color · Bandeja de 30',price:9900,stock:120,active:true},
  {id: 61, sku:'JC-SUPER-EXTRA-20', title:'Huevos Súper Extra de color · Bandeja de 20',price:7900,stock:100,active:true},
];
test('all eleven approved totals are identical in bot and web; repeated lines merge before pricing', async () => {
  const db = { getSetting: async (org, key) => key === 'catalog_source' ? 'local' : org === 2 ? JSON.stringify(config) : null,
    getProducts: async () => products };
  const bot = await loadBotCatalog(db, 2);
  const web = tiers.decorate(products, tiers.parseConfig(await db.getSetting(2, tiers.SETTING)));
  for (const p of products) for (const [index, total] of config[p.sku].totals.entries()) {
    const q = index + 1;
    const quote = pricing.priceItems([{product_name:p.title, quantity:q}],bot);
    const line = tiers.apply([{id:p.id,quantity:q,price:p.price}],web)[0];
    assert.equal(Math.round(quote.total),total);
    assert.equal(Math.round(line.price*q),total);
  }
  assert.equal(pricing.priceItems([{product_name:products[0].title,quantity:1},{product_name:products[0].title,quantity:2}],bot).total,24900);
  assert.equal(pricing.priceItems([{product_name:products[0].title,quantity:2},{product_name:products[1].title,quantity:2}],bot).total,31800);
  assert.equal(pricing.priceItems([{product_name:'caja Extra de 180 huevos',quantity:1}],bot).total,44900);
  assert.equal(pricing.priceItems([{product_name:'caja Súper Extra de 100 huevos',quantity:2}],bot).total,59800);
  assert.equal(pricing.priceItems([{product_name:'caja Súper Extra de 180 huevos',quantity:1}],bot).unmatched.length,1);
  const other = await loadBotCatalog(db, 3);
  assert.equal(pricing.priceItems([{product_name:products[0].title,quantity:3}],other).total,29700);
  assert.equal(tiers.totalFor(config['JC-EXTRA-30'].totals,12),89800);
  assert.equal(tiers.totalFor(config['JC-EXTRA-30'].totals,0),null);
  assert.equal(tiers.totalFor(config['JC-EXTRA-30'].totals,1.5),null);
  assert.deepEqual(tiers.parseConfig('{bad'),{});
  assert.deepEqual(tiers.parseConfig({wrong:{totals:[10,30]}}),{});
  assert.equal(tiers.decorate([{...products[0],price:10000}],config)[0].quantity_prices,undefined);
});

test('checkout persists exact tier totals, rejects stale prices and foreign products, rolls back stock on failure', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool { query(...args){return query(...args);} async connect(){return {query,release(){}};} async end(){} }
  try {
    await load('src/db/setup.js',{pg:{Pool}}).setupDatabase();
    await engine.exec(`INSERT INTO organizations(id,name,slug) VALUES(2,'Justo Casero','justo-casero-mvg75kb0'),(3,'Other','other');
      INSERT INTO conversations(id,organization_id,phone_number) VALUES(1,2,'56911111111');
      INSERT INTO products(id,organization_id,title,sku,price,stock,active,is_business)
      VALUES(60,2,'Huevos Extra de color · Bandeja de 30','JC-EXTRA-30',9900,120,TRUE,FALSE),
      (61,2,'Huevos Súper Extra de color · Bandeja de 20','JC-SUPER-EXTRA-20',7900,100,TRUE,FALSE),
      (62,3,'Other','JC-EXTRA-30',9900,120,TRUE,FALSE);`);
    await engine.query('INSERT INTO settings(organization_id,key,value) VALUES($1,$2,$3)',[2,tiers.SETTING,JSON.stringify(config)]);
    const db=load('src/db/database.js',{pg:{Pool}});
    const base={conversationId:1,organizationId:2,customerName:'Prueba',customerPhone:'56911111111',shippingAddress:{address:'Prueba',city:'La Serena'}};
    await assert.rejects(()=>db.createStoreOrder({...base,items:[{productId:60,quantity:3}],expectedTotal:29700}),e=>e.code==='PRICE_CHANGED');
    assert.equal((await engine.query('SELECT stock FROM products WHERE id=60')).rows[0].stock,120);
    for(const p of products)for(const [i,total] of config[p.sku].totals.entries()){
      const result=await db.createStoreOrder({...base,items:[{productId:p.id,quantity:i+1}],expectedTotal:total});
      assert.equal(result.total,total);
      assert.equal(Number(result.order.total_price),total);
    }
    await assert.rejects(()=>db.createStoreOrder({...base,items:[{productId:62,quantity:1}]}));
    assert.equal((await engine.query('SELECT stock FROM products WHERE id=62')).rows[0].stock,120);
    assert.equal((await engine.query('SELECT stock FROM products WHERE id=60')).rows[0].stock,99);
    assert.equal((await engine.query('SELECT stock FROM products WHERE id=61')).rows[0].stock,85);
  } finally { await engine.close(); }
});
