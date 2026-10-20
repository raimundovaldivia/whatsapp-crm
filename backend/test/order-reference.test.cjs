const test = require('node:test');
const assert = require('node:assert/strict');
const { crmOrderLabel, normalizeOrderLabel } = require('../src/utils/order-reference');

test('los pedidos creados en el CRM usan el prefijo DR', () => {
  assert.equal(crmOrderLabel(17), '#DR-17');
  assert.equal(normalizeOrderLabel('#BOT-17', 'bot', 17), '#DR-17');
  assert.equal(normalizeOrderLabel('#17', 'bot', 17), '#DR-17');
});

test('los nombres de pedidos Shopify se conservan', () => {
  assert.equal(normalizeOrderLabel('#1042', 'shopify', 1042), '#1042');
  assert.equal(normalizeOrderLabel('#BOT-17', 'shopify', 17), '#DR-17');
});
