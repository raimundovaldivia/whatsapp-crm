const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function load(file, deps = {}, extra = {}) {
  const module = { exports: {} };
  const context = {
    __dirname: path.dirname(path.join(root, file)), module, exports: module.exports, Buffer, URL, process: { env: { JWT_SECRET: 'test-secret-only-'.repeat(4) } },
    console: { log(){}, warn(){}, error(){} },
    setInterval: () => ({ unref(){} }), clearInterval(){}, setTimeout, clearTimeout,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name];
      if (name === '../services/solution-catalog' || name === './solution-catalog') return load('src/services/solution-catalog.js', deps, extra);
      if (name === '../services/conversation-mode' || name === './conversation-mode') return require(path.join(root, 'src/services/conversation-mode.js'));
      if (name === '../middleware/commercial-access') return load('src/middleware/commercial-access.js', deps, extra);
      if (name === './scheduled-orders') return load('src/services/scheduled-orders.js', { ...deps, '@anthropic-ai/sdk': class { constructor() { this.messages = { create: async () => { throw new Error('AI not mocked'); } }; } } }, extra);
      if (name === './response-guardrail') return load('src/services/response-guardrail.js', deps, extra);
      if (name === './promotion-context') return require(path.join(root, 'src/services/promotion-context.js'));
      if (name === '../utils/payment-breakdown') return require(path.join(root, 'src/utils/payment-breakdown.js'));
      if (['../services/delivery-items','../services/delivery-attempts','./delivery-attempts','../services/merge-conversations','../services/meta-events'].includes(name)) return load('src/services/' + name.split('/').at(-1) + '.js', deps, extra);
      if (name === 'express' || name === 'jsonwebtoken' || name === 'ipaddr.js' || name === 'crypto' || name.startsWith('node:')) return require(name);
      return {};
    }, ...extra,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return module.exports;
}
function handler(router, method, path) {
  const layer = router.stack.find(l => l.route?.methods[method] && l.match(path));
  if (!layer) throw new Error('Route not found: ' + path);
  return layer.route.stack.at(-1).handle;
}
function response() {
  return { code:200, body:null, status(n){this.code=n;return this},json(v){this.body=v;return this},set(){return this},type(){return this},send(v){this.body=v;return this},sendStatus(n){this.code=n;return this},redirect(v){this.location=v;return this} };
}
const noop = (_req,_res,next)=>next();
module.exports = { load, handler, response, noop };
