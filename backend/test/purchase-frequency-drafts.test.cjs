const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const purchases = require('../src/services/broadcast-purchases');
const frequency = require('../src/services/purchase-frequency');
const businessDate = require('../src/services/business-date');
const today = '2026-11-06';

test('automatic follow-up preserves latest products, units and pack sizes instead of earlier purchases or inferred tastes', () => {
  const drafts = load('src/services/broadcast-drafts.js');
  const evidence = purchases.purchaseSummary([
    { date: '2026-07-27T21:11:00Z', status: 'paid', items: [{ title: 'Huevos XL · Bandeja de 30', quantity: 2 }] },
    { date: '2026-10-05T23:38:00Z', status: 'paid', items: [{ title: 'Huevos Jumbo · Caja de 100', quantity: 1 }] },
    { date: '2026-10-23T19:08:00Z', status: 'paid', items: [{ title: 'Huevos Jumbo · Caja de 100', quantity: 1 }] },
    { date: '2026-10-15T18:25:00Z', status: 'delivered', items: [{ title: 'Aceitunas', quantity: 1 }] },
    { date: '2026-10-27T20:59:00Z', status: 'delivered', items: [{ title: 'Huevos Jumbo mixtos · Bandeja de 20', quantity: 2 }] },
  ], today);
  const result = drafts.frequencyDraft({ phone: '56911111111', name: 'Cliente Ejemplo', context: { compras: evidence,
    conversacionReciente: [{ texto: 'Quiero una caja de 100. Le gustaron las aceitunas.' }] } });
  assert.match(result.message, /Hola Cliente/);
  assert.match(result.message, /2 bandejas de 20 huevos Jumbo mixtos/);
  assert.doesNotMatch(result.message, /[\n•×]|última compra pediste:/);
  assert.doesNotMatch(result.message, /100|40|aceitunas|gustaron|gustó|sirvi|consum|recibi|acab/i);
  assert.equal(result.offers.length, 0);
  assert.equal(result.evidence, evidence);
  assert.equal(result.evidence.pedidos[0].detalleCompleto, true);
});

test('missing or truncated latest purchase details never borrow products or quantities from an older order', () => {
  const drafts = load('src/services/broadcast-drafts.js');
  const invalid = [null, 'invalid json', [], [null], [1], [{ title: 'Jumbo' }], [{ quantity: 2 }],
    ...[0, -2, Infinity, true, [], 'not a number'].map(quantity => [{ title: 'Jumbo', quantity }]),
    [{ title: 'X'.repeat(181), quantity: 2 }], [{ title: 'Jumbo\nMe encantaron', quantity: 2 }],
    Array.from({ length: 13 }, () => ({ title: 'Jumbo', quantity: 1 })),
    Array.from({ length: 12 }, () => ({ title: 'Producto '.repeat(20), quantity: 1 })),
  ];
  for (const items of invalid) {
    const compras = purchases.purchaseSummary([
      { date: '2026-10-27', status: 'paid', items },
      { date: '2026-10-23', status: 'paid', items: [{ title: 'Caja de 100', quantity: 1 }] },
    ], today);
    const result = drafts.frequencyDraft({ phone: '56911111111', name: 'Cliente', context: { compras } });
    assert.equal(result.decision, 'skip');
    assert.equal(result.reasonCode, 'purchase_details');
    assert.equal(result.message, undefined);
  }
});

test('frequency only changes the neutral question; multi-product and decimal units remain exact', () => {
  const drafts = load('src/services/broadcast-drafts.js');
  const compras = purchases.purchaseSummary([{ date: '2026-10-27', status: 'paid', items: JSON.stringify([
    { title: 'Queso 900 g', quantity: '1.5' }, { name: 'Caja de 100', quantity: '2' },
  ]) }], today);
  const cases = [
    ['regular', 'due', 10, /estos días/],
    ['regular', 'overdue', 10, /volver a pedir|otro pedido|nuevo pedido/],
    ['variable', 'overdue', 10, /pedir de nuevo|repetir el pedido|otro pedido|nuevo pedido/],
    ['insufficient', 'due', 10, /pedir de nuevo|repetir el pedido|otro pedido|nuevo pedido/],
    ['regular', 'due', 1, /ayuda|ayudar|más adelante|consultar/],
    ['regular', 'upcoming', 10, /ayuda|ayudar|más adelante|consultar/],
  ];
  for (const [regularidad, estadoFrecuencia, diasDesdeCompra, expected] of cases) {
    const result = drafts.frequencyDraft({ phone: '56911111111', name: 'Cliente', context: { compras: { ...compras, regularidad, estadoFrecuencia, diasDesdeCompra } } });
    assert.match(result.message, /1,5 de Queso 900 g y 2 de Caja de 100/);
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /gustaron|gustó|favorit|consum|acab|recibi|entreg|cada \d|habitual/i);
  }
  const empty = drafts.frequencyDraft({ phone: '56911111111', name: 'Cliente', context: { compras: purchases.purchaseSummary([], today) } });
  assert.equal(empty.decision, 'draft');
  assert.doesNotMatch(empty.message, /última compra|pediste|×/);
  assert.doesNotMatch(empty.message, /último pedido|repetir|otro pedido|de nuevo/);
});

test('conversational drafts vary between customers without changing facts and remain stable across retries', () => {
  const drafts = load('src/services/broadcast-drafts.js');
  const compras = purchases.purchaseSummary([{ date: '2026-10-27', status: 'paid', items: [
    { title: 'Huevos Jumbo mixtos · Bandeja de 20', quantity: 2 },
    { title: 'Huevos XL · Caja de 100', quantity: 1 },
    { title: 'Queso 900 g', quantity: 1.5 },
  ] }], today);
  const customers = Array.from({ length: 12 }, (_, index) => ({ phone: `569111111${String(index).padStart(2, '0')}`, name: 'Cliente', context: { compras } }));
  const messages = new Map(customers.map(customer => [customer.phone, drafts.frequencyDraft(customer).message]));
  assert.ok(new Set(messages.values()).size >= 3, 'customers should not all receive the same wording');
  for (const customer of customers.reverse()) {
    const message = drafts.frequencyDraft(customer).message;
    assert.equal(message, messages.get(customer.phone));
    assert.equal(drafts.frequencyDraft({ ...customer, phone: `+${customer.phone}` }).message, message);
    assert.match(message, /2 bandejas de 20 huevos Jumbo mixtos, 1 caja de 100 huevos XL y 1,5 de Queso 900 g/);
    assert.doesNotMatch(message, /[\n•×]|gustaron|gustó|favorit|consum|acab|recibi|entreg|cada \d|habitual|me acordé/i);
  }
  const uncommon = purchases.purchaseSummary([{ date: '2026-10-27', status: 'paid', items: [
    { title: 'Pack especial 2 por 1', quantity: 2 },
    { title: 'Huevos XL · Bandeja de 20 o 30', quantity: 1 },
  ] }], today);
  const result = drafts.frequencyDraft({ ...customers[0], context: { compras: uncommon } });
  assert.match(result.message, /2 de Pack especial 2 por 1 y 1 de Huevos XL · Bandeja de 20 o 30/);
});

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
    let aiCalls = 0;
    let decline = false;
    const drafts = load('src/services/broadcast-drafts.js', {
      '../db/database': { ...db, getProducts: async () => { throw new Error('Automatic follow-up must not use catalog alternatives'); },
        getMessagesByCustomerPhone: async () => [{ direction: 'inbound', created_at: '2020-01-01T12:00:00Z',
          content: decline ? 'No me escriban más' : 'Quería una caja de 100 y aceitunas. Me encantaron.' }] },
      './customer-identity': require('../src/services/customer-identity'),
      './purchase-frequency': frequency,
      './ai-provider': { modelFor: () => 'test' },
      './business-date': { ...businessDate, todayISOChile: date => date ? businessDate.todayISOChile(date) : today },
    });
    const ai = { messages: { create: async () => { aiCalls++; throw new Error('Automatic follow-up must not invent purchase facts through AI'); } } };
    const body = { instruction: 'Consulta si desea repetir su última compra según su frecuencia.', contextSource: 'purchase_frequency',
      phones: ['56911111111', '56922222222', '56999999999'], organization_id: 2,
      compras: { intervaloMedianoDias: 999, pedidos: [{ productos: [{ producto: 'FALSO' }] }] } };
    const result = await drafts.generateDrafts(1, body, ai);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.drafts.length, 3);
    assert.equal(aiCalls, 0);
    assert.equal(result.drafts[2].reasonCode, 'unavailable');
    assert.match(result.drafts[0].message, /Ana[\s\S]*2 de XL/);
    assert.match(result.drafts[1].message, /Bruno[\s\S]*1 de Aceitunas/);
    assert.equal(result.drafts[0].evidence.intervaloMedianoDias, 7);
    assert.equal(result.drafts[0].evidence.estadoFrecuencia, 'due');
    assert.equal(result.drafts[0].evidence.regularidad, 'regular');
    assert.equal(result.drafts[1].evidence.ultimaCompra, '2026-11-01');
    assert.equal(result.drafts[1].evidence.intervaloMedianoDias, null);
    assert.equal(result.drafts[1].evidence.estadoFrecuencia, 'insufficient');
    assert.doesNotMatch(JSON.stringify(result), /SECRETO AJENO|FALSO|caja de 100|encantaron/);
    assert.doesNotMatch(JSON.stringify(result.drafts[0]), /Bruno|Aceitunas/);
    assert.doesNotMatch(JSON.stringify(result.drafts[1]), /Ana|XL/);
    const selected = await frequency.getPurchaseFrequency(db.getPool(), 1, today, ['922222222']);
    assert.equal(selected.customers.length, 1);
    assert.equal(selected.customers[0].phone, '56922222222');
    assert.equal((await frequency.getPurchaseFrequency(db.getPool(), 1, today, [])).customers.length, 0);
    // A newly recorded opt-out on a formatted alias must be rechecked before AI.
    await engine.exec("INSERT INTO contacts(organization_id,phone,name,opt_out) VALUES(1,'+56 9 2222 2222','Bruno',true)");
    const blocked = await drafts.generateDrafts(1, { ...body, phones: ['56922222222', '56999999999'] }, ai);
    assert.equal(blocked.drafts[0].reasonCode, 'opt_out');
    assert.equal(blocked.drafts[1].reasonCode, 'unavailable');
    assert.equal(aiCalls, 0);
    await engine.exec("INSERT INTO orders(organization_id,customer_phone,status,items,total_price) VALUES(1,'911111111','nuevo','[]',100)");
    const pending = await drafts.generateDrafts(1, { ...body, phones: ['56911111111'] }, ai);
    assert.equal(pending.drafts[0].reasonCode, 'pending_dispatch');
    assert.equal(pending.drafts[0].message, undefined);
    await engine.exec("UPDATE orders SET status='cancelled' WHERE organization_id=1 AND status='nuevo'");
    decline = true;
    const declined = await drafts.generateDrafts(1, { ...body, phones: ['56911111111'] }, ai);
    assert.equal(declined.drafts[0].reasonCode, 'opt_out', 'conversation policy still applies even though it cannot rewrite purchase facts');
    for (const contextSource of ['unknown', {}, null]) {
      assert.throws(() => drafts.validateRequest({ ...body, contextSource }), /Origen/);
    }
    const counts = await engine.query('SELECT (SELECT COUNT(*) FROM broadcast_campaigns) AS campaigns, (SELECT COUNT(*) FROM broadcast_campaign_recipients) AS recipients');
    assert.equal(Number(counts.rows[0].campaigns), 0);
    assert.equal(Number(counts.rows[0].recipients), 0);
  } finally { await engine.close(); }
});
