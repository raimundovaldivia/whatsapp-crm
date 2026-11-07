const test = require('node:test');
const assert = require('node:assert/strict');
const { AD_ID, resolve } = require('../src/services/diez-rios-box-ad');
const { priceItems } = require('../src/services/order-pricing');
const { PGlite } = require('@electric-sql/pglite');

const products = [
  { id: '1', sku: 'DR-EGG-BOX-XL-180', title: 'Huevos XL · Caja de 180', priceMin: 55000 },
  { id: '2', sku: 'DR-EGG-BOX-JUMBO-100', title: 'Huevos Jumbo · Caja de 100', priceMin: 37000 },
];
const ad = { ad_id: AD_ID, message_id: 19, provider: 'evolution' };
const incoming = { pool: { query: async () => ({ rows: [] }) }, orgId: 1, isDiezRios: true,
  phone: '56911111111', destination:'56942876413', ad, inbound: {id:19}, draft:{}, products };

test('primera compra por anuncio mantiene los precios por unidad en el mensaje y el carrito', async () => {
  for (const input of [incoming, {...incoming, inbound:{id:20},draft:{box_ad_message_id:'19'}}]) {
    const promo = await resolve(input);
    assert.match(promo.reply,/45\.000/);
    assert.match(promo.reply,/27\.000/);
    assert.doesNotMatch(promo.reply,/55\.000|37\.000/);
    const lines = products.map(p=>({product_name:p.title,product_id:p.id,quantity:1}));
    assert.equal(priceItems(lines,promo.products,{specialPrices:promo.specialPrices}).total,72000);
    assert.equal(priceItems([{...lines[0],quantity:2}],promo.products,{specialPrices:promo.specialPrices}).total,90000);
    assert.equal(priceItems(lines, products).total,92000);
  }
});

test('la tarifa queda por teléfono y tienda; distingue compras anteriores y posteriores al anuncio', async () => {
  const pool = new PGlite();
  try {
    await pool.exec(`
      CREATE TABLE box_ad_customers(organization_id int, phone text, ad_id text, entry_message_id text, PRIMARY KEY(organization_id,phone,ad_id));
      CREATE TABLE conversations(id int, organization_id int, phone_number text, whatsapp_channel_id int);
      CREATE TABLE whatsapp_channels(id int, organization_id int, phone_number text);
      CREATE TABLE whatsapp_attributions(id int, message_id int, conversation_id int, organization_id int, ad_id text, provider text, source_type text, first_seen_at timestamptz);
      CREATE TABLE orders(id int, shopify_order_id text, conversation_id int, organization_id int, customer_phone text, created_at timestamp, items text, status text);
      CREATE TABLE shopify_orders(shopify_order_id text, organization_id int, customer_phone text, shopify_created_at timestamp, items text, crm_status text, financial_status text, delivered_at timestamp, fulfillment_status text);
      INSERT INTO whatsapp_channels VALUES(7,1,'56942876413');
      INSERT INTO conversations VALUES(3,1,'56911111111',7),(4,1,'56922222222',7);
      INSERT INTO orders(id,organization_id,customer_phone,created_at,status) VALUES
        (1,1,'56922222222','2026-11-01','paid'), (2,1,'56911111111','2026-11-05','paid');
    `);
    for (const id of [3,4]) await pool.query(`INSERT INTO whatsapp_attributions VALUES(1,19,$1,1,$2,'evolution','ad','2026-11-02')`, [id, AD_ID]);
    const organic = {...incoming,pool,ad:null,draft:{},inbound:{id:35},destination:null};
    assert.equal(await resolve({...organic,phone:'56922222222'}),null);
    assert.equal(await resolve({...organic,orgId:2}),null);
    assert.ok(await resolve(organic));
    await pool.exec('DELETE FROM whatsapp_attributions');
    const again = await resolve({...organic, phone:'+56 9 1111 1111', allowEnrollment:false,
      products:[...products,{id:'3',title:'Queso',priceMin:7900}]});
    assert.equal(again.fresh,false);
    assert.deepEqual(again.specialPrices,{'1':45000,'2':27000});
    assert.equal(again.products[2].priceMin,7900);
    assert.equal(await resolve({...organic,phone:'56933333333'}),null);
    assert.equal((await pool.query('SELECT * FROM box_ad_customers')).rows.length,1);
  } finally {await pool.close();}
});

test('cierra acceso ante compra anterior, mensaje directo, otra marca, otro anuncio o atribución histórica', async () => {
  const purchased = {query:async()=>({rows:[{id:1,status:'PAID',date:'2026-11-01',phone:incoming.phone}]})};
  for (const patch of [{pool:purchased},{ad:null},{ad:{...ad,ad_id:'999'}},{isDiezRios:false},
    {inbound:{id:20},draft:{}},{ad:{...ad,provider:'kapso'}},{phone:''},{destination:'56900000000'}]) {
    assert.equal(await resolve({...incoming,...patch}),null);
  }
});
