const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function fixture({ compose, defer, pool } = {}) {
  const requests = [];
  const sends = []; // Avisos preparados para la cola; el transporte se prueba con PostgreSQL.
  const notices = load('src/services/order-notices.js', {
    '../db/database': {
      normalizePhone: value => value.replace(/\D/g, ''),
      getEvolutionWhatsappChannel: async () => ({ id: 5, status: 'connected', provider: 'evolution' }),
      upsertConversation: async () => ({ id: 20 }),
      getPool: () => pool || ({ query: async sql => ({ rows: sql.includes('INSERT INTO web_order_notice_wordings') ? [{ wording_hash: 'ok' }] : [] }) }),
      saveMessage: async record => record, updateConversationLastMessage: async () => {},
    },
    './ai-provider': {
      modelFor: () => 'modelo-prueba',
      client: { messages: { create: async request => { requests.push(request); return compose(request); } } },
      responseText: result => result,
    },
    './order-notice-queue': { enqueue: async input => {
      if (defer) await defer(input);
      sends.push(input.text);
      return { queued: true, sent: false, provider: 'evolution', text: input.text, conversationId: input.conversationId };
    } },
  });
  return { notices, requests, sends };
}

test('la IA redacta el cobro y los datos de transferencia y el importe se insertan del registro', async () => {
  const { notices, sends, requests } = fixture({ compose: () => 'NOMBRE, ¿nos ayudas a verificar el pago de PEDIDO por TOTAL?' });
  const { text } = await notices.send(1, { phone: '56911112222', customerName: 'Ana Soto', orderName: '#DR-828' },
    { kind: 'charge', fields: { TOTAL: '$19.000' }, details: 'Cuenta de prueba 123456' });
  assert.deepEqual(sends, ['Ana, ¿nos ayudas a verificar el pago de #DR-828 por $19.000?\nCuenta de prueba 123456']);
  assert.equal(text, sends[0]);
  assert.doesNotMatch(JSON.stringify(requests), /19\.000|123456|828|Ana Soto|56911112222/);
});

test('el resumen de compra generado conserva el horario de envío y el canal Evolution al encolar', async () => {
  const queued = [];
  const { notices, sends } = fixture({ compose: () => 'Registramos tu pedido PEDIDO.', defer: async args => { queued.push(args); return { id: 9 }; } });
  const result = await notices.send(1, { phone: '56911112222', orderName: '#DR-20' }, {kind: 'order_summary', respectSendingHours: true, details: '2 bandejas — $14.000'});
  assert.equal(result.queued, true);
  assert.equal(result.sent, false);
  assert.equal(queued[0].conversationId, 20);
  assert.equal(queued[0].respectSendingHours, true);
  assert.equal(result.provider, 'evolution');
  assert.ok(queued[0].text.endsWith('2 bandejas — $14.000'));
  assert.equal(sends.length, 1);
});

test('ningún identificador de redes sociales se transforma en un número de cliente', async () => {
  const { notices, sends, requests } = fixture();
  await assert.rejects(notices.send(1, { phone: 'instagram:1234567890' }, { kind: 'entregado' }), { code: 'NO_PHONE' });
  assert.equal(sends.length + requests.length, 0);
});

async function noticeDatabase(t) {
  const { PGlite } = require('@electric-sql/pglite');
  const engine = new PGlite();
  t.after(() => engine.close());
  class Pool {
    async connect() { return { query: sql => engine.exec(sql), release() {} }; }
    async end() {}
  }
  await load('src/db/setup.js', { pg: { Pool } }).setupDatabase();
  await engine.exec("INSERT INTO organizations (id, name, slug) VALUES (1, 'Diez Ríos', 'diez-rios')");
  return engine;
}

test('dos compras web simultáneas reservan redacciones distintas incluso con otros nombres y pedidos', async t => {
  const engine = await noticeDatabase(t);
  const original = 'NOMBRE, recibimos tu compra PEDIDO.';
  const revised = '¡Gracias por tu pedido PEDIDO, NOMBRE! Te confirmaremos el despacho.';
  const candidates = [original, '¡NOMBRE! Recibimos tu compra PEDIDO ✅', revised];
  const { notices, sends, requests } = fixture({ pool: engine, compose: () => candidates.shift() || original });
  const send = (phone, customerName, orderName) => notices.send(1, { phone, customerName, orderName },
    { kind: 'web_order', details: 'Total: $14.000' });
  const results = await Promise.all([
    send('56911112222', 'Ana Soto', '#DR-10'),
    send('56933334444', 'Luis Vera', '#DR-11'),
  ]);
  assert.ok(results.every(result => result.queued && !result.sent));
  assert.equal(sends.filter(text => /recibimos tu compra/i.test(text)).length, 1);
  assert.equal(sends.filter(text => /Gracias por tu pedido/.test(text)).length, 1);
  assert.match(requests.at(-1).messages[0].content, /redacciones ya usadas/);
  await assert.rejects(send('56955556666', 'Luz Mora', '#DR-12'), { code: 'AI_NOTICE_INVALID' });
  assert.equal(sends.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /Ana|Luis|Luz|DR-1|14\.000|56911112222/);
});

test('las entregas por transferencia y sus avisos de cobro requieren redacción nueva para cada cliente', async t => {
  const pool = await noticeDatabase(t);
  const cases = [
    ['entregado', 'transferencia', {}, 'NOMBRE, registramos la entrega de PEDIDO.'],
    ['partial', 'mixto', { FECHA: '03-02-2099' }, 'NOMBRE, entregamos parte de PEDIDO. Lo pendiente quedó para FECHA.'],
    ['charge', null, { TOTAL: '$14.000' }, 'NOMBRE, ¿nos ayudas a verificar TOTAL por PEDIDO?'],
    ['voucher', null, { TOTAL: '$14.000' }, 'NOMBRE, ¿tienes el comprobante de PEDIDO por TOTAL?'],
  ];
  for (const [kind, paymentMethod, fields, original] of cases) {
    const candidates = [original, original, 'Gracias por escribirnos. ' + original];
    const { notices, sends, requests } = fixture({ pool, compose: () => candidates.shift() || original });
    const options = { kind, paymentMethod, fields };
    const one = { phone: '56911112222', customerName: 'Ana', orderName: '#DR-10' };
    const two = { phone: '56933334444', customerName: 'Luis', orderName: '#DR-11' };
    await notices.send(1, one, options);
    await notices.send(1, two, { ...options, fields: fields.TOTAL ? { TOTAL: '$18.000' } : fields });
    assert.equal(requests.length, 3, kind);
    assert.match(sends[1], /^Gracias por escribirnos/);
    if (paymentMethod) assert.ok(sends[1].endsWith(paymentMethod === 'mixto'
      ? 'Medio de pago registrado: efectivo y transferencia' : 'Medio de pago registrado: transferencia'));
    if (fields.TOTAL) assert.ok(sends[1].includes('$18.000'));
    await assert.rejects(notices.send(1, one, options), { code: 'AI_NOTICE_INVALID' });
    assert.equal(sends.length, 2);
  }
});

test('el aviso de consolidación descarta la frase reportada y reserva las nuevas redacciones entre clientes', async t => {
  const pool = await noticeDatabase(t);
  const original = 'Hola NOMBRE, el repartidor ya tiene tu PEDIDO. Responde por este chat para coordinar la entrega.';
  const first = 'NOMBRE, nuestro repartidor lleva tu pedido PEDIDO. Puedes escribirnos aquí para coordinar.';
  const next = 'Para coordinar la entrega del pedido PEDIDO, NOMBRE, puedes responder aquí. Ya lo tiene el repartidor.';
  const candidates = [original, first, first, next];
  const { notices, sends } = fixture({ pool, compose: () => candidates.shift() || first });
  const options = { kind: 'delivery_consolidated', trackingUrl: 'https://example.test/seguimiento/prueba' };
  await notices.send(1, { phone: '56911112222', customerName: 'Berta', orderName: '#DR-836' }, options);
  await notices.send(1, { phone: '56933334444', customerName: 'Ana', orderName: '#DR-837' }, options);
  assert.equal(sends.length, 2);
  assert.match(sends[0], /nuestro repartidor lleva tu pedido #DR-836/);
  assert.match(sends[1], /Para coordinar la entrega del pedido #DR-837/);
  assert.ok(sends.every(text => text.endsWith(options.trackingUrl)));
});
