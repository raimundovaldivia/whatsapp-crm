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
