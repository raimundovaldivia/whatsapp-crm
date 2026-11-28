const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load, handler, response } = require('./helpers.cjs');

test('el checkout de Diez Ríos confirma por IA con los datos de la venta y conserva el pedido si falla el aviso', async () => {
  const slug = 'diez-rios-mrs96z69';
  let saved = 0;
  const notices = [];
  const router = load('src/routes/store.js', {
    '../db/database': {
      getPool: () => ({ query: async () => ({ rows: [{ id: 7, slug }] }) }),
      getEvolutionWhatsappChannel: async () => ({ id: 5, status: 'connected' }),
      upsertConversation: async () => ({ id: 9 }),
      createStoreOrder: async () => ({
        order: { id: ++saved }, resolvedItems: [{ title: 'Huevos L', quantity: 2, price: 7000 }],
        deliveryFee: 2000, productsTotal: 14000, total: 16000,
      }),
      upsertContact: async () => {},
    },
    '../services/order-notices': { send: async (...args) => {
      notices.push(args);
      if (notices.length > 1) throw new Error('IA no disponible');
      return { queued: true, sent: false };
    } },
  });
  const checkout = handler(router, 'post', '/' + slug + '/orders');
  const req = { params: { slug }, body: { name: 'Ana', phone: '56911112222',
    address: 'Calle Uno', items: [{ productId: 3, quantity: 2 }] } };
  const ok = response();
  await checkout(req, ok);
  assert.equal(ok.code, 201);
  assert.equal(ok.body.confirmationSent, false);
  assert.equal(ok.body.confirmationQueued, true);
  assert.equal(ok.body.whatsappProvider, 'evolution');
  const [org, recipient, notice] = notices[0];
  assert.equal(org, 7);
  assert.equal(recipient.orderName, '#DR-1');
  assert.equal(notice.kind, 'web_order');
  assert.equal(notice.details, '  • Huevos L x2 — $14.000\nEntrega: Calle Uno\nDespacho: $2.000\nTotal: $16.000\nPago: contra entrega');
  const pending = response();
  await checkout(req, pending);
  assert.equal(pending.code, 201);
  assert.equal(saved, 2);
  assert.equal(pending.body.confirmationSent, false);
});

test('store orders calculate server-side, aggregate quantities and update stock atomically', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }

  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec(`
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Diez Ríos', 'diez-rios');
      INSERT INTO conversations (id, organization_id, phone_number) VALUES (1, 1, '56911111111');
      INSERT INTO products (id, organization_id, title, price, stock, active, is_business)
      VALUES (10, 1, 'Huevos XL', 5000, 5, TRUE, FALSE);
    `);
    const db = load('src/db/database.js', { pg: { Pool } });

    const result = await db.createStoreOrder({
      conversationId: 1,
      organizationId: 1,
      items: [{ productId: 10, quantity: 1 }, { productId: 10, quantity: 2 }],
      customerName: 'Cliente prueba',
      customerPhone: '56911111111',
      shippingAddress: { address: 'Dirección prueba', city: 'La Serena', address2: 'Depto. 24', addressDescription: 'Tocar el timbre azul' },
    });

    const stored = (await engine.query('SELECT shipping_address FROM orders WHERE id = $1', [result.order.id])).rows[0];
    assert.deepEqual(JSON.parse(stored.shipping_address), { address: 'Dirección prueba', city: 'La Serena', address2: 'Depto. 24', addressDescription: 'Tocar el timbre azul' });
    await db.upsertContact(1, { phone: '56911111111', address: 'Dirección prueba', city: 'La Serena', address2: 'Depto. 24', addressDescription: 'Tocar el timbre azul' });
    await db.upsertContact(1, { phone: '56911111111', name: 'Cliente' });
    const contact = await db.getContact(1, '56911111111');
    assert.equal(contact.address2, 'Depto. 24');
    assert.equal(contact.address_description, 'Tocar el timbre azul');
    assert.equal(result.total, 15000);
    assert.equal(result.resolvedItems.length, 1);
    assert.equal(result.resolvedItems[0].quantity, 3);
    assert.equal((await engine.query('SELECT stock FROM products WHERE id = 10')).rows[0].stock, 2);
    assert.equal((await engine.query('SELECT COUNT(*)::int AS count FROM orders')).rows[0].count, 1);

    await engine.exec(`UPDATE organizations SET slug='diez-rios-mrs96z69' WHERE id=1;
      INSERT INTO products(id,organization_id,title,price,stock,active,is_business)
      VALUES(11,1,'Huevos XL Bandeja 30 unidades',12000,20,TRUE,FALSE)`);
    const purchase = { conversationId:1, organizationId:1, items:[{productId:11,quantity:2}],
      customerName:'Nuevo',customerPhone:'56922222222',shippingAddress:{address:'Prueba',city:'Coquimbo'} };
    await assert.rejects(()=>db.createStoreOrder({...purchase,expectedTotal:24000}), error=>error.code==='PRICE_CHANGED');
    assert.equal((await engine.query('SELECT stock FROM products WHERE id=11')).rows[0].stock,20);
    const welcome = await db.createStoreOrder({...purchase,expectedTotal:22000});
    assert.equal(welcome.total,22000);
    const repeat = await db.createStoreOrder({...purchase,customerPhone:'+56 9 2222 2222',expectedTotal:22000});
    assert.equal(repeat.total,22000);
    const existing = await db.createStoreOrder({...purchase,customerPhone:'56911111111',expectedTotal:22000});
    assert.equal(existing.total,22000);
    assert.equal((await engine.query('SELECT total_price FROM orders WHERE id=$1',[welcome.order.id])).rows[0].total_price,'22000');

    await assert.rejects(
      () => db.createStoreOrder({
        conversationId: 1,
        organizationId: 1,
        items: [{ productId: 10, quantity: 3 }],
        customerName: 'Cliente prueba',
        customerPhone: '56911111111',
        shippingAddress: { address: 'Dirección prueba', city: 'La Serena' },
      }),
      error => error.code === 'INSUFFICIENT_STOCK' && error.status === 409
    );
    assert.equal((await engine.query('SELECT stock FROM products WHERE id = 10')).rows[0].stock, 2);
    assert.equal((await engine.query('SELECT COUNT(*)::int AS count FROM orders')).rows[0].count, 4);
  } finally {
    await engine.close();
  }
});
