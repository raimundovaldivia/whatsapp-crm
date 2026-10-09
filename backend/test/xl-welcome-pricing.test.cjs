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
for(const [title,price,quantity,total] of [['Huevos XL 30 unidades',12000,3,30000],['Huevos M 30 unidades',9000,2,16500],['Huevos M 30 unidades',9000,3,22500],['Huevos Jumbo 20 unidades',10000,3,25000],['Huevos L CAFE',11000,3,27500],['Huevos XL 180 unidades',54000,1,54000],['Queso',15000,3,45000]]){
const lines=p.apply([{title,price,quantity}],p.forStore({enabled:true}));a.equal(Math.round(lines[0].price*quantity),total);
}
a.equal(p.apply([{title:'Huevos XL 30 unidades',price:10000,quantity:3,unit_source:'especial'}],p.forStore({enabled:true}))[0].price,10000);
});
