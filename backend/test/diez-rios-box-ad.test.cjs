const test = require('node:test');
const assert = require('node:assert/strict');
const { AD_ID, resolve } = require('../src/services/diez-rios-box-ad');
const { priceItems } = require('../src/services/order-pricing');

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

test('cierra acceso ante compra anterior, mensaje directo, otra marca, otro anuncio o atribución histórica', async () => {
  const purchased = {query:async()=>({rows:[{id:1,status:'PAID',date:'2026-11-01',phone:incoming.phone}]})};
  for (const patch of [{pool:purchased},{ad:null},{ad:{...ad,ad_id:'999'}},{isDiezRios:false},
    {inbound:{id:20},draft:{}},{ad:{...ad,provider:'kapso'}},{phone:''},{destination:'56900000000'}]) {
    assert.equal(await resolve({...incoming,...patch}),null);
  }
});
