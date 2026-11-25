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
a.match(p.prompt(ctx,[]),/tabla vigente para todos los calibres, incluida la M/);
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

require('node:test')('quotes the single price, pair unit price and exact pair total in order',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing');
const products=[
  {id:1,title:'Huevos XL blancos · Bandeja de 30',price:10990,stock:10,active:true},
  {id:2,title:'Huevos XL mixtos · Bandeja de 30',price:11990,stock:10,active:true},
  {id:3,title:'Huevos XL cafés · Bandeja de 30',price:12990,stock:10,active:true},
];
const reply=p.trayCountPriceReply('Quiero 2 bandejas XL de 30',[],products,p.forStore({enabled:true}));
a.match(reply,/Blancos, bandeja de 30. Una sale \$10\.990.*\$10\.050 cada una \(\$20\.100 en total\)/);
a.match(reply,/Mixtos, bandeja de 30. Una sale \$11\.990.*\$11\.000 cada una \(\$22\.000 en total\)/);
a.match(reply,/Cafés, bandeja de 30. Una sale \$12\.990.*\$11\.900 cada una \(\$23\.800 en total\)/);
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
a.match(p.deliveryPriceLine(p.forStore({enabled:true}),'15000'),/La Serena y Coquimbo.*\$1\.500.*gratis desde \$15\.000/);
a.match(p.deliveryPriceLine(p.forStore({enabled:true}),null),/gratis desde \$10\.000/);
});

require('node:test')('answers free-delivery questions with the exact fee and both covered cities',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing'),web=p.forStore({enabled:true});
const reply=p.deliveryPriceReply('¿El despacho es gratis?',web,'10000');
a.equal(reply,'Sí 😊 El despacho es gratis en compras desde $10.000 en todo La Serena y Coquimbo. Si tu compra es menor a $10.000, el despacho cuesta $1.500.');
a.match(p.deliveryPriceReply('¿Cuánto cuesta el envío?',web,'10000'),/gratis en compras desde \$10\.000/);
a.equal(p.deliveryPriceReply('¿Despachan hoy?',web,'10000'),null);
a.equal(p.deliveryPriceReply('¿El despacho es gratis?',{},'10000'),null);
});

require('node:test')('delivery price replies require a tariff question instead of unrelated words',()=>{
const a=require('node:assert/strict'),p=require('../src/services/xl-welcome-pricing'),web=p.forStore({enabled:true});
for(const message of ['Precio del envío', '¿Cuánto me cobran por el reparto?', '¿El envío tiene algún costo?', 'delivery gratis?', '¿Cuánto sale el despacho?']) {
  a.match(p.deliveryPriceReply(message,web,'15000'),/gratis en compras desde \$15\.000/,message);
}
for(const message of [
  'Hola, quiero comprar 1 bandeja de 30 huevos XL mixtos. Es una prueba interna PRUEBA MESSENGER DR3010, sin cobro ni despacho.',
  'Dirección: Plaza de prueba s/n, La Serena. Pago al recibir. PRUEBA INTERNA, NO COBRAR NI DESPACHAR.',
  'Sin cobro ni despacho', '¿Cuál es el precio de una bandeja con reparto?',
  'La bandeja cuesta $11.990. Quiero despacho', 'Retiro sin costo, no necesito envío',
  'Quiero comprar una bandeja y pagar en efectivo al despacho',
]) a.equal(p.deliveryPriceReply(message,web,'10000'),null,message);
});

test('the configured M scale is identical in a tray quote, an egg-count quote and the prompt', () => {
  const retail = rule.forStore({enabled:true});
  const product = {id:39,title:'Huevos M mixtos · Bandeja de 30',price:8990,stock:100,
    quantity_prices:[8990,16255,22611,28968,35324,40773]};
  const tray = rule.trayCountPriceReply('Quiero 2 bandejas M de 30', [], [product], retail);
  assert.match(tray, /16\.255/);
  assert.doesNotMatch(tray, /no tienen descuento/);
  assert.match(rule.quantityPriceReply('¿Qué precio tienen 120 huevos M?', [], [product], retail) || '', /28\.968/);
  assert.match(rule.prompt(retail, [product]), /2 bandejas \$16255/);
  const [priced] = rule.apply([{...product,quantity:2}],retail);
  assert.equal(priced.unit_source,'escala_catalogo');
  assert.deepEqual(rule.apply([priced],retail),[priced]);
});

const retail = rule.forStore({ enabled: true });
const smallTray = {id:'43',title:'Huevos XL blancos · Bandeja de 20',priceMin:8490,inventoryQuantity:100,quantity_prices:[8490,14938]};
const mediumTray = {id:'39',title:'Huevos M mixtos · Bandeja de 30',priceMin:8990,inventoryQuantity:100,quantity_prices:[8990,16255]};
const trays = [smallTray,mediumTray];
const lastPurchase = {detalleCompleto:true, productos:[{producto:mediumTray.title,cantidad:2}]};

test('new egg-price inquiries get a concrete comparison, repeat customers get their verified presentation', () => {
  const msg = 'Hola, ¿qué precio tienen los huevos?';
  const lead = rule.introductoryTrayReply(msg,[],trays,retail,'lead');
  assert.match(lead,/30 huevos M mixtos.*Una sale \$8\.990\. Si llevas dos iguales, quedan a \$8\.127,50 cada una en promedio \(\$16\.255 en total\)/);
  const repeat = rule.introductoryTrayReply(msg,[],trays,retail,'customer',lastPurchase);
  assert.match(repeat,/última vez.*M mixtos.*\$8\.127,50 cada una en promedio \(\$16\.255 en total\)/);
  assert.doesNotMatch(rule.introductoryTrayReply(msg,[],trays,retail,'unknown',lastPurchase),/última vez/);
  assert.match(rule.prompt(retail,trays,'customer',lastPurchase),/Última compra verificada: 2 × Huevos M mixtos/);
});
test('comparisons respect the applicable single-tray price, stock and conversation context', () => {
  const ctx={...retail,overrides:[{product_id:'39',custom_price:7000}]};
  const msg='¿Cuánto valen los huevos?';
  const intro=rule.introductoryTrayReply(msg,[],trays,ctx,'customer',lastPurchase);
  assert.match(intro,/Una sale \$7\.000\. Si llevas dos iguales, quedan a \$7\.000 cada una \(\$14\.000 en total\)/);
  assert.doesNotMatch(intro,/ahorras/);
  assert.doesNotMatch(rule.trayCountPriceReply('2 bandejas M de 30',[],trays,ctx),/ahorras|no tienen descuento/);
  assert.match(rule.introductoryTrayReply(msg,[],[{...mediumTray,inventoryQuantity:-1}],retail,'lead'),/Si llevas dos iguales/);
  const scarce=[{...mediumTray,inventoryQuantity:1}];
  assert.doesNotMatch(rule.introductoryTrayReply(msg,[],scarce,retail,'lead'),/Si llevas dos iguales/);
  assert.equal(rule.trayCountPriceReply('2 bandejas M de 30',[],scarce,retail),null);
  assert.equal(rule.introductoryTrayReply(msg,[],[{...mediumTray,inventoryQuantity:0}],retail,'lead'),null);
  for (const other of ['Hola','¿Cuánto valen los huevos y el despacho?','Quiero dos bandejas','Precio del manjar'])
    assert.equal(rule.introductoryTrayReply(other,[],trays,retail,'lead'),null);
  assert.equal(rule.introductoryTrayReply(msg,[{direction:'outbound',content:'¿Qué color prefieres?'}],trays,retail,'lead'),null);
});

test('distinguishes the cheapest tray from the best price per egg at the current customer tariff', () => {
  const ask = (message, ctx = retail, available = trays) =>
    rule.introductoryTrayReply(message, [], available, ctx, 'customer', lastPurchase);
  assert.match(ask('¿Cuál es la bandeja más barata?'), /20 huevos XL blancos/);
  assert.match(ask('Quiero huevos que me rindan'), /precio por huevo.*30 huevos M mixtos/);
  assert.match(ask('¿A cuánto los huevos?'), /última vez.*30 huevos M mixtos/);
  assert.match(ask('¿Qué huevos rinden más?', {...retail,overrides:[{product_id:'43',custom_price:5000}]}), /20 huevos XL blancos/);
  assert.match(ask('¿Qué huevos rinden más?', retail, [smallTray,{...mediumTray,inventoryQuantity:0}]), /20 huevos XL blancos/);
  assert.equal(ask('¿Qué bandeja Jumbo rinde más?'), null);
  const prompt = rule.prompt(retail,trays,'lead');
  assert.match(prompt, /menor precio por huevo comprando una es: Huevos M mixtos/);
  assert.match(prompt, /calibre, color y formato manda/);
  assert.match(rule.trayCountPriceReply('¿Cuánto ahorro con 2 bandejas M de 30?',[],trays,retail), /8\.127,50.*16\.255.*Ahorras \$1\.725/);
  assert.match(rule.quantityPriceReply('¿Qué precio tienen 60 huevos M?',[],trays,retail), /8\.990.*8\.127,50.*16\.255/);
});

test('opens with an available 30-egg tray and honours requested sizes and stock', () => {
  const previous20 = {detalleCompleto:true,productos:[{producto:smallTray.title,cantidad:1}]};
  const general = available => rule.introductoryTrayReply('¿A cuánto los huevos?',[],available,retail,'customer',previous20);
  assert.match(general(trays),/Tenemos bandeja de 30 huevos/);
  assert.match(general([smallTray,{...mediumTray,inventoryQuantity:0}]),/última vez.*20 huevos/);
  assert.match(rule.prompt(retail,trays,'lead'),/primera opción es: Huevos M mixtos · Bandeja de 30/);
  const sameCaliber = [smallTray,{...mediumTray,title:'Huevos XL blancos · Bandeja de 30'}];
  const both = rule.trayCountPriceReply('¿Cuánto cuestan 2 bandejas XL?',[],sameCaliber,retail);
  assert.ok(both.includes('bandeja de 20') && both.indexOf('bandeja de 30') < both.indexOf('bandeja de 20'));
  const only20=rule.trayCountPriceReply('¿Cuánto cuestan 2 bandejas XL de 20?',[],sameCaliber,retail);
  assert.match(only20,/bandeja de 20/);
  assert.doesNotMatch(only20,/bandeja de 30/);
});
