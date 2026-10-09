const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../mobile/src/utils/routeMap.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.replace(/export /g, ''), context);
const run = expression => vm.runInContext(expression, context);

test('map rejects absent, empty, malformed and out-of-range coordinates instead of showing 0,0', () => {
  for (const stop of [{}, {lat:null,lng:null}, {lat:'',lng:' '}, {lat:false,lng:true},
    {lat:0,lng:0}, {lat:-29.9,lng:null}, {lat:91,lng:-71}, {lat:-29,lng:181}, {lat:'NaN',lng:-71}]) {
    assert.equal(run(`stopCoordinates(${JSON.stringify(stop)})`), null);
  }
  assert.equal(run('JSON.stringify(stopCoordinates({lat:"-29.9",lng:"-71.25"}))'), '{"lat":-29.9,"lng":-71.25}');
  assert.notEqual(run('stopCoordinates({lat:0,lng:30})'), null);
});

test('map and external navigation use the same destination; address is only a fallback', () => {
  assert.equal(run('navigationDestination({lat:-29.9,lng:-71.25,fullAddress:"Another city"})'), '-29.9,-71.25');
  assert.equal(run('navigationDestination({lat:null,lng:null,fullAddress:" Av. Miramar 5324, Coquimbo "})'), 'Av. Miramar 5324, Coquimbo');
  assert.equal(run('navigationUrl({})'), null);
  const url = new URL(run('navigationUrl({lat:-29.9,lng:-71.25})'));
  assert.equal(url.searchParams.get('destination'), '-29.9,-71.25');
  assert.equal(url.searchParams.get('travelmode'), 'driving');
});

test('saved stop order is preserved and labels are consistent after a manual reorder', () => {
  assert.equal(run('JSON.stringify(routeStops({orders:[{id:1}],optimized_route:[{id:2,stopNumber:9},{id:1,stopNumber:4}]}))'),
    '[{"id":2,"stopNumber":1},{"id":1,"stopNumber":2}]');
  assert.equal(run('JSON.stringify(routeStops({orders:[{id:3}]}))'), '[{"id":3,"stopNumber":1}]');
});

test('map generated script excludes null locations and centers valid pins without inventing a road path', () => {
  const screen = fs.readFileSync(path.resolve(__dirname, '../../mobile/src/screens/RouteMapScreen.js'), 'utf8');
  const htmlFactory = screen.slice(screen.indexOf('function mapHtml('), screen.indexOf('export default function'));
  const markers = [], bounds = [];
  context.stopLabel = n => String(n);
  vm.runInContext(htmlFactory, context);
  const html = run('mapHtml([{id:1,source:"bot",lat:null,lng:null},{id:2,source:"bot",lat:-29.9,lng:-71.2,customerName:"</script>"}],{},"numbers")');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  assert.equal(html.includes('"name":"</script>"'), false);
  const map = { invalidateSize() {}, fitBounds: points => bounds.push(points) };
  vm.runInNewContext(script, { window:{addEventListener(){}}, L:{
    map: () => map, tileLayer: () => ({addTo(){}}), divIcon: options => options,
    marker: point => { markers.push(point); return {addTo(){return {bindPopup(){}}}}; },
    polyline: () => assert.fail('Straight lines must not be presented as road routing'),
  }});
  assert.equal(markers.length, 1); assert.equal(markers[0][0], -29.9); assert.equal(bounds.length, 1);
});
