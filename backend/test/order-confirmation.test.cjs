const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');
const policy = require('../src/services/order-input-policy');
const agent = load('src/services/agents/orders.js', { '../ai-provider': {} });
const draft = () => ({
  customer_name: 'Cliente de prueba', address: 'Calle de prueba 123', city: 'La Serena',
  delivery_date: '2099-01-01',
  items: [{ product_name: 'Huevos XL cafés · Bandeja de 30', quantity: 1 }],
});

for (const channel of ['instagram', 'facebook', 'whatsapp']) {
  test(`${channel}: confirmar y reiterar indicaciones revisadas crea una sola orden sin derivar`, async () => {
    const history = [];
    const notes = 'PRUEBA INTERNA, NO PREPARAR, NO COBRAR NI DESPACHAR. Pago en efectivo al recibir.';
    const f = fixture({ channel, history, draft: { ...draft(), customer_phone: '56911111111', notes },
      extract: (previous, count) => count === 1 ? previous : { ...previous, notes: '', customer_name: 'Nombre antiguo' } });
    const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
    history.push({ direction: 'outbound', content: review.response });
    const result = await f.pipeline.processMessage(7, 91, 'Sí, todo correcto. Confirmo este pedido de prueba. No preparar, cobrar ni despachar.');
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.extractions, 1);
    assert.ok(f.calls.orders[0].note.includes(notes));
    assert.equal(f.calls.orders[0].customerName, 'Cliente de prueba');
    assert.equal(result.switchToHuman, undefined);
    assert.equal(result.newState, 'confirmed');
    assert.match(result.response, /DR-812/);
  });
}

test('reiterar indicaciones conserva revisión enviada, precio, stock y bloqueo de duplicados', async () => {
  for (const scenario of ['reviewNotSent', 'priceChanged', 'outOfStock', 'duplicate', 'failSave']) {
    const history = [];
    const products = [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: 20 }];
    const f = fixture({ history, products, duplicate: scenario === 'duplicate', failSave: scenario === 'failSave',
      draft: { ...draft(), notes: 'No tocar el timbre.' } });
    const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
    if (scenario !== 'reviewNotSent') history.push({ direction: 'outbound', content: review.response });
    if (scenario === 'priceChanged') products[0].price = 14990;
    if (scenario === 'outOfStock') products[0].stock = 0;
    const result = await f.pipeline.processMessage(7, 91, 'Confirmo el pedido. No tocar el timbre.');
    assert.equal(f.calls.orders.length, 0, scenario);
    assert.doesNotMatch(result.response || '', /¡Pedido confirmado!/, scenario);
  }
});

test('una indicación nueva junto a la confirmación se revisa antes de crear el pedido', async () => {
  const history = [];
  const f = fixture({ history, draft: { ...draft(), notes: 'No tocar el timbre.' },
    extract: (previous, count) => count === 1 ? previous : { ...previous, notes: 'Llamar antes de llegar.' } });
  const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
  history.push({ direction: 'outbound', content: review.response });
  const result = await f.pipeline.processMessage(7, 91, 'Confirmo el pedido. Llamar antes de llegar.');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(f.calls.extractions, 2);
  assert.match(result.response, /Llamar antes de llegar/);
  assert.equal(result.switchToHuman, undefined);
});

for (const message of ['Todo bien', 'Esta correcto', 'Sí correcto', 'Si correcto\nGracias',
  'Sí, necesito me lo envíen\nPor favor', 'Está todo correcto', 'Dale perfecto']) {
  test(`confirmación habitual cierra el resumen enviado sin reinterpretarlo: ${message}`, async () => {
    const history = [];
    const f = fixture({ history, extract: (previous, count) => count === 1 ? previous : {
      ...previous, items: [{ ...previous.items[0], quantity: 3 }],
    } });
    const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
    history.push({ direction: 'outbound', content: review.response });
    const result = await f.pipeline.processMessage(7, 91, message);
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.extractions, 1);
    assert.equal(f.calls.orders[0].items[0].quantity, 1);
    assert.equal(f.calls.orders[0].organizationId, 7);
    assert.match(result.response, /DR-812/);
  });
}

test('las nuevas afirmaciones no aceptan condiciones, preguntas ni cambios', () => {
  for (const message of ['Todo bien pero cambia a dos', 'Está correcto?', 'Si correcto pero no lo envíes',
    'Sí necesito que lo envíen mañana', 'Si esta dirección', 'Si necesito que llegue hoy',
    'Todo bien si llega mañana', 'Gracias', 'Por favor']) {
    assert.equal(agent.isOrderConfirmed('ORDEN_CONFIRMADA', message, draft()), false, message);
  }
});

for (const message of ['Me han enviado 6 veces el mismo mensaje', 'Respondo y me vuelven a enviar lo mismo']) {
  test(`reclamo por repetición conserva borrador y deriva sin otro resumen: ${message}`, async () => {
    const f = fixture();
    const result = await f.pipeline.processMessage(7, 91, message);
    assert.equal(f.calls.orders.length, 0);
    assert.equal(f.calls.extractions, 0);
    assert.equal(result.switchToHuman, true);
    assert.doesNotMatch(result.response, /Revisa el resumen|¿Todo correcto/);
  });
}

test('pregunta de pago se responde sin repetir y permite una sola confirmación posterior', async () => {
  const history = [];
  const f = fixture({ history, settings: { payment_info: 'Banco de prueba: cuenta ficticia' },
    extract: (previous, count) => count === 1 ? previous : { ...previous, address: 'Otra calle 456' } });
  const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
  history.push({ direction: 'outbound', content: review.response });
  const reply = await f.pipeline.processMessage(7, 91, 'Puedo transferir?');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(f.calls.extractions, 1);
  assert.match(reply.response, /transferencia/i);
  assert.doesNotMatch(reply.response, /Revisa el resumen|📦/);
  history.push({ direction: 'outbound', content: reply.response });
  const result = await f.pipeline.processMessage(7, 91, 'Todo bien');
  assert.equal(f.calls.orders.length, 1);
  assert.match(result.response, /DR-812/);
});

test('una respuesta ambigua no repite el resumen ni crea una orden; insistir deriva', async () => {
  const history = [];
  const f = fixture({ history });
  const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
  history.push({ direction: 'outbound', content: review.response });
  const reminder = await f.pipeline.processMessage(7, 91, 'Gracias');
  assert.equal(f.calls.orders.length, 0);
  assert.doesNotMatch(reminder.response, /Revisa el resumen|📦/);
  history.push({ direction: 'outbound', content: reminder.response });
  const result = await f.pipeline.processMessage(7, 91, 'No entiendo');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.switchToHuman, true);
  assert.doesNotMatch(result.response, /Revisa el resumen|📦/);
});

test('acepta confirmaciones completas sin limitar la longitud', () => {
  for (const message of ['Siiii , por supuesto los espero', 'Si por supuesto, acá estoy',
    'Sí, todo correcto, muchas gracias', 'Dale, por favor, los espero', '👍🏽', 'ok', 'correcto', 'Sí, confirmo el pedido', 'Confirmo el resumen',
    'Sí, todo correcto. Confirmo el pedido de prueba.']) {
    assert.equal(agent.isOrderConfirmed('¿Todo correcto?', message, draft()), true, message);
    assert.equal(agent.isOrderConfirmed('¿Todo correcto?', message, { items: [] }), false, message);
  }
});

test('una pregunta, condición, negativa o modificación no confirma por un prefijo', () => {
  for (const message of ['si cambio la dirección', 'simplemente estoy consultando', '¿Sí?',
    'Sí, pero cambia a dos bandejas', 'Ok, no lo envíes', 'Si llegan mañana confirmo',
    'No confirmo', 'Sí, los espero pero no hoy', 'Listo, cancelen el pedido', 'por supuesto que no', 'No hice la transferencia', '¿Ya pagué?', 'Ya pagué pero cancela',
    'Sí, confirmo el pedido de prueba pero cambia a dos', 'Confirmo el pedido de prueba si llega mañana']) {
    assert.equal(agent.isOrderConfirmed('¿Todo correcto?', message, draft()), false, message);
  }
});

test('las confirmaciones largas tampoco permiten inventar productos nuevos', () => {
  const previous = draft();
  const next = { ...previous, items: [...previous.items, { product_name: 'Queso de cabra', quantity: 1 }] };
  assert.equal(policy.unexpectedItemsFromBareAffirmative('Siiii , por supuesto los espero', previous, next).length, 1);
});

function fixture(options = {}) {
  const calls = { orders: [], states: [], claims: 0, extractions: 0 };
  let current = options.draft || draft();
  const db = {
    getConversationById: async () => ({ id: 91, organization_id: 7, phone_number: options.channel ? null : '56911111111', source_channel: options.channel || 'whatsapp', pipeline_state: options.state || 'collecting_order', agent_mode: 'ai' }),
    getLastMessages: async () => options.history || [{ direction: 'outbound', content: '📦 1x Huevos XL cafés · Bandeja de 30 — $12.990\n💰 Total: $12.990\n¿Todo correcto?' }],
    getSetting: async (_org, key) => options.settings?.[key] ?? (key === 'catalog_source' ? 'local' : null),
    getContact: async () => null,
    getPrimaryDataSource: async () => null,
    getProducts: async () => options.products || [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: 20, active: true }],
    getCachedProducts: async () => [],
    getOrderDraft: async () => current,
    getActiveOrderForBot: async () => typeof options.activeOrder === 'function' ? options.activeOrder() : (options.activeOrder || null),
    updatePipelineState: async (...args) => { calls.states.push(args); if (args[2] !== undefined) current = args[2]; },
    setAgentMode: async () => {},
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
    claimOrderCreation: async (_id, claimOptions) => { calls.claimOptions = claimOptions; calls.claims++; return !options.duplicate; },
    createOrder: async value => {
      if (options.failSave) throw new Error('Simulated database failure');
      calls.orders.push(value); return { id: 812 };
    },
    updateOrder: async () => {},
    upsertContact: async () => {},
    promoteToCustomer: async () => {},
  };
  const pipeline = load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => !!options.deliveryEnabled },
    './inbound-message-policy': { isLikelyAutomaticReply: () => false, isGiftedStockReply: () => false, isBareLinkMessage: () => false },
    './shopify-api': { formatProductsForAI: () => '' },
    './agents/orchestrator': { checkEscalation: async () => ({ escalate: false }), classifyIntent: async () => ({ intent: 'wants_to_order', confidence: 1 }) },
    './agents/orders': {
      ...agent,
      extractOrderData: async (_history, previous) => {
        calls.extractions++;
        return options.extract ? options.extract(previous, calls.extractions) : previous;
      },
      generateOrderResponse: async () => options.response || '¿Todo correcto?',
    },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './promotion-context': require('../src/services/promotion-context'),
    './xl-welcome-pricing': options.webPricing
      ? { ...require('../src/services/xl-welcome-pricing'), context: async () => require('../src/services/xl-welcome-pricing').forStore({ enabled: true }) }
      : { context: async () => ({ enabled: false, eligible: false }), forStore: value => value, prompt: () => '', applyQuote: value => value },
    './scheduled-orders': { isFutureOrderIntent: () => false, isSoftFutureIntent: () => false, extractScheduledOrderData: async () => ({}), formatDateEs: value => value },
  });
  return { pipeline, calls };
}

for (const channel of ['facebook', 'instagram', 'whatsapp']) {
  test(`${channel}: el nombre actual gana al historial desde la primera compra y confirma una sola vez`, async () => {
    const history = [{ direction: 'outbound', content: 'Pedido anterior confirmado para Cliente anterior' }];
    const options = { channel, state: 'confirmed', history,
      draft: { ...draft(), customer_name: 'Cliente anterior', customer_phone: '56911111111' },
      extract: previous => ({ ...previous, ...draft(), customer_phone: '56911111111', customer_name: 'Cliente anterior' }),
    };
    const f = fixture(options);
    const review = await f.pipeline.processMessage(7, 91,
      'Hola, quiero comprar 1 bandeja de 30 huevos XL cafés. Es una prueba interna a nombre de PRUEBA NOMBRE INSTAGRAM, sin cobro ni despacho.');
    assert.match(review.response, /PRUEBA NOMBRE INSTAGRAM/);
    assert.doesNotMatch(review.response, /Cliente anterior/);
    assert.equal(f.calls.orders.length, 0);
    history.push({ direction: 'outbound', content: review.response });
    options.state = 'collecting_order';
    const confirmation = await f.pipeline.processMessage(7, 91, 'Sí, todo correcto. Confirmo el pedido de prueba.');
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.orders[0].customerName, 'PRUEBA NOMBRE INSTAGRAM');
    assert.equal(f.calls.orders[0].organizationId, 7);
    assert.equal(f.calls.orders[0].conversationId, 91);
    assert.equal(f.calls.extractions, 1);
    assert.match(confirmation.response, /PRUEBA NOMBRE INSTAGRAM/);
    assert.equal(confirmation.newState, 'confirmed');
  });

  test(`${channel}: la compra inicial con una nota de reparto conserva los productos y continúa sin repetirla`, async () => {
    const history = [];
    const options = { channel, state: 'exploring', deliveryEnabled: true, webPricing: true, draft: {}, history,
      response: '¿Me indicas tu nombre, dirección y teléfono?',
      extract: previous => ({ ...previous, items: draft().items, notes: 'PRUEBA INTERNA, NO COBRAR NI DESPACHAR' }),
    };
    const f = fixture(options);
    const first = await f.pipeline.processMessage(7, 91, 'Hola, quiero comprar 1 bandeja de 30 huevos XL cafés. Es una prueba interna, sin cobro ni despacho.');
    assert.equal(first.agentType, 'orders');
    assert.equal(first.newState, 'collecting_order');
    assert.equal(f.calls.extractions, 1);
    assert.equal(f.calls.orders.length, 0);
    assert.doesNotMatch(first.response, /despacho es gratis/);
    assert.equal(f.calls.states.at(-1)[2].items[0].quantity, 1);
    history.push({ direction: 'outbound', content: first.response });
    options.state = 'collecting_order';
    options.extract = previous => ({ ...previous, customer_name: 'Prueba', address: 'Plaza de prueba s/n, La Serena', city: 'La Serena', customer_phone: '56911111111' });
    const review = await f.pipeline.processMessage(7, 91, 'Nombre Prueba. Dirección Plaza de prueba s/n, La Serena. Teléfono 56911111111. Sin cobro ni despacho.');
    assert.match(review.response, /antes de crear tu pedido/);
    assert.equal(f.calls.orders.length, 0);
    assert.equal((review.response.match(/La Serena/g) || []).length, 1);
    history.push({ direction: 'outbound', content: review.response });
    const confirmation = await f.pipeline.processMessage(7, 91, 'Sí, todo correcto. Confirmo el pedido de prueba.');
    assert.equal(confirmation.newState, 'confirmed');
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.orders[0].organizationId, 7);
    assert.match(confirmation.response, /DR-812/);
  });
}

test('una consulta de tarifa junto a una compra no descarta el pedido; sola conserva el borrador', async () => {
  const f = fixture({ state: 'exploring', draft: {}, history: [], deliveryEnabled: true, webPricing: true,
    extract: previous => ({ ...previous, items: draft().items }), response: '¿Me indicas tu nombre?',
  });
  const result = await f.pipeline.processMessage(7, 91, 'Quiero 1 bandeja XL cafés de 30. ¿El despacho es gratis?');
  assert.equal(result.agentType, 'orders');
  assert.equal(result.newState, 'collecting_order');
  assert.equal(f.calls.extractions, 1);
  assert.equal(f.calls.orders.length, 0);

  const existing = { ...draft(), notes: 'Entregar en conserjería' };
  const inquiry = fixture({ draft: existing, deliveryEnabled: true, webPricing: true });
  const answer = await inquiry.pipeline.processMessage(7, 91, '¿Cuánto cuesta el envío?');
  assert.match(answer.response, /despacho es gratis/);
  assert.equal(answer.newState, 'collecting_order');
  assert.deepEqual(inquiry.calls.states.at(-1)[2], existing);
  assert.equal(inquiry.calls.extractions, 0);
  assert.equal(inquiry.calls.orders.length, 0);
});

test('aportar la dirección no restaura el nombre anterior extraído del historial', async () => {
  const history = [];
  const f = fixture({ channel: 'instagram', history,
    draft: { ...draft(), address: '', customer_name: 'Cliente Nuevo', customer_phone: '56911111111' },
    extract: previous => ({ ...previous, address: 'Calle Nueva 456', customer_name: 'Cliente anterior' }),
  });
  const review = await f.pipeline.processMessage(7, 91, 'Mi dirección es Calle Nueva 456, La Serena. Pago en efectivo.');
  assert.match(review.response, /Cliente Nuevo/);
  assert.doesNotMatch(review.response, /Cliente anterior/);
  assert.equal(f.calls.orders.length, 0);
  history.push({ direction: 'outbound', content: review.response });
  await f.pipeline.processMessage(7, 91, 'Sí, todo correcto. Confirmo el pedido de prueba.');
  assert.equal(f.calls.orders.length, 1);
  assert.equal(f.calls.orders[0].customerName, 'Cliente Nuevo');
});

for (const message of ['Siiii , por supuesto los espero', 'Si por supuesto, acá estoy']) {
  test(`el pipeline guarda la orden antes de confirmar: ${message}`, async () => {
    const f = fixture();
    const result = await f.pipeline.processMessage(7, 91, message);
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.orders[0].organizationId, 7);
    assert.equal(f.calls.orders[0].conversationId, 91);
    assert.equal(f.calls.orders[0].totalPrice, 12990);
    assert.equal(result.orderCreated.orderId, 812);
    assert.equal(result.newState, 'confirmed');
    assert.match(result.response, /pedido confirmado/i);
  });
}

test('una frase del bot no crea una orden sin la confirmación del cliente', async () => {
  const f = fixture({ history: [], response: 'Te confirmo el pedido: te llegan mañana.' });
  const result = await f.pipeline.processMessage(7, 91, 'Bandeja café');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /antes de crear tu pedido/i);
  assert.doesNotMatch(result.response, /te confirmo el pedido|te llegan/i);
});

test('sin instrucciones de transferencia no inventa medios de pago ni repite el resumen', async () => {
  const f = fixture();
  const result = await f.pipeline.processMessage(7, 91, 'Puedo transferir?');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.switchToHuman, true);
  assert.doesNotMatch(result.response, /Revisa el resumen|puedes pagar por transferencia/i);
});

test('insistir en la consulta de pago deriva en vez de repetir la aclaración', async () => {
  const history = [];
  const f = fixture({ history, settings: { charge_settings: JSON.stringify({ bankDetails: 'Cuenta ficticia' }) } });
  const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
  history.push({ direction: 'outbound', content: review.response });
  const payment = await f.pipeline.processMessage(7, 91, 'Puedo transferir?');
  history.push({ direction: 'outbound', content: payment.response });
  const result = await f.pipeline.processMessage(7, 91, 'Puedo transferir?');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.switchToHuman, true);
  assert.notEqual(result.response, payment.response);
});

test('pago con una corrección sigue extrayendo y exige revisar el cambio', async () => {
  const history = [];
  const f = fixture({ history, settings: { payment_info: 'Cuenta ficticia' },
    extract: (previous, count) => count === 1 ? previous : { ...previous, address: 'Otra calle 456' } });
  const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
  history.push({ direction: 'outbound', content: review.response });
  const result = await f.pipeline.processMessage(7, 91, 'Puedo transferir? Cambia la dirección a Otra calle 456');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(f.calls.extractions, 2);
  assert.match(result.response, /Otra calle 456/);
  assert.match(result.response, /Revisa el resumen/);
});

test('otra aprobación después del cierre no duplica el pedido', async () => {
  const options = {};
  const f = fixture(options);
  await f.pipeline.processMessage(7, 91, 'Todo bien');
  options.activeOrder = active();
  await f.pipeline.processMessage(7, 91, 'Sí correcto');
  assert.equal(f.calls.orders.length, 1);
  assert.equal(f.calls.claims, 1);
});

test('las nuevas afirmaciones conservan el bloqueo atómico y el fallo de persistencia', async () => {
  const duplicate = fixture({ duplicate: true });
  const blocked = await duplicate.pipeline.processMessage(7, 91, 'Esta correcto');
  assert.equal(duplicate.calls.orders.length, 0);
  assert.equal(blocked.duplicate, true);
  const failed = fixture({ failSave: true });
  const result = await failed.pipeline.processMessage(7, 91, 'Todo bien');
  assert.equal(failed.calls.orders.length, 0);
  assert.equal(result.switchToHuman, true);
  assert.doesNotMatch(result.response, /pedido confirmado/i);
});

test('si guardar falla no se confirma ni se promete entrega', async () => {
  const f = fixture({ failSave: true });
  const result = await f.pipeline.processMessage(7, 91, 'Si por supuesto, acá estoy');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.orderCreated, undefined);
  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /problema técnico al registrar/i);
  assert.doesNotMatch(result.response, /pedido confirmado|te llegan|en camino/i);
});

test('se conserva el bloqueo de duplicados al reconocer una confirmación larga', async () => {
  const f = fixture({ duplicate: true });
  const result = await f.pipeline.processMessage(7, 91, 'Siiii , por supuesto los espero');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.duplicate, true);
  assert.equal(result.response, null);
});

test('un producto ambiguo sigue requiriendo aclaración antes de guardar', async () => {
  const f = fixture({ history: [], draft: { ...draft(), items: [{ product_name: 'Producto inexistente', quantity: 1 }] } });
  const result = await f.pipeline.processMessage(7, 91, 'Siiii , por supuesto los espero');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /confirmar un producto/i);
});


const active = () => ({ id: 450, status: 'draft', customer_name: 'Cliente de prueba',
  created_at: new Date(Date.now() - 5 * 3600000).toISOString(),
  items: [{ name: 'Huevos XL cafés · Bandeja de 30', quantity: 1, price: 12990 }],
  total_price: 12990, shipping_address: { address: 'Calle de prueba 123', city: 'La Serena' } });

test('la señal ORDEN_CONFIRMADA nunca autoriza una consulta ni una preferencia de entrega', () => {
  for (const message of ['Porfi no venga tarde', 'Son de gallinas libres?', '¿Cuándo llega?', 'No confirmo']) {
    assert.equal(agent.isOrderConfirmed('ORDEN_CONFIRMADA', message, draft()), false, message);
  }
});

test('un borrador antiguo no crea otro pedido ante un sí sin intención de otra compra', async () => {
  const f = fixture({ activeOrder: active(), response: 'ORDEN_CONFIRMADA' });
  const result = await f.pipeline.processMessage(7, 91, 'Sí');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(f.calls.claims, 0);
  assert.match(result.response, /pedido.*DR-450.*registrado/i);
});

test('permite otro pedido explícito, conserva autorización entre turnos y lo confirma con el cliente', async () => {
  const f = fixture({ activeOrder: active() });
  const review = await f.pipeline.processMessage(7, 91, 'Quiero hacer otro pedido aparte igual');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(review.newState, 'collecting_order');
  const result = await f.pipeline.processMessage(7, 91, 'Sí, todo correcto');
  assert.equal(f.calls.orders.length, 1);
  assert.equal(result.orderCreated.orderId, 812);
  assert.equal(f.calls.claimOptions.orgId, 7);
  assert.equal(f.calls.claimOptions.additionalOrderId, 450);
});

test('vuelve a comprobar pedidos antes de guardar si otro proceso registró uno durante el turno', async () => {
  let reads = 0;
  const f = fixture({ activeOrder: () => ++reads < 3 ? null : active() });
  const result = await f.pipeline.processMessage(7, 91, 'Sí, todo correcto');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(f.calls.claims, 0);
  assert.match(result.response, /evitar duplicarlo/i);
});

test('un resumen antiguo no habilita productos retirados del catálogo', async () => {
  const f = fixture({ products: [], response: 'ORDEN_CONFIRMADA' });
  const result = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
  assert.equal(f.calls.orders.length, 0);
  assert.match(result.response, /catálogo actual/);
  assert.doesNotMatch(result.response, /Déjame verificar/);
});

test('no confirma una compra antes de mostrar su resumen y luego sí permite cerrarla', async () => {
  const history = [];
  const f = fixture({ history });
  const first = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
  assert.equal(f.calls.orders.length, 0);
  assert.match(first.response, /antes de crear/);
  history.push({ direction: 'outbound', content: first.response });
  const second = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
  assert.equal(f.calls.orders.length, 1);
  assert.match(second.response, /DR-812/);
});

test('precio cambiado y stock insuficiente nunca cierran contra un resumen anterior', async () => {
  for (const product of [{ price: 14990, stock: 20 }, { price: 12990, stock: 0 }, { price: 0, stock: 20 }]) {
    const f = fixture({ products: [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', ...product }] });
    const result = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
    assert.equal(f.calls.orders.length, 0);
    assert.ok(result.response);
    assert.notEqual(result.newState, 'confirmed');
  }
});

test('ventas pausadas impiden crear pedidos aunque el bot siga atendiendo', async () => {
  const f = fixture({ settings: { bot_sales_enabled: 'false' } });
  const result = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
  assert.equal(f.calls.orders.length, 0);
  assert.match(result.response, /pendientes de habilitación/);
});

test('el interruptor global también detiene las llamadas directas al pipeline', async () => {
  const f = fixture({ settings: { ai_enabled_global: 'false' } });
  const result = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(result.reason, 'AI_DISABLED');
});

test('la comuna o una zona de cobertura no sustituyen la dirección de entrega', () => {
  for (const address of ['La Serena', 'La Serena urbana', 'Radio urbano La Serena', 'pendiente', '  ']) {
    const value = { ...draft(), address };
    assert.equal(agent.hasRequiredData(value), false, address);
    assert.ok(agent.missingFields(value).includes('dirección'));
  }
  assert.equal(agent.hasRequiredData({ ...draft(), address: 'Parcela 12, sector Altovalsol' }), true);
});

test('se conserva el stock sin límite que admite el catálogo, sin confundirlo con agotado', async () => {
  const f = fixture({ products: [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: -1 }] });
  const result = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
  assert.equal(f.calls.orders.length, 1);
  assert.equal(result.newState, 'confirmed');
});

for (const channel of ['instagram', 'facebook']) {
  test(`${channel}: una sola confirmación conserva el resumen y guarda la ciudad una vez`, async () => {
    const history = [];
    const f = fixture({ channel, history, draft: {
      ...draft(), address: 'Plaza de Armas s/n, La Serena, La Serena',
      requires_customer_phone: true, customer_phone: '56911111111',
      notes: 'PRUEBA INTERNA, NO COBRAR NI DESPACHAR',
    }, extract: (previous, count) => count === 1 ? previous : {
      ...previous, address: 'Dirección inventada 999', notes: 'Otra nota',
      items: [{ ...previous.items[0], quantity: 2 }],
    } });
    const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
    assert.equal(f.calls.orders.length, 0);
    assert.equal((review.response.match(/La Serena/g) || []).length, 1);
    history.push({ direction: 'outbound', content: review.response });
    const confirmed = await f.pipeline.processMessage(7, 91, 'Sí, todo correcto. Confirmo el pedido de prueba.');
    assert.equal(f.calls.orders.length, 1);
    assert.equal(f.calls.extractions, 1, 'confirmar no reinterpreta el resumen revisado');
    assert.equal(f.calls.orders[0].shippingAddress.address, 'Plaza de Armas s/n');
    assert.equal(f.calls.orders[0].shippingAddress.city, 'La Serena');
    assert.equal(f.calls.orders[0].items[0].quantity, 1);
    assert.equal((confirmed.response.match(/La Serena/g) || []).length, 1);
    assert.match(confirmed.response, /DR-812/);
  });
}

test('una modificación junto al sí requiere revisar la nueva dirección antes de guardar', async () => {
  const history = [];
  const f = fixture({ history, extract: (previous, count) => count === 1 ? previous : {
    ...previous, address: 'Otra calle 456, La Serena',
  } });
  const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
  history.push({ direction: 'outbound', content: review.response });
  const changed = await f.pipeline.processMessage(7, 91, 'Sí, pero cambia la dirección a Otra calle 456');
  assert.equal(f.calls.orders.length, 0);
  assert.equal(f.calls.extractions, 2);
  assert.match(changed.response, /Otra calle 456, La Serena/);
  assert.match(changed.response, /todavía no está creado/);
});

test('confirmar un resumen guardado sigue comprobando el precio y el stock vigentes', async () => {
  for (const change of [{ price: 14990 }, { stock: 0 }]) {
    const history = [];
    const products = [{ id: 7, title: 'Huevos XL cafés · Bandeja de 30', price: 12990, stock: 20 }];
    const f = fixture({ history, products });
    const review = await f.pipeline.processMessage(7, 91, 'Estos son mis datos');
    history.push({ direction: 'outbound', content: review.response });
    Object.assign(products[0], change);
    const result = await f.pipeline.processMessage(7, 91, 'Sí, confirmo el pedido');
    assert.equal(f.calls.orders.length, 0);
    assert.notEqual(result.newState, 'confirmed');
  }
});
