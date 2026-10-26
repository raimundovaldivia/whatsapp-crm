const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { load } = require('./helpers.cjs');

test('búsqueda pública: POST, errores genéricos, sin caché ni cookies y límite efectivo por IP', async () => {
  let calls = 0;
  const app = express();
  app.use(express.json());
  app.use('/seguimiento', load('src/routes/delivery-tracking.js', {
    'express-rate-limit': require('express-rate-limit'),
    '../services/public-order-status': { lookupOrder: async input => {
      calls++;
      if (input.phone === 'invalid') throw Object.assign(new Error('privado'), { status: 400 });
      if (input.phone === 'failure') throw new Error('SQL privado');
      return input.phone === 'match' ? { orderNumber: '#DR-1', status: 'received' } : null;
    } },
    '../services/delivery-tracking': { TOKEN_PATTERN: /^[A-Za-z0-9_-]{32,96}$/ },
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/seguimiento/consultar`;
    for (const [phone, status] of [['match',200],['unknown',404],['invalid',400],['failure',503],
      ...Array.from({ length: 6 }, () => ['unknown',404]), ['match',429]]) {
      const res = await fetch(url, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone}) });
      assert.equal(res.status, status);
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal((await res.text()).includes('privado'), false);
    }
    assert.equal(calls, 10);
    assert.equal((await fetch(url)).status,404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
