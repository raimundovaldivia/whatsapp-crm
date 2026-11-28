const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response, noop } = require('./helpers.cjs');
const pricing = require('../src/services/manual-order-pricing');

const catalog = [
  { id: 11, title: 'Huevos XL cafés · Bandeja de 30', price: 12990 },
  { id: 12, title: 'Manjar', price: 7000 },
];
const ctx = { enabled: true };
const cart = [{ productId: 11, quantity: 2 }, { productId: 12, quantity: 1, discountType: 'percent', discount: 10 }];

test('manual total reconciles volume, product and order discounts in pesos and in the message', () => {
  const q = pricing.calculate({ items: cart, manualTotal: 28000 }, catalog, ctx);
  assert.deepEqual([q.baseTotal, q.volumeSaving, q.lineSaving, q.orderAdjustment, q.total, q.saving], [32980, 2180, 700, -2100, 28000, 4980]);
  assert.equal(q.items.reduce((s, i) => s + i.line_total, 0), q.total);
  assert.match(pricing.summary(q), /por cantidad −\$2\.180/);
  assert.match(pricing.summary(q), /descuento del producto −\$700/);
  assert.match(pricing.summary(q), /Descuento adicional: −\$2\.100/);
  assert.match(pricing.summary(q), /Total: \$28\.000$/);
  assert.throws(() => pricing.verify(q, 'old'), { status: 409 });
});

test('duplicate rows share the web scale and preserve custom prices, gifts, percentages and increases', () => {
  const item = { productId: 11, quantity: 1 };
  const configured = [{ ...catalog[0], quantity_prices: [12990, 22001] }];
  const split = pricing.calculate({ items: [item, { ...item, discount: 1, discountType: 'fixed' }] }, configured, ctx);
  assert.equal(split.volumeSaving, 3979);
  assert.equal(split.total, 22000);
  assert.equal(pricing.calculate({items: cart, manualTotal: 0},catalog,ctx).total, 0);
  assert.equal(pricing.calculate({items: [{...item, unitPrice: 10000, quantity: 2}]},catalog,ctx).total,20000);
  assert.equal(pricing.calculate({items: [{...item, quantity: 2}]},[{ ...catalog[0], price: 11000, special_price: true }],ctx).total,22000);
  const free = pricing.calculate({items:[{ name:'Muestra',unitPrice:0,quantity:3 }],manualTotal:900},catalog,ctx);
  assert.equal(free.items[0].price,300);
  assert.match(pricing.summary(free), /Ajuste adicional: \+\$900/);
  assert.equal(pricing.calculate({items: cart, discount:10,discountType:'percent'},catalog,ctx).total,27090);
  for (const invalid of [{items:[{...item,discount:110}]},{items:[{...item,discount:15000,discountType:'fixed'}]},{items:[{...item,quantity:0}]},{items:[{...item,productId:99}]},{items:cart,manualTotal:-1}]) {
    assert.throws(()=>pricing.calculate(invalid,catalog,ctx),{status:400});
  }
});

test('public quote, both manual order forms, persisted prices and WhatsApp summary agree', async () => {
  const engine = new PGlite();
  const query = async (sql, args) => {
    const r = args?.length ? await engine.query(sql, args) : (await engine.exec(sql)).at(-1);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  class Pool { query(...args) { return query(...args); } async connect() { return {query,release(){}}; } async end() {} }
  try {
    await load('src/db/setup.js',{ pg:{ Pool } }).setupDatabase();
    await engine.exec("INSERT INTO organizations(id,name,slug) VALUES(1,'Test','diez-rios-mrs96z69'); INSERT INTO conversations(id,organization_id,phone_number,contact_name) VALUES(2,1,'56900000000','QA');");
    for (const p of catalog) await query('INSERT INTO products(id,organization_id,title,price,stock,active,is_business) VALUES($1,1,$2,$3,40,true,false)', [p.id,p.title,p.price]);
    const db = load('src/db/database.js',{pg:{Pool}});
    let message;
    const deps = {'../db/database':db,'../middleware/auth':{requireAuth:noop,requireRole:()=>noop},
      '../services/manual-order-pricing':pricing, '../services/order-notices':{enabled:async()=>true,send:async(_org,_to,n)=>{message=n.details;return {};}}};
    const products = load('src/routes/products.js',deps), orders = load('src/routes/orders.js',deps);
    const chat = load('src/routes/conversations.js',deps), store=load('src/routes/store.js',deps);
    async function post(router,path,body,params={}) {
      const res=response(); await handler(router,'post',path)({params,body,orgId:1,userId:1},res);return res;
    }
    const phone='56900000000';
    const web=await post(store,'/diez-rios-mrs96z69/quote',{phone,items:cart.map(({productId,quantity})=>({productId,quantity}))},{slug:'diez-rios-mrs96z69'});
    assert.equal(web.code,200,JSON.stringify(web.body)); assert.equal(web.body.total,30800);
    const input={phone,items:cart,manualTotal:28000};
    const quote=await post(products,'/order-quote',input);
    assert.equal(quote.code,200,JSON.stringify(quote.body));
    assert.equal(quote.body.baseTotal-quote.body.volumeSaving,web.body.total);
    const request={...input,manualPricing:true,quoteSignature:quote.body.signature,customerName:'QA'};
    const panel=await post(orders,'/',request), fromChat=await post(chat,'/2/orders',request,{id:'2'});
    assert.equal(panel.code,201,JSON.stringify(panel.body));
    assert.equal(fromChat.code,200,JSON.stringify(fromChat.body));
    assert.equal(message,pricing.summary(quote.body));
    for (const row of (await query('SELECT items,total_price FROM orders')).rows) {
      assert.equal(Number(row.total_price),28000);
      assert.deepEqual(typeof row.items==='string'?JSON.parse(row.items):row.items,quote.body.items);
    }
    await query('UPDATE products SET price=14000 WHERE id=11');
    const stale=await post(chat,'/2/orders',request,{id:'2'});
    assert.equal(stale.code,409);
    assert.equal(Number((await query('SELECT count(*) AS n FROM orders')).rows[0].n),2);
  } finally { await engine.close(); }
});
