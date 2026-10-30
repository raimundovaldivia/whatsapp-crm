const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

function fixture(order = { id: 51, organization_id: 2, status: 'nuevo', payment_status: 'pending' }) {
  const writes = [];
  const router = load('src/routes/orders.js', {
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../db/database': {
      getPool: () => ({ query: async (sql, args) => {
        assert.match(sql, /id = \$1 AND organization_id = \$2/);
        assert.deepEqual(Array.from(args), [51, 2]);
        return { rows: order ? [order] : [] };
      } }),
      updateOrder: async (id, changes, orgId) => {
        writes.push({ id, changes, orgId });
        return Object.assign(order, changes);
      },
    },
  });
  return { writes, call: async (status, id = '51') => {
    const res = response();
    await handler(router, 'patch', '/51/status')({ orgId: 2, params: { id }, body: { status } }, res);
    return res;
  } };
}

test('los botones individuales completan el despacho manual sin confirmar el pago', async () => {
  const f = fixture();
  for (const status of ['por_despachar', 'en_camino', 'entregado']) {
    const result = await f.call(status);
    assert.equal(result.code, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, status);
    assert.equal(result.body.data.payment_status, 'pending');
    assert.equal(f.writes.at(-1).orgId, 2);
  }
  assert.ok(f.writes.at(-1).changes.delivered_at);
  const deliveredAt = f.writes.at(-1).changes.delivered_at;
  await f.call('entregado');
  assert.equal(f.writes.at(-1).changes.delivered_at, deliveredAt, 'repetir no cambia la hora de entrega');
});

test('volver a despacho y los estados anteriores conservan compatibilidad', async () => {
  for (const status of ['nuevo', 'no_entregado', 'draft', 'sent', 'paid', 'cancelled', 'payment_received']) {
    const f = fixture();
    assert.equal((await f.call(status)).code, 200, status);
    assert.equal(f.writes[0].orgId, 2);
  }
});

test('rechaza estados e identificadores inválidos antes de consultar o escribir', async () => {
  for (const [status, id] of [['inventado', '51'], [null, '51'], ['entregado', '51abc'], ['entregado', '0']]) {
    const f = fixture();
    assert.equal((await f.call(status, id)).code, 400);
    assert.equal(f.writes.length, 0);
  }
});

test('un pedido ajeno o inexistente no puede cambiar de estado', async () => {
  const f = fixture(null);
  assert.equal((await f.call('entregado')).code, 404);
  assert.equal(f.writes.length, 0);
});
