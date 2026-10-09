const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
test('new egg catalog preserves old orders, archives products, and runs once',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE organizations(id INT PRIMARY KEY,slug TEXT);INSERT INTO organizations VALUES(1,'diez-rios-mrs96z69'),(2,'other');
 CREATE TABLE settings(organization_id INT,key TEXT,value TEXT,UNIQUE(organization_id,key));
 CREATE TABLE products(id SERIAL PRIMARY KEY,organization_id INT,title TEXT,description TEXT,price NUMERIC,sku TEXT,stock INT,active BOOLEAN,position INT,category TEXT,is_business BOOLEAN,updated_at TIMESTAMP);
 INSERT INTO products(id,organization_id,title,price,stock,active,is_business) VALUES(1,1,'Huevos M antiguos',9000,25,TRUE,FALSE),(3,1,'Huevos XL anteriores',12000,40,TRUE,FALSE),(4,1,'Huevos empresa',7000,15,TRUE,TRUE),(5,2,'Huevos ajenos',8000,9,TRUE,FALSE),(6,1,'Queso',15000,5,TRUE,FALSE);
 SELECT setval('products_id_seq',100);
 CREATE TABLE contact_price_overrides(organization_id INT,phone TEXT,product_id TEXT,product_title TEXT,custom_price NUMERIC,UNIQUE(organization_id,phone,product_id));
 INSERT INTO contact_price_overrides VALUES(1,'56912345678','3','Huevos XL anteriores',10500);
 CREATE TABLE orders(id INT,items JSONB,total NUMERIC,status TEXT);INSERT INTO orders VALUES(10,'[{"product_id":3,"price":12000,"quantity":2}]',24000,'pending');`);
 const before=(await db.query('SELECT * FROM orders')).rows;
 const sql=fs.readFileSync(path.join(__dirname,'../src/db/eggs-catalog-v2.sql'),'utf8');
 await db.exec(sql);
 const created=(await db.query("SELECT * FROM products WHERE catalog_version='eggs-v2'")).rows;
 assert.equal(created.length,16);assert.ok(created.every(p=>p.stock===100&&p.active));
 assert.deepEqual(created.filter(p=>p.egg_size==='M').map(p=>p.egg_color),['mixtos']);
 assert.equal(created.find(p=>p.egg_size==='XL'&&p.egg_color==='mixtos'&&p.pack_units===30).price,'11990');
 const old=(await db.query('SELECT * FROM products WHERE id=3')).rows[0];assert.equal(old.price,'12000');assert.equal(old.stock,40);assert.equal(old.active,false);assert.ok(old.deprecated_at);
 assert.deepEqual((await db.query('SELECT * FROM orders')).rows,before);
 assert.equal((await db.query('SELECT count(*)::int n FROM contact_price_overrides')).rows[0].n,2);
 await db.exec("UPDATE products SET stock=97 WHERE catalog_version='eggs-v2';");await db.exec(sql);
 assert.equal((await db.query("SELECT count(*)::int n FROM products WHERE catalog_version='eggs-v2' AND stock=97")).rows[0].n,16);
 await assert.rejects(()=>db.exec('DELETE FROM products WHERE id=3'),/conserva/);
 await assert.rejects(()=>db.exec('UPDATE products SET active=TRUE WHERE id=3'),/reactivar/);
 assert.equal((await db.query('SELECT active FROM products WHERE id=4')).rows[0].active,true);
 assert.equal((await db.query('SELECT active FROM products WHERE id=5')).rows[0].active,true);
 }finally{await db.close()}
});
test('new egg products receive the correct catalog photo without replacing a manual image',async()=>{
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE products(id SERIAL PRIMARY KEY,catalog_version TEXT,egg_color TEXT,pack_units INT,image_url TEXT,updated_at TIMESTAMP);
   INSERT INTO products(catalog_version,egg_color,pack_units,image_url) VALUES
   ('eggs-v2','blancos',30,NULL),('eggs-v2','cafés',20,''),('eggs-v2','mixtos',30,NULL),('eggs-v2','blancos',20,'https://example.com/manual.jpg'),('legacy','mixtos',30,NULL);`);
  const sql=fs.readFileSync(path.join(__dirname,'../src/db/egg-product-images.sql'),'utf8');
  await db.exec(sql);
  const rows=(await db.query('SELECT image_url FROM products ORDER BY id')).rows;
  assert.deepEqual(rows.map(row=>row.image_url),[
   '/store-assets/diez-rios/huevos-blancos-hogar-v3.jpg','/store-assets/diez-rios/huevos-cafe-20-hogar-v4.jpg','/store-assets/diez-rios/huevos-mixtos-hogar-v3.jpg','https://example.com/manual.jpg',null,
  ]);
 }finally{await db.close()}
});
test('color variants never share the legacy XL ladder and bot asks about ambiguity',()=>{
 const p=require('../src/services/xl-welcome-pricing'),o=require('../src/services/order-pricing');
 const products=['blancos','mixtos','cafés'].map((color,i)=>({id:i+1,title:`Huevos XL ${color} · Bandeja de 30`,price:10990+i*1000}));
 const q=p.apply(products.map(p=>({...p,quantity:1})),p.forStore({enabled:true}));assert.deepEqual(q.map(i=>i.price),[10990,11990,12990]);
 assert.equal(o.matchProduct('30 XL',o.flattenCatalog(products)).ambiguous,true);
 assert.equal(o.matchProduct('30 XL cafe',o.flattenCatalog(products)).candidate.price,12990);
 assert.equal(o.matchProduct('Huevos XL cafés · Bandeja de 30',o.flattenCatalog(products)).candidate.price,12990);
 assert.match(p.prompt(p.forStore({enabled:true}),products.map(p=>({...p,price:undefined,priceMin:p.price}))),/11990/);
 assert.doesNotMatch(p.prompt(p.forStore({enabled:true}),products),/NaN/);
});
