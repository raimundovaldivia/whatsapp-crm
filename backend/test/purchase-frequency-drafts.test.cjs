const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const purchases = require('../src/services/broadcast-purchases');
const frequency = require('../src/services/purchase-frequency');
const businessDate = require('../src/services/business-date');
const today = '2026-11-06';

test('list and draft share recent twelve business days, latest products and exclusions', () => {
  const order = (date, extra = {}) => ({ date, phone: '56911111111', status: 'paid', items: [{ title: 'XL', quantity: 2 }], ...extra });
  const orders = [
    ...Array.from({ length: 12 }, (_, i) => order(`2026-10-${String(i + 1).padStart(2, '0')}`)),
    order('2026-01-01'), order('2026-03-01'), order('2026-06-01'),
    order('2026-10-13T02:30:00Z', { items: [{ title: 'Jumbo', quantity: 1 }] }),
    order('2026-11-06', { status: 'refunded' }), order('2026-11-06', { status: 'cancelled' }),
    order('2026-12-01'), order('2026-02-30'),
  ];
  const row = frequency.buildFrequencyCustomers([], orders, today)[0];
  const evidence = purchases.purchaseSummary(orders, today);
  assert.equal(evidence.ultimaCompra, '2026-10-12');
  assert.equal(evidence.intervaloMedianoDias, 1);
  assert.equal(evidence.cantidadPedidos, 16);
  assert.equal(evidence.pedidos[0].productos[0].producto, 'Jumbo');
  assert.equal(evidence.ultimaCompra, row.lastPurchase);
  assert.equal(evidence.intervaloMedianoDias, row.intervalDays);
  assert.equal(evidence.proximaCompraEstimada, row.nextPurchase);
  assert.equal(evidence.estadoFrecuencia, row.status);
  assert.equal(evidence.regularidad, row.regularity);
  assert.deepEqual(evidence.fechasUsadas, row.recentDates);
  assert.equal(evidence.fechasUsadas.length, 12);
  for (const input of [[], [order('2026-11-01')], [order('2026-10-01'), order('2026-10-02'), order('2026-11-01')]]) {
    const summary = purchases.purchaseSummary(input, today);
    assert.equal(summary.regularidad, input.length === 3 ? 'variable' : 'insufficient');
    if (input.length < 2) assert.equal(summary.proximaCompraEstimada, null);
  }
});

test('automatic drafts read tenant purchases per selected customer, recheck exclusions and never queue', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool { query(...args) { return query(...args); } async connect() { return { query, release() {} }; } async end() {} }
  try {
    await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
    await engine.exec("INSERT INTO organizations(id,name,slug) VALUES(1,'A','a'),(2,'B','b')");
    const db = load('src/db/database.js', { pg: { Pool } });
    await db.upsertContact(1, { phone: '56911111111', name: 'Ana' });
    // Bruno has an order but no contact profile. Another organization has the same phone.
    await engine.exec(`
      INSERT INTO orders(organization_id,customer_phone,customer_name,created_at,status,items) VALUES
        (1,'56911111111','Ana','2026-10-16T12:00:00Z','paid','[{"title":"XL","quantity":2}]'),
        (1,'56911111111','Ana','2026-10-23T12:00:00Z','paid','[{"title":"XL","quantity":2}]'),
        (1,'56911111111','Ana','2026-10-30T12:00:00Z','paid','[{"title":"XL","quantity":2}]'),
        (1,'922222222','Bruno','2026-11-02T02:30:00Z','paid','[{"title":"Aceitunas","quantity":1}]'),
        (2,'56911111111','Otra empresa','2026-11-05T12:00:00Z','paid','[{"title":"SECRETO AJENO","quantity":99}]'),
        (2,'56999999999','Solo otra empresa','2026-11-05T12:00:00Z','paid','[]');
    `);
    const prompts = [];
    const drafts = load('src/services/broadcast-drafts.js', {
      '../db/database': { ...db, getProducts: async () => [], getMessagesByCustomerPhone: async () => [] },
      './customer-identity': require('../src/services/customer-identity'),
      './purchase-frequency': frequency,
      './ai-provider': { modelFor: () => 'test' },
      './business-date': { ...businessDate, todayISOChile: date => date ? businessDate.todayISOChile(date) : today },
    });
    const ai = { messages: { create: async request => {
      const data = JSON.parse(request.messages[0].content);
      prompts.push(data);
      assert.match(request.system, /compras.estadoFrecuencia/);
      assert.match(request.system, /no afirmes un ritmo habitual/);
      assert.match(request.system, /La fecha de compra no prueba la entrega/);
      const product = data.cliente.compras.pedidos[0].productos[0].producto;
      return { content: [{ type: 'tool_use', name: 'customer_draft', input: {
        decision: 'draft', reason: 'Compra verificada', message: `Hola ${data.cliente.nombre}, ¿te gustaría volver a pedir ${product}?`,
      } }] };
    } } };
    const body = { instruction: 'Consulta si desea repetir su última compra según su frecuencia.', contextSource: 'purchase_frequency',
      phones: ['56911111111', '56922222222', '56999999999'], organization_id: 2,
      compras: { intervaloMedianoDias: 999, pedidos: [{ productos: [{ producto: 'FALSO' }] }] } };
    const result = await drafts.generateDrafts(1, body, ai);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.drafts.length, 3);
    assert.equal(prompts.length, 2);
    assert.equal(result.drafts[2].reasonCode, 'unavailable');
    assert.match(result.drafts[0].message, /Ana.*XL/);
    assert.match(result.drafts[1].message, /Bruno.*Aceitunas/);
    assert.equal(prompts[0].cliente.compras.intervaloMedianoDias, 7);
    assert.equal(prompts[0].cliente.compras.estadoFrecuencia, 'due');
    assert.equal(prompts[0].cliente.compras.regularidad, 'regular');
    assert.equal(prompts[1].cliente.compras.ultimaCompra, '2026-11-01');
    assert.equal(prompts[1].cliente.compras.intervaloMedianoDias, null);
    assert.equal(prompts[1].cliente.compras.estadoFrecuencia, 'insufficient');
    assert.doesNotMatch(JSON.stringify(prompts), /SECRETO AJENO|FALSO/);
    assert.doesNotMatch(JSON.stringify(prompts[0]), /Bruno|Aceitunas/);
    assert.doesNotMatch(JSON.stringify(prompts[1]), /Ana|XL/);
    const selected = await frequency.getPurchaseFrequency(db.getPool(), 1, today, ['922222222']);
    assert.equal(selected.customers.length, 1);
    assert.equal(selected.customers[0].phone, '56922222222');
    assert.equal((await frequency.getPurchaseFrequency(db.getPool(), 1, today, [])).customers.length, 0);
    // A newly recorded opt-out on a formatted alias must be rechecked before AI.
    await engine.exec("INSERT INTO contacts(organization_id,phone,name,opt_out) VALUES(1,'+56 9 2222 2222','Bruno',true)");
    const blocked = await drafts.generateDrafts(1, { ...body, phones: ['56922222222', '56999999999'] }, ai);
    assert.equal(blocked.drafts[0].reasonCode, 'opt_out');
    assert.equal(blocked.drafts[1].reasonCode, 'unavailable');
    assert.equal(prompts.length, 2);
    await assert.rejects(drafts.generateDrafts(1, { ...body, phones: ['56911111111'] }, { messages: { create: async () => { throw new Error('Mock AI unavailable'); } } }), /Mock AI unavailable/);
    for (const contextSource of ['unknown', {}, null]) {
      assert.throws(() => drafts.validateRequest({ ...body, contextSource }), /Origen/);
    }
    const counts = await engine.query('SELECT (SELECT COUNT(*) FROM broadcast_campaigns) AS campaigns, (SELECT COUNT(*) FROM broadcast_campaign_recipients) AS recipients');
    assert.equal(Number(counts.rows[0].campaigns), 0);
    assert.equal(Number(counts.rows[0].recipients), 0);
  } finally { await engine.close(); }
});
