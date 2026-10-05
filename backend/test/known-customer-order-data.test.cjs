const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('un pedido reutiliza address1 y ciudad del contacto conocido', async () => {
  const db = {
    getContact: async () => ({
      name: 'Cinthya Pantanalli',
      address: null,
      address1: 'Carlos Munizaga 1353',
      city: 'La Serena',
      total_orders: 2,
    }),
  };
  const pipeline = load('src/services/pipeline.js', { '../db/database': db });
  const known = await pipeline._getKnownCustomerData(1, '56911111111');

  assert.equal(known.customer_name, 'Cinthya Pantanalli');
  assert.equal(known.address, 'Carlos Munizaga 1353');
  assert.equal(known.city, 'La Serena');
  assert.equal(known.found_in_contacts, true);
});
