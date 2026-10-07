const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCheeseWeight } = require('../src/services/catalog-facts');
test('confirmed goat-cheese weight overrides stale imported text without changing prices or special products', () => {
  const product={title:'Queso de Cabra Fresco 800g',price:15000,external_id:'abc',raw_json:JSON.stringify({title:'Queso de Cabra 800g',description:'800 gramos',variants:[{id:'v',title:'800 g',price:15000}]})};
  const fixed=applyCheeseWeight(product,'900 g–1 kg');
  assert.match(fixed.title,/900 g–1 kg/); assert.equal(fixed.price,15000); assert.equal(fixed.external_id,'abc');
  const raw=JSON.parse(fixed.raw_json); assert.equal(raw.variants[0].title,'900 g–1 kg');assert.equal(raw.variants[0].price,15000);
  assert.equal(applyCheeseWeight({...product,is_business:true},'900 g–1 kg').title,product.title);
  for(const title of ['Queso de Vaca 900g','Pack Queso de Cabra + huevos','Queso de Cabra Madurado']) assert.equal(applyCheeseWeight({title},'900 g–1 kg').title,title);
});

test('weight migration targets the general cheese in Diez Ríos only and is repeatable', async () => {
  const {PGlite}=require('@electric-sql/pglite');const fs=require('node:fs');const path=require('node:path');
  const engine=new PGlite();try {
    await engine.exec(`CREATE TABLE organizations(id INT,slug TEXT); INSERT INTO organizations VALUES(1,'diez-rios-mrs96z69'),(2,'otra');
      CREATE TABLE settings(organization_id INT,key TEXT,value TEXT,UNIQUE(organization_id,key));
      CREATE TABLE products(id INT,organization_id INT,title TEXT,description TEXT,updated_at TIMESTAMP,is_business BOOLEAN);
      INSERT INTO products VALUES(11,1,'Queso de Cabra 900 g','anterior',NULL,FALSE),(11,2,'Queso de Cabra 800 g','otra',NULL,FALSE),(12,1,'Queso de Cabra especial 800 g','especial',NULL,TRUE);`);
    const source=fs.readFileSync(path.join(__dirname,'../src/db/setup.js'),'utf8');
    const sql=source.match(/INSERT INTO settings \(organization_id, key, value\)\s+SELECT id, 'goat_cheese_weight'[\s\S]*?AND p.title NOT LIKE[^;]+;/)[0];
    await engine.exec(sql);await engine.exec(sql);
    const rows=(await engine.query('SELECT * FROM products ORDER BY organization_id,id')).rows;
    assert.match(rows[0].title,/900 g–1 kg/);assert.equal(rows[1].description,'especial');assert.equal(rows[2].description,'otra');
  }finally{await engine.close();}
});

test('Diez Ríos catalog migration removes promotions and sets the requested stock safely', async () => {
  const {PGlite}=require('@electric-sql/pglite');const fs=require('node:fs');const path=require('node:path');
  const engine=new PGlite();try {
    await engine.exec(`CREATE TABLE organizations(id INT,slug TEXT); INSERT INTO organizations VALUES(1,'diez-rios-mrs96z69'),(2,'otra');
      CREATE TABLE settings(organization_id INT,key TEXT,value TEXT,UNIQUE(organization_id,key));
      CREATE TABLE products(id INT,organization_id INT,title TEXT,category TEXT,stock INT,updated_at TIMESTAMP);
      INSERT INTO products VALUES
        (1,1,'Huevos XL','Huevos',-1,NULL),
        (2,1,'Queso de Vaca Artesanal – 900 g','Quesos',8,NULL),
        (3,1,'PROMO 60 XL','Huevos',10,NULL),
        (4,1,'Pack Campo Diez Ríos','Para los Caseritos',5,NULL),
        (5,1,'Huevos Especiales','Huevos',0,NULL),
        (6,2,'PROMO ajena','Promociones',7,NULL);`);
    const source=fs.readFileSync(path.join(__dirname,'../src/db/setup.js'),'utf8');
    const sql=source.match(/DELETE FROM products p USING organizations o[\s\S]*?SELECT id, 'promotions_enabled', 'false'[\s\S]*?EXCLUDED\.value;/)[0];
    await engine.exec(sql);await engine.exec(sql);
    const rows=(await engine.query('SELECT id,stock FROM products ORDER BY id')).rows;
    assert.deepEqual(rows.map(r=>[r.id,r.stock]),[[1,100],[2,0],[5,100],[6,7]]);
    const settings=(await engine.query("SELECT key,value FROM settings WHERE organization_id=1 ORDER BY key")).rows;
    assert.deepEqual(settings,[
      {key:'catalog_reset_2026_10_07_applied',value:'true'},
      {key:'catalog_source',value:'local'},
      {key:'promotions_enabled',value:'false'},
    ]);
  }finally{await engine.close();}
});
