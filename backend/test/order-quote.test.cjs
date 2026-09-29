const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfirmedQuote, preserveConfirmedQuote } = require('../src/services/order-quote');

test('conserva el total promocional que el cliente acaba de confirmar', () => {
  const history = [{ direction: 'outbound', content: '📦 40 Jumbo — $16.000\n💰 Total: $16.000\n¿Todo correcto?' }];
  const priced = { items: [{ name: 'Jumbo 20', quantity: 2, price: 10000, subtotal: 20000 }], subtotal: 20000, total: 20000, discountPct: 0, discountAmount: 0 };
  const result = preserveConfirmedQuote(priced, history);
  assert.equal(parseConfirmedQuote(history), 16000);
  assert.equal(result.total, 16000);
  assert.equal(result.items[0].price, 8000);
  assert.equal(result.items[0].subtotal, 16000);
});

test('no redistribuye una cotización ambigua entre varios productos', () => {
  const history = [{ direction: 'outbound', content: 'Total: $16.000\n¿Todo correcto?' }];
  const priced = { items: [{ quantity: 1 }, { quantity: 1 }], total: 20000 };
  assert.equal(preserveConfirmedQuote(priced, history), priced);
});
