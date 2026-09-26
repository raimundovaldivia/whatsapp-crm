const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const pricing = require('../src/services/order-pricing');
const confirmation = require('../src/services/order-confirmation');
const orders = load('src/services/agents/orders.js', {'@anthropic-ai/sdk':class {},'../order-pricing':pricing});
const draft = {customer_name:'Cliente',address:'Calle 1',city:'Ciudad',items:[{product_name:'Producto XL',quantity:1}]};
test('a model marker or ambiguous customer text cannot confirm an order',()=>{
  for (const message of ['si pero espera','sin azúcar','listo el pago','ya pagué','ok cambia a dos','hola']) {
    assert.equal(orders.isOrderConfirmed('ORDEN_CONFIRMADA',message,draft),false,message);
  }
  assert.equal(orders.isOrderConfirmed('','Sí!',draft),true);
  assert.equal(orders.isOrderConfirmed('ORDEN_CONFIRMADA','confirmo',{}),false);
});
test('catalog availability, invalid quantities and merged volume prices are enforced',()=>{
 const products=[{id:'1',title:'Producto XL',price:100,bulk_price:80,bulk_min_qty:2,inventoryQuantity:2}];
 const price=items=>pricing.priceItems(items,products);
 assert.equal(price([{product_name:'Producto XL',quantity:3}]).items[0].matched,false);
 for(const quantity of [0,-1,1.5,'abc']) assert.equal(price([{product_name:'Producto XL',quantity}]).items[0].matched,false);
 const merged=price([{product_name:'Producto XL',quantity:1},{product_name:'Producto XL',quantity:1}]);
 assert.equal(merged.total,160);
 products[0].inventoryQuantity=0;
 assert.equal(price(draft.items).items[0].unavailable,true);
 products[0].inventoryQuantity=-1;
 assert.equal(price(draft.items).items[0].matched,true,'untracked stock remains available');
});
test('pipeline presents a real summary, requires customer confirmation and rechecks changed totals',async()=>{
 let saved,created=0;
 const db={getPrimaryDataSource:async()=>null,updatePipelineState:async(_id,_state,value)=>{saved=structuredClone(value);},
   getSetting:async()=> 'cod',claimOrderCreation:async()=>true,createOrder:async()=>{created++;return {id:1};},
   upsertContact:async()=>{},promoteToCustomer:async()=>{},updateOrder:async()=>{}};
 const agent={...orders,extractOrderData:async()=>({...draft,items:draft.items.map(i=>({...i}))}),generateOrderResponse:async()=> 'ORDEN_CONFIRMADA Tu pedido queda registrado'};
 const pipeline=load('src/services/pipeline.js',{'../db/database':db,'./order-pricing':pricing,'./order-confirmation':confirmation,'./agents/orders':agent});
 const products=[{id:'1',title:'Producto XL',price:100,inventoryQuantity:10}];
 const run=(message,previous)=>pipeline.handleOrderCollection(1,1,{phone_number:'123'},message,[],previous,'',{products});
 const first=await run('hola',draft);assert.match(first.response,/Revisa tu pedido/);assert.equal(created,0);
 const previous=saved;
 await run('si pero espera',previous);assert.equal(created,0);
 products[0].price=200;
 await run('confirmo',previous);assert.equal(created,0,'changed total needs another summary');
 assert.match((await run('confirmo',saved)).response,/Pedido confirmado/);assert.equal(created,1);
});
