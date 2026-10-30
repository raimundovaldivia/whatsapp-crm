const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const geo=require('../src/services/delivery-geocoding');
let nextOrg=100;
const address='Avenida Ejemplo 346, sitio 31 (pasado Colegio Alemán), La Serena';
function result(overrides={}) {return {types:['street_address'],geometry:{location:{lat:-29.95,lng:-71.22},location_type:'ROOFTOP'},address_components:[
 {long_name:'346',types:['street_number']},{long_name:'Avenida Ejemplo',types:['route']},
 {long_name:'La Serena',types:['locality']},{short_name:'CL',long_name:'Chile',types:['country']},
 ],...overrides};}
function fixture(response={status:'OK',results:[result()]},rows=[]) {
 const orgId=nextOrg++,writes=[],requests=[],logs=[];let clock=Date.UTC(2026,9,30,18);
 const pool={query:async(sql,args)=>{if(sql.startsWith('SELECT')){assert.equal(args[0],orgId);return {rows};}writes.push({sql,args});return {rows:args.length===4?[{lat:args[2],lng:args[3]}]:[]};}};
 const axios={get:async(url,options)=>{requests.push(options);if(response instanceof Error)throw response;return {data:response};}};
 return {writes,requests,logs,orgId,rows,advance:ms=>clock+=ms,run:options=>geo.geocodeMany({pool,axios,apiKey:'synthetic',orgId,addresses:[address],now:()=>clock,log:code=>logs.push(code),...options})};
}
test('cleans navigation references without mutating delivery text, removes duplicate commune',()=>{
 assert.equal(geo.geocodeQuery(address),'avenida ejemplo 346, la serena');
 assert.equal(geo.geocodeQuery('Hilda Gómez Rifo 4163, fondo de pasaje, reja verde, La Serena'),'hilda gómez rifo 4163, la serena');
 assert.equal(geo.geocodeQuery('Michay 2206, La Serena, La Serena'),'michay 2206, la serena');
 assert.equal(geo.geocodeQuery('Camino rural parcela 21 lote 10 B, La Serena'),'camino rural parcela 21 lote 10 b, la serena');
 assert.equal(geo.geocodeQuery('Avenida Ejemplo 346 casa 31, La Serena'),'avenida ejemplo 346, la serena');
 assert.equal(address,'Avenida Ejemplo 346, sitio 31 (pasado Colegio Alemán), La Serena');
});
test('valid point is stored under original organization/address and query uses clean text',async()=>{
 const f=fixture();const out=await f.run();assert.deepEqual(out[geo.addressKey(address)],{lat:-29.95,lng:-71.22});
 assert.equal(f.requests[0].params.address,'avenida ejemplo 346, la serena');assert.equal(f.requests[0].params.components,'country:CL');
 assert.deepEqual(f.writes[0].args,[f.orgId,geo.addressKey(address),-29.95,-71.22]);
});
for(const status of ['REQUEST_DENIED','OVER_QUERY_LIMIT','OVER_DAILY_LIMIT','UNKNOWN_ERROR','INVALID_REQUEST']){
 test(`${status} does not poison cache and recovers after bounded backoff`,async()=>{
  const response={status,error_message:'secret URL must not be logged'};const f=fixture(response);await f.run();assert.equal(f.writes.length,0);
  await f.run();assert.equal(f.requests.length,1);response.status='OK';response.results=[result()];f.advance(geo.ERROR_BACKOFF_MS+1);
  assert.ok((await f.run())[geo.addressKey(address)]);assert.equal(f.writes.length,1);assert.deepEqual(f.logs,['provider_unavailable']);
 });
}
test('network failures do not persist or log sensitive errors',async()=>{
 const f=fixture(new Error('https://provider/?key=secret&address=private'));await f.run();assert.equal(f.writes.length,0);assert.deepEqual(f.logs,['lookup_unavailable']);
});
test('genuine negatives expire and clear stale coordinates; missing timestamp legacy negatives retry',async()=>{
 const f=fixture({status:'ZERO_RESULTS',results:[]});await f.run();assert.equal(f.writes.length,1);assert.match(f.writes[0].sql,/lat = NULL, lng = NULL/);
 const key=geo.addressKey(address);f.rows.push({address_key:key,found:false,created_at:new Date(Date.UTC(2026,9,30,18))});
 await f.run();assert.equal(f.requests.length,1);f.advance(geo.NEGATIVE_TTL_MS+1);await f.run();assert.equal(f.requests.length,2);
 delete f.rows[0].created_at;await f.run();assert.equal(f.requests.length,3);
});
test('preserves verified positive coordinates, including when explicitly recovering negatives',async()=>{
 const f=fixture(undefined,[{address_key:geo.addressKey(address),found:true,lat:'-29.9',lng:'-71.2'}]);const output=await f.run({retryNegative:true});
 assert.deepEqual(output[geo.addressKey(address)],{lat:-29.9,lng:-71.2});assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
});
test('rejects wrong country, wrong commune, wrong street/number, broad, ambiguous and invalid points',()=>{
 const query=geo.geocodeQuery(address);
 for(const change of [r=>r.address_components[3].short_name='US',r=>r.address_components[2].long_name='Coquimbo',r=>r.address_components[1].long_name='Calle Otra',r=>r.address_components[0].long_name='347',r=>r.geometry.location_type='APPROXIMATE',r=>r.geometry.location.lat=null]){
  const r=result();change(r);assert.equal(geo.selectResult({status:'OK',results:[r]},query),null);
 }
 assert.equal(geo.selectResult({status:'OK',results:[result(),result()]},query),null);
 const regional=result();regional.address_components.push({long_name:'Coquimbo',types:['administrative_area_level_1']});
 assert.equal(geo.selectResult({status:'OK',results:[regional]},'Avenida Ejemplo 346, Coquimbo'),null,'the region must not substitute for the commune');
});
test('same org/key simultaneous lookups share one provider request and cooldown does not cross organizations',async()=>{
 const f=fixture();await Promise.all([f.run(),f.run()]);assert.equal(f.requests.length,1);
 const denied=fixture({status:'REQUEST_DENIED'});await denied.run();const other=fixture();assert.ok((await other.run())[geo.addressKey(address)]);
});
test('neighborhood cannot replace requested street and rural suffixes cannot disappear',()=>{
 const r=result();r.address_components[1].long_name='Puertas del Mar';
 assert.equal(geo.selectResult({status:'OK',results:[r]},'Messina 346 puertas del mar, La Serena'),null);
 const rural=result({formatted_address:'Parcela 58, La Serena, Chile'});
 assert.equal(geo.selectResult({status:'OK',results:[rural]},'Parcela 58-2a, La Serena'),null);
 assert.equal(geo.selectResult({status:'OK',results:[rural]},'Parcela 58, La Serena'),rural);
 rural.partial_match=true;assert.equal(geo.selectResult({status:'OK',results:[rural]},'Parcela 58, La Serena'),null);
 assert.equal(geo.selectResult({status:'OK',results:[result()]},'casa, La Serena'),null);
});
test('actual SQL maintains isolation and recovers old failed rows without schema changes',async()=>{
 const pool=new PGlite();try{
  await pool.exec('CREATE TABLE geocode_cache(organization_id INTEGER,address_key TEXT,lat DOUBLE PRECISION,lng DOUBLE PRECISION,found BOOLEAN,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(organization_id,address_key))');
  const key=geo.addressKey(address);await pool.query("INSERT INTO geocode_cache VALUES (1,$1,NULL,NULL,FALSE,'2026-01-01'),(2,$1,1,2,TRUE,'2026-01-01')",[key]);
  const axios={get:async()=>({data:{status:'OK',results:[result()]}})};
  const output=await geo.geocodeMany({pool,axios,apiKey:'synthetic',orgId:1,addresses:[address]});assert.ok(output[key]);
  const {rows}=await pool.query('SELECT * FROM geocode_cache ORDER BY organization_id');assert.equal(rows[0].lat,-29.95);assert.equal(rows[0].found,true);assert.equal(rows[1].lat,1);assert.equal(rows[1].lng,2);
  await pool.query('UPDATE geocode_cache SET found=FALSE,lat=NULL,lng=NULL WHERE organization_id=$1',[1]);
  const concurrent={get:async()=>{await pool.query('UPDATE geocode_cache SET found=TRUE,lat=-29.8,lng=-71.1 WHERE organization_id=$1',[1]);return {data:{status:'OK',results:[result()]}};}};
  const winner=await geo.geocodeMany({pool,axios:concurrent,apiKey:'synthetic',orgId:1,addresses:[address],retryNegative:true});assert.deepEqual(winner[key],{lat:-29.8,lng:-71.1});
  await pool.query('UPDATE geocode_cache SET found=FALSE WHERE organization_id=$1',[1]);
  const zero={get:async()=>{await pool.query('UPDATE geocode_cache SET found=TRUE WHERE organization_id=$1',[1]);return {data:{status:'ZERO_RESULTS'}};}};
  await geo.geocodeMany({pool,axios:zero,apiKey:'synthetic',orgId:1,addresses:[address],retryNegative:true});
  const final=await pool.query('SELECT * FROM geocode_cache WHERE organization_id=$1',[1]);assert.equal(final.rows[0].found,true);assert.equal(final.rows[0].lat,-29.8);
 }finally{await pool.close();}
});
test('invalid organization fails before any query',async()=>{await assert.rejects(geo.geocodeMany({orgId:0}),/Invalid organization/);});
