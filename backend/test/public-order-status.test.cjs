const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

const sample = { storeSlug: 'store-a', phone: '+56 9 1111 1111', orderNumber: '#DR-1' };

test('consulta pública valida entradas antes de consultar y no enlaza teléfonos distintos', async () => {
  const service = load('src/services/public-order-status.js', {
    '../db/database': { getPool() { assert.fail('No debe acceder a DB'); } },
  });
  for (const input of [null, [], {}, { ...sample, phone: 'x56911111111' }, { ...sample, phone: '123' },
    { ...sample, phone: ['56911111111'] }, { ...sample, phone: ' '.repeat(31) + '911111111' }, { ...sample, orderNumber: "1' OR 1=1" },
    { ...sample, orderNumber: 'DR-0' }, { ...sample, orderNumber: 'DR-999999999999' },
    { ...sample, storeSlug: '../store' }, { ...sample, storeSlug: null, hostname: 'evil.com/path' },
    { ...sample, hostname: {} }]) {
    await assert.rejects(service.lookupOrder(input), error => error.status === 400);
  }
  assert.equal(service.validateLookup({ ...sample, phone: '911111111' }).phone, '56911111111');
});

test('pedidos públicos: SQL real, aislamiento, datos mínimos, dominios, estados y fechas Chile', async t => {
  const engine = new PGlite();
  const query = (sql, params) => engine.query(sql, params);
  let allowed = true;
  let trackingToken = null;
  const trackingCalls = [];
  const service = load('src/services/public-order-status.js', {
    '../db/database': { getPool: () => ({ query }) },
    './commercial': { permitted: async (org, feature) => { assert.ok([1, 2].includes(org)); assert.equal(feature, 'storefront'); return allowed; } },
    './delivery-tracking': { createOrderTrackingToken: async (...args) => { trackingCalls.push(args); return trackingToken; } },
  });
  try {
    await engine.exec(`
      CREATE TABLE organizations(id int PRIMARY KEY, name text, slug text);
      CREATE TABLE settings(organization_id int, key text, value text);
      CREATE TABLE orders(id int, organization_id int, customer_phone text, status text,
        delivered_at timestamp, last_attempt_status text, delivery_date date, created_at timestamp,
        customer_name text, shipping_address text);
      CREATE TABLE shopify_orders(id int, organization_id int, shopify_order_id text, shopify_name text,
        customer_phone text, crm_status text, delivered_at timestamp, last_attempt_status text,
        delivery_date date, shopify_created_at timestamp, raw_json jsonb);
      CREATE TABLE delivery_routes(id int, organization_id int, stop_statuses jsonb, created_at timestamptz);
      INSERT INTO organizations VALUES (1,'Tienda A','store-a'),(2,'Tienda B','store-b');
      INSERT INTO settings VALUES (1,'store_public_url','https://shop.example/catalogo'),(2,'store_public_url','https://other.example');
      INSERT INTO orders VALUES
        (1,1,'+56 9 1111 1111','en_camino',NULL,NULL,'2026-10-26','2026-10-26 01:00:00','Privado','Dirección privada'),
        (2,2,'56911111111','entregado','2026-10-25',NULL,'2026-10-25','2026-10-24',NULL,NULL),
        (3,1,'911111111','paid',NULL,NULL,NULL,'2026-10-24',NULL,NULL),
        (4,1,'56922222222','nuevo',NULL,NULL,NULL,'2026-10-24','Privado','Dirección privada');
      INSERT INTO shopify_orders VALUES
        (1,1,'10000','#1050','56911111111','entregado','2026-10-25',NULL,'2026-10-25','2026-10-24','{}'),
        (2,2,'20000','#1050','56922222222','nuevo',NULL,NULL,NULL,'2026-10-24','{}');
      INSERT INTO delivery_routes VALUES (1,1,'{"shopify_10000":"partial"}','2026-10-25'),
        (2,2,'{"shopify_10000":"entregado"}','2026-10-26');
      ALTER TABLE orders ADD COLUMN payment_method text;
      ALTER TABLE shopify_orders ADD COLUMN payment_method text, ADD COLUMN financial_status text;
    `);
    await t.test('solo entrega el estado de la compra que coincide con tienda, teléfono y referencia', async () => {
      const order = await service.lookupOrder(sample);
      assert.deepEqual(JSON.parse(JSON.stringify(order)), {
        storeName: 'Tienda A', orderNumber: '#DR-1', status: 'in_transit', statusLabel: 'En camino',
        orderedDate: '2026-10-25', deliveryDate: '2026-10-26',
        payment: { status: 'pending', statusLabel: 'Pendiente de pago', method: null, methodLabel: 'Medio no registrado' },
        trackingToken: null,
      });
      assert.deepEqual(trackingCalls, [[1, 'bot_1']]);
      for (const change of [{ orderNumber: 'DR-2' }, { storeSlug: 'store-b' }, { phone: '56922222222' },
        { phone: '56933333333', orderNumber: 'DR-4' }, { orderNumber: 'DR-999' }, { storeSlug: 'missing' }]) {
        assert.equal(await service.lookupOrder({ ...sample, ...change }), null);
      }
      assert.equal(trackingCalls.length, 1);
    });
    await t.test('acepta teléfono chileno local, prefijo internacional, paréntesis y referencia BOT antigua', async () => {
      for (const phone of ['911111111','56911111111','+56 (9) 1111-1111']) {
        assert.equal((await service.lookupOrder({ ...sample, phone, orderNumber: '#BOT-1' })).status, 'in_transit');
      }
      assert.equal((await service.lookupOrder({ ...sample, orderNumber: 'DR-3' })).status, 'received');
    });
    await t.test('Shopify y entrega parcial consultan la ruta de la misma empresa', async () => {
      const order = await service.lookupOrder({ ...sample, orderNumber: '#1050' });
      assert.equal(order.orderNumber, '#1050');
      assert.equal(order.status, 'partial');
      assert.equal(await service.lookupOrder({ ...sample, storeSlug: 'store-b', orderNumber: '#1050' }), null);
      await engine.exec(`UPDATE shopify_orders SET raw_json='{"cancelled_at":"2026-10-26"}' WHERE organization_id=1`);
      assert.equal((await service.lookupOrder({ ...sample, orderNumber: '1050' })).status, 'cancelled');
    });
    await t.test('dominio HTTPS por configuración, alias www y rechazo de dominio ambiguo', async () => {
      for (const hostname of ['shop.example','www.shop.example','SHOP.EXAMPLE']) {
        assert.equal((await service.lookupOrder({ ...sample, storeSlug: undefined, hostname })).orderNumber, '#DR-1');
      }
      assert.equal(await service.lookupOrder({ ...sample, storeSlug: undefined, hostname: 'unknown.example' }), null);
      await engine.exec("UPDATE settings SET value='https://www.shop.example/' WHERE organization_id=2");
      assert.equal(await service.lookupOrder({ ...sample, storeSlug: undefined, hostname: 'shop.example' }), null);
      // La ruta explícita de una tienda sigue siendo utilizable en un host compartido.
      assert.equal((await service.lookupOrder(sample)).orderNumber, '#DR-1');
    });
    await t.test('tienda deshabilitada no consulta ni devuelve pedidos', async () => {
      allowed = false;
      assert.equal(await service.lookupOrder(sample), null);
      allowed = true;
    });
    await t.test('acceso al mapa solo para pedido validado en camino o prepagado sin entregar', async () => {
      trackingToken = 'a'.repeat(43);
      assert.equal((await service.lookupOrder(sample)).trackingToken, trackingToken);
      assert.equal((await service.lookupOrder({ ...sample, orderNumber: 'DR-3' })).status, 'in_transit');
      await engine.exec("UPDATE orders SET status='entregado', payment_method='transferencia', delivered_at=NOW() WHERE organization_id=1 AND id=1");
      const delivered = await service.lookupOrder(sample);
      assert.equal(delivered.trackingToken, null);
      assert.equal(delivered.payment.status, 'pending');
      assert.equal(delivered.payment.methodLabel, 'Transferencia');
      await engine.exec("UPDATE shopify_orders SET raw_json='{}', financial_status='PAID', payment_method='otro' WHERE organization_id=1");
      const shopify = await service.lookupOrder({ ...sample, orderNumber: '#1050' });
      assert.equal(shopify.payment.status, 'paid');
      assert.equal(shopify.payment.methodLabel, 'Otro medio');
      assert.equal(shopify.trackingToken, null);
    });
  } finally { await engine.close(); }
});

test('el pago usa estados registrados y medios permitidos, nunca infiere pago de la entrega o del medio', () => {
  const { publicPayment } = load('src/services/public-order-status.js');
  for (const [row, shopify, expected] of [
    [{ status: 'entregado', payment_method: 'efectivo', payment_marked_at: '2026-10-26' }, false, 'pending'],
    [{ status: 'paid', payment_method: 'transferencia' }, false, 'paid'],
    [{ status: 'payment_received' }, false, 'paid'],
    [{ status: 'cancelled' }, false, 'unknown'],
    [{ financial_status: 'PAID' }, true, 'paid'],
    [{ financial_status: 'partially_paid' }, true, 'partially_paid'],
    [{ financial_status: 'refunded' }, true, 'refunded'],
    [{ financial_status: 'partially_refunded' }, true, 'partially_refunded'],
    [{ financial_status: 'voided' }, true, 'voided'],
    [{ financial_status: 'authorized' }, true, 'authorized'],
    [{ financial_status: 'unknown bank account 1234', payment_method: 'private details' }, true, 'unknown'],
  ]) {
    const payment = publicPayment(row, shopify);
    assert.equal(payment.status, expected);
    assert.equal(Object.keys(payment).length, 4);
    assert.equal(JSON.stringify(payment).includes('1234'), false);
  }
  assert.equal(publicPayment({ payment_method: 'mixto' }).methodLabel, 'Efectivo y transferencia');
  assert.equal(publicPayment({ payment_method: 'toString' }).methodLabel, 'Medio no registrado');
});

test('no confunde pago con entrega ni inventa un estado para valores desconocidos', () => {
  const { publicStatus } = load('src/services/public-order-status.js');
  for (const [row, expected] of [[{ status: 'paid' },'received'],[{ status:'payment_received' },'received'],
    [{ status:'por_despachar',last_attempt_status:'reprogramado' },'rescheduled'],
    [{ status:'no_entregado' },'not_delivered'],[{ status:'cancelled',delivered_at:'2026-10-25' },'cancelled'],
    [{ status:'asignado_ruta' },'assigned'],[{ status:'unexpected' },'pending'],
    [{ status:'en_camino',delivered_at:'2026-10-25' },'in_transit'],
    [{ status:'por_despachar',last_attempt_status:'reprogramado',delivered_at:'2026-10-25' },'rescheduled'],
    [{ status:'paid',delivered_at:'2026-10-25' },'delivered']]) {
    assert.equal(publicStatus(row)[0], expected);
  }
});
