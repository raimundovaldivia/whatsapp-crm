const { test } = require('node:test');
const assert = require('node:assert/strict');
const rule = require('../src/services/xl-welcome-pricing');
const ctx = { enabled: true, eligible: true };
const line = (n, price, quantity = 1) => ({ title: `Huevos XL ${n} unidades`, price, quantity });
test('approved tiers and equivalent baskets have the same total', () => {
  for (const [n, price] of Object.entries(rule.TIERS)) assert.equal(rule.scaleTotal(Number(n)), price);
  assert.equal(rule.apply([line(30,12000,6)],ctx)[0].price * 6,54000);
  assert.equal(rule.apply([line(30,12000,2)],ctx)[0].price * 2,22000);
  assert.equal(rule.scaleTotal(90),33000);
  assert.equal(rule.scaleTotal(20),null);
});
test('no changes to other calibers, combinations, quotes or special tariffs', () => {
  const items=[line(20,9000),{title:'30 huevos M',price:9000,quantity:1},
    {title:'30 XL + queso',price:25000,quantity:1},{...line(30,12000),locked_quote:true},
    {...line(30,10500),unit_source:'especial'}];
  assert.deepEqual(rule.apply(items,ctx),items);
  assert.equal(rule.apply([line(30,10000)],ctx)[0].price,10000);
  assert.equal(rule.apply([line(30,12000)],{enabled:true,eligible:false})[0].price,12000);
  assert.equal(rule.apply([{title:'Huevos XL · Caja de 180',price:55000,quantity:1}],rule.forStore({enabled:true}))[0].price,55000);
  assert.equal(rule.apply([{title:'Huevos Jumbo · Caja de 100',price:37000,quantity:1}],rule.forStore({enabled:true}))[0].price,37000);
});
test('previous purchases qualify by actual scale price, not just an XL title', () => {
  assert.equal(rule.historicalScale({items:JSON.stringify([line(30,11000)])}),true);
  assert.equal(rule.historicalScale({items:[line(30,12000)]}),false);
  assert.equal(rule.historicalScale({items:[line(30,9000,6)]}),true);
  assert.equal(rule.historicalScale({items:'broken'}),false);
});
test('welcome does not stack with discounts and preserves a better offer', () => {
  const quote={items:[line(30,12000)],subtotal:12000,total:10800,discountPct:10,discountAmount:1200};
  assert.equal(rule.applyQuote(quote,ctx),quote);
  const scaled=rule.applyQuote({...quote,total:11400,discountPct:5,discountAmount:600},ctx);
  assert.equal(scaled.total,11000); assert.equal(scaled.discountAmount,0);
});
test('eligibility is scoped to store and full purchase history',async()=>{
  let history=[];
  const db={query:async sql=>({rows:sql.includes('SELECT slug')?[{slug:rule.STORE_SLUG}]:sql.includes('UNION ALL')?history:[]})};
  assert.equal((await rule.context(db,1,'+56 9 1111 1111')).eligible,true);
  history=[{items:[line(30,12000)]}];
  assert.equal((await rule.context(db,1,'911111111')).eligible,false);
  history.push({items:[line(60,22000)]});
  assert.equal((await rule.context(db,1,'56911111111')).eligible,true);
  assert.equal((await rule.context({query:async()=>({rows:[{slug:'other'}]})},2,'56911111111')).enabled,false);
});

require('node:test')('web scale starts at 12000 and applies quantity pricing for returning customers',()=>{
const assert=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const ctx=p.forStore({enabled:true,eligible:false});
for(const [quantity,total] of [[1,12000],[2,22000],[6,54000]]){
const items=p.apply([{title:'Huevos XL 30 unidades',quantity,price:12000}],ctx);
assert.equal(items[0].price*quantity,total);
}
assert.equal(p.scaleTotal(30),11000);
});

require('node:test')('quantity promotion covers egg trays and preserves bulk and special prices',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
for(const [title,price,quantity,total] of [['Huevos XL 30 unidades',12000,3,30000],['Huevos M 30 unidades',9000,2,18000],['Huevos M 30 unidades',9000,3,27000],['Huevos de Campo Tamaño M Blancos – Bandeja 30 Unidades',9000,3,27000],['Huevos Jumbo 20 unidades',10000,3,25000],['Huevos L CAFE',11000,3,27500],['Huevos XL 180 unidades',54000,1,54000],['Queso',15000,3,45000]]){
const lines=p.apply([{title,price,quantity}],p.forStore({enabled:true}));a.equal(Math.round(lines[0].price*quantity),total);
}
a.equal(p.apply([{title:'Huevos XL 30 unidades',price:10000,quantity:3,unit_source:'especial'}],p.forStore({enabled:true}))[0].price,10000);
});

require('node:test')('bot uses storefront tray totals for natural customers',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const ctx=p.forStore({enabled:true});
const items=[{title:'Huevos Jumbo 20 unidades',price:10000,quantity:3}];
a.equal(p.applyQuote({items,total:30000},ctx).total,25000);
a.match(p.prompt(ctx,[{title:'Huevos Jumbo · Bandeja de 20',price:10000}]),/presentación exacta = 1 bandeja de 20 huevos/);
a.match(p.prompt(ctx,[{title:'Huevos Jumbo · Bandeja de 20',price:10000}]),/3 bandejas \$25000/);
a.match(p.prompt(ctx,[{title:'Huevos Jumbo · Bandeja de 20',price:10000}]),/5 bandejas \$43300/);
a.match(p.prompt(ctx,[{title:'Huevos Jumbo · Bandeja de 20',price:10000}]),/Una caja NO es sinónimo de una bandeja/);
a.match(p.prompt(ctx,[{title:'Huevos Jumbo · Bandeja de 20',price:10000}]),/¿De cuántos huevos necesitas la caja\?/);
a.match(p.prompt(ctx,[]),/misma talla, mismo color y misma cantidad de huevos por bandeja/);
a.match(p.prompt(ctx,[]),/bandejas M no tienen descuento/);
});

require('node:test')('quotes 100 XL as five active 20-egg trays and explains the discount boundary',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const products=[
  {id:1,title:'Huevos XL blancos · Bandeja de 20',egg_size:'XL',egg_color:'blancos',pack_units:20,price:8490,stock:10,active:true},
  {id:2,title:'Huevos XL mixtos · Bandeja de 20',egg_size:'XL',egg_color:'mixtos',pack_units:20,price:8990,stock:10,active:true},
  {id:3,title:'Huevos XL cafés · Bandeja de 20',egg_size:'XL',egg_color:'cafés',pack_units:20,price:9990,stock:10,active:true},
  {id:4,title:'Huevos XL blancos · Bandeja de 30',egg_size:'XL',egg_color:'blancos',pack_units:30,price:10990,stock:10,active:true},
];
const reply=p.quantityPriceReply('¿Qué valor tendrían los 100?',[
  {direction:'inbound',content:'Hola, ¿cuánto sale la caja?'},
  {direction:'inbound',content:'¿XL no tiene?'},
],products,p.forStore({enabled:true}));
a.match(reply,/No tenemos una caja activa de 100 huevos XL/);
a.match(reply,/Blancos: 5 bandejas de 20 — \$36\.800/);
a.match(reply,/Mixtos: 5 bandejas de 20 — \$39\.000/);
a.match(reply,/Cafés: 5 bandejas de 20 — \$43\.300/);
a.match(reply,/no se mezclan colores ni formatos/);
});

require('node:test')('does not replace an active exact box with tray math',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const products=[
  {id:1,title:'Huevos XL blancos · Bandeja de 20',price:8490,stock:10,active:true},
  {id:2,title:'Caja de 100 huevos XL',price:37000,stock:3,active:true},
];
a.equal(p.quantityPriceReply('¿Cuánto sale la caja de 100 XL?',[],products,p.forStore({enabled:true})),null);
});

require('node:test')('quotes two trays deterministically with exact totals and savings',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const products=[
  {id:1,title:'Huevos XL blancos · Bandeja de 30',price:10990,stock:10,active:true},
  {id:2,title:'Huevos XL mixtos · Bandeja de 30',price:11990,stock:10,active:true},
  {id:3,title:'Huevos XL cafés · Bandeja de 30',price:12990,stock:10,active:true},
];
const reply=p.trayCountPriceReply('Quiero 2 bandejas XL de 30',[],products,p.forStore({enabled:true}));
a.match(reply,/Blancos, bandeja de 30: \$20\.100 \(ahorras \$1\.880\)/);
a.match(reply,/Mixtos, bandeja de 30: \$22\.000 \(ahorras \$1\.980\)/);
a.match(reply,/Cafés, bandeja de 30: \$23\.800 \(ahorras \$2\.180\)/);
a.match(reply,/no se mezclan colores ni formatos/);
});

require('node:test')('infers a concise tray count only from the customer context',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const products=[{title:'Huevos XL cafés · Bandeja de 30',price:12990,stock:10,active:true}];
const history=[
  {direction:'inbound',content:'Quiero XL cafés de 30'},
  {direction:'outbound',content:'¿Cuántas bandejas necesitas?'},
];
a.match(p.trayCountPriceReply('2',history,products,p.forStore({enabled:true})),/\$23\.800/);
a.equal(p.trayCountPriceReply('2',[],products,p.forStore({enabled:true})),null);
a.equal(p.trayCountPriceReply('2 bandejas',[],products,p.forStore({enabled:true})),null);
});

require('node:test')('explains that M trays keep their regular total',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const products=[{title:'Huevos M mixtos · Bandeja de 30',price:8990,stock:10,active:true}];
const reply=p.trayCountPriceReply('2 bandejas M de 30',[],products,p.forStore({enabled:true}));
a.match(reply,/\$17\.980/);
a.match(reply,/no tienen descuento por cantidad/);
});

require('node:test')('delivery fee matches the public storefront rule',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
a.equal(p.deliveryPriceLine({},10000),'');
a.match(p.deliveryPriceLine(p.forStore({enabled:true}),'15000'),/\$1\.500.*gratis desde \$15\.000/);
a.match(p.deliveryPriceLine(p.forStore({enabled:true}),null),/gratis desde \$10\.000/);
});
