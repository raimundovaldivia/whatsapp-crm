const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfirmedSummary, parseConfirmedQuote, preserveConfirmedQuote } = require('../src/services/order-quote');

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

test('congela Jumbo y no lo sustituye por XL después de que el cliente confirma', () => {
  const history = [{
    direction: 'outbound',
    content: '¡Listo! Te confirmo el pedido:\n\n📦 1x Promo 60 Jumbo — $23.500\n💰 Total: $23.500\n\n¿Todo correcto?',
  }];
  const priced = {
    items: [{
      product_name: 'PROMO 60 XL', name: 'PROMO 60 XL', title: 'PROMO 60 XL',
      quantity: 1, price: 22000, product_id: 'product-xl', variant_id: 'variant-xl', matched: true,
    }],
    subtotal: 22000, total: 22000, discountPct: 0, discountAmount: 0,
  };

  const summary = parseConfirmedSummary(history);
  const result = preserveConfirmedQuote(priced, history);

  assert.deepEqual(summary, {
    total: 23500,
    items: [{ quantity: 1, name: 'Promo 60 Jumbo', lineTotal: 23500 }],
  });
  assert.equal(result.items[0].product_name, 'Promo 60 Jumbo');
  assert.equal(result.items[0].name, 'Promo 60 Jumbo');
  assert.equal(result.items[0].title, 'Promo 60 Jumbo');
  assert.equal(result.items[0].price, 23500);
  assert.equal(result.items[0].product_id, null);
  assert.equal(result.items[0].variant_id, null);
  assert.equal(result.items[0].locked_quote, true);
  assert.equal(result.total, 23500);
});

test('conserva cada producto y su precio en una confirmación de varios ítems', () => {
  const history = [{
    direction: 'outbound',
    content: '📦 1x Promo 60 Jumbo — $23.500\n📦 2x Bandeja 30 L — $20.000\n💰 Total: $43.500\n¿Todo correcto?',
  }];
  const priced = {
    items: [
      { name: 'PROMO 60 XL', quantity: 1, price: 22000, product_id: 'wrong', matched: true },
      { name: 'Bandeja 30 L', quantity: 2, price: 9000, product_id: 'l', matched: true },
    ],
    subtotal: 40000, total: 40000,
  };

  const result = preserveConfirmedQuote(priced, history);
  assert.deepEqual(result.items.map(item => [item.name, item.quantity, item.price]), [
    ['Promo 60 Jumbo', 1, 23500],
    ['Bandeja 30 L', 2, 10000],
  ]);
  assert.equal(result.total, 43500);
});
