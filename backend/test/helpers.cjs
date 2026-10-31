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
      if (name === '../db/database') {
        const database = deps[name] || {};
        database.getSetting ||= async () => null;
        return database;
      }
      if (Object.hasOwn(deps, name)) return deps[name];
      if (['./bot-catalog', '../services/bot-catalog', './bot-operating-context', '../services/bot-operating-context', './order-checkout', '../services/order-checkout', '../services/order-pricing'].includes(name)) return require(path.join(root, 'src/services', name.split('/').at(-1)));
      if (name === './outbound-message-queue' || name === '../services/outbound-message-queue') return { deferOutsideHours: async () => null };
      if (name === '../services/solution-catalog' || name === './solution-catalog') return load('src/services/solution-catalog.js', deps, extra);
      if (name === '../services/conversation-mode' || name === './conversation-mode') return require(path.join(root, 'src/services/conversation-mode.js'));
      if (name === '../middleware/commercial-access') return load('src/middleware/commercial-access.js', deps, extra);
      if (name === './scheduled-orders') return load('src/services/scheduled-orders.js', { ...deps, '@anthropic-ai/sdk': class { constructor() { this.messages = { create: async () => { throw new Error('AI not mocked'); } }; } } }, extra);
      if (name === './response-guardrail') return load('src/services/response-guardrail.js', deps, extra);
      if (name === './broadcast-purchases' || name === '../services/broadcast-purchases') return require(path.join(root, 'src/services/broadcast-purchases.js'));
      if (name === './broadcast-send-window') return require(path.join(root, 'src/services/broadcast-send-window.js'));
      if (name === './business-date' || name === '../services/business-date') return require(path.join(root, 'src/services/business-date.js'));
      if (name === './pipeline-outbound') return load('src/services/pipeline-outbound.js', deps, extra);
      if (name === './outbound-text-policy') return require(path.join(root, 'src/services/outbound-text-policy.js'));
      if (name === './outbound-policy') return require(path.join(root, 'src/services/outbound-policy.js'));
      if (name === './inbound-message-policy') return require(path.join(root, 'src/services/inbound-message-policy.js'));
      if (name === './order-creation-policy') return require(path.join(root, 'src/services/order-creation-policy.js'));
      if (name === './order-input-policy' || name === '../order-input-policy') return require(path.join(root, 'src/services/order-input-policy.js'));
      if (name === './delivery-coverage') return require(path.join(root, 'src/services/delivery-coverage.js'));
      if (name === './post-sale-resolution') return require(path.join(root, 'src/services/post-sale-resolution.js'));
      if (name === '../services/dispatch-coverage' || name === './dispatch-coverage') return require(path.join(root, 'src/services/dispatch-coverage.js'));
      if (name === '../services/delivery-geocoding') return require(path.join(root, 'src/services/delivery-geocoding.js'));
      if (name === '../services/conversation-attention') return require(path.join(root, 'src/services/conversation-attention.js'));
      if (name === '../services/lead-qualification') return require(path.join(root, 'src/services/lead-qualification.js'));
      if (name === '../services/sales-closing' || name === './sales-closing') return require(path.join(root, 'src/services/sales-closing.js'));
      if (name === './purchase-feedback') return require(path.join(root, 'src/services/purchase-feedback.js'));
      if (name === './personal-offers') return require(path.join(root, 'src/services/personal-offers.js'));
      if (name === './promotion-context') return require(path.join(root, 'src/services/promotion-context.js'));
      if (name === './ai-provider' || name === '../ai-provider' || name === '../services/ai-provider') {
        const providerDeps = Object.hasOwn(deps, '@anthropic-ai/sdk')
          ? deps
          : {
              ...deps,
              '@anthropic-ai/sdk': class {
                constructor() {
                  this.messages = { create: async () => { throw new Error('AI not mocked'); } };
                }
              },
            };
        const providerExtra = {
          ...extra,
          process: {
            ...(extra.process || {}),
            env: { ANTHROPIC_API_KEY: 'test-key', ...(extra.process?.env || {}) },
          },
        };
        return load('src/services/ai-provider.js', providerDeps, providerExtra);
      }
      if (name === './audio-transcription' || name === '../services/audio-transcription') {
        return load('src/services/audio-transcription.js', deps, extra);
      }
      if (name.endsWith('/xl-welcome-pricing')) return require(path.join(root, 'src/services/xl-welcome-pricing.js'));
      if (name === '../utils/payment-breakdown') return require(path.join(root, 'src/utils/payment-breakdown.js'));
      if (name === '../utils/order-reference') return require(path.join(root, 'src/utils/order-reference.js'));
      if (name === '../order-pricing') return require(path.join(root, 'src/services/order-pricing.js'));
      if (['../services/delivery-items','./delivery-items','../services/delivery-attempts','./delivery-attempts','../services/merge-conversations','../services/meta-events'].includes(name)) return load('src/services/' + name.split('/').at(-1) + '.js', deps, extra);
      if (name === '../services/driver-whatsapp') return { route: async () => null };
      if (name === './order-returns') return load('src/routes/order-returns.js', deps, extra);
      if (name === './conversation-reviews') return require('express').Router();
      if (name === './campaign-offers' || name === '../services/campaign-offers') return require(path.join(root, 'src/services/campaign-offers.js'));
      if (name === './campaign-offers-store' || name === '../services/campaign-offers-store') return {
        latestForConversation: async () => null, activeForConversation: async () => [], createDraft: async () => null, markSent: async () => null,
        redeem: async () => null, releaseOnCancel: async () => null, expireDue: async () => 0,
      };
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

