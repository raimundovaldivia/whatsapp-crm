const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

class FakeAnthropic {
  constructor() { this.messages = { create: async () => ({ content: [{ text: '{}' }] }) }; }
}

const ordersAgent = load('src/services/agents/orders.js', { '@anthropic-ai/sdk': FakeAnthropic });

function buildPipeline(deliveryDate, status = 'draft', options = {}) {
  const stateUpdates = options.stateUpdates || [];
  const poolQuery = async (sql, params) => {
    options.poolQueries?.push({ sql: String(sql), params });
    options.rawQueries?.push({ sql: String(sql), params });
    if (/UPDATE orders\s+SET delivery_date/iu.test(String(sql))) return { rows: [], rowCount: 1 };
    return {
      rows: String(sql).includes('SELECT slug') && options.storeSlug
        ? [{ slug: options.storeSlug }]
        : String(sql).includes("COALESCE(r.started_at") && options.todayRoute
          ? [options.todayRoute]
          : [],
      rowCount: 0,
    };
  };
  const db = {
    getConversationById: async () => ({
      id: 71,
      organization_id: 1,
      phone_number: '56911111111',
      contact_name: 'Katherine',
      pipeline_state: options.pipelineState || 'exploring',
      agent_mode: 'ai',
      ...(options.conversation || {}),
    }),
    getLastMessages: async () => options.history || [],
    getSetting: async (_orgId, key) => {
      if (key === 'delivery_info' && options.deliveryEnabled) {
        return JSON.stringify({
          schedule: options.schedule || 'Lunes a Sábado de 15:00 a 21:00',
          zone: options.deliveryZone || '',
        });
      }
      if (key === 'store_free_shipping') return options.freeShipping || null;
      if (key === 'payment_info') return options.paymentInfo || null;
      if (key === 'charge_settings' && options.bankDetails) {
        return JSON.stringify({ bankDetails: options.bankDetails });
      }
      return null;
    },
    getContact: async () => ({ name: 'Katherine Andrea Bravo Becerra', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => options.products || [],
    getProducts: async () => options.products || [],
    getOrderDraft: async () => options.orderDraft || {},
    getActiveOrderForBot: async () => options.activeOrder === false ? null : ({
      id: 88,
      status,
      delivery_date: deliveryDate,
      customer_name: 'Katherine Andrea Bravo Becerra',
      total_price: 45000,
      items: [{ quantity: 1, name: 'Caja 100 Huevos Jumbo' }],
      shipping_address: { address: 'Gobernador Demetrio Reygada 4005', city: 'Coquimbo' },
      ...(options.activeOrder || {}),
    }),
    updateOrder: async (id, values, orgId) => { options.updatedOrder?.({ id, values, orgId }); return { id, ...values }; },
    updatePipelineState: async (_id, state, draft) => stateUpdates.push({ state, draft }),
    beginSalesClosing: options.beginSalesClosing
      ? async () => options.beginSalesClosing
      : undefined,
    clearSameDayHold: options.clearSameDayHold
      ? async (...args) => options.clearSameDayHold(...args)
      : undefined,
    getPool: () => ({
      query: poolQuery,
      connect: async () => ({ query: poolQuery, release() {} }),
    }),
  };

  return load('src/services/pipeline.js', {
    '../db/database': db,
    './commercial': { consumeBotTurn: async () => {}, permitted: async () => !!options.deliveryEnabled },
    './inbound-message-policy': {
      isLikelyAutomaticReply: () => false,
      isGiftedStockReply: () => false,
      isBareLinkMessage: () => false,
    },
    './shopify-api': { formatProductsForAI: () => '' },
    './order-pricing': require('../src/services/order-pricing'),
    './order-quote': require('../src/services/order-quote'),
    './promotion-context': {
      fromHistory: () => null,
      restore: () => null,
      promptSection: () => '',
      alignPromotedAvailability: text => text,
      selectedOffer: () => null,
      selectedFreeGift: () => null,
      appliesToDelivery: () => false,
    },
    './campaign-offers-store': { activeForConversation: async () => [], redeem: async () => null },
    './campaign-offers': { toPromotionContextMany: () => null },
    './payment-collection': { getPendingCharges: async () => options.pendingCharges || [] },
    './payment-promises': {
      isTemporaryPaymentAccessIssue: message => /bloque[oó].{0,40}(clave|banco)/i.test(message),
      detectPaymentPromise: () => options.paymentPromise || null,
      recordPaymentPromise: async (...args) => { options.promiseRecords?.push(args); },
    },
    './delivery-attempts': {
      recordRouteOutcome: async (...args) => { options.routeOutcomes?.push(args); },
    },
    './scheduled-orders': {
      isFutureOrderIntent: () => false,
      isSoftFutureIntent: () => false,
      extractScheduledOrderData: async () => ({}),
      formatDateEs: value => `fecha ${String(value).slice(0, 10)}`,
    },
    './agents/orchestrator': {
      checkEscalation: async () => options.escalation || ({ escalate: false, urgency: 'low', reason: '' }),
      classifyIntent: async () => ({ intent: options.intent || 'post_sale', confidence: 1, reason: 'consulta de reparto' }),
    },
    './agents/orders': options.ordersAgent || ordersAgent,
  });
}

test('responde el costo de despacho con el umbral exacto y ambas comunas', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    activeOrder: false,
    deliveryEnabled: true,
    deliveryZone: 'La Serena y Coquimbo',
    freeShipping: '10000',
    storeSlug: 'diez-rios-mrs96z69',
  });

  const result = await pipeline.processMessage(1, 71, '¿El despacho es gratis?');

  assert.equal(result.response, 'Sí 😊 El despacho es gratis en compras desde $10.000 en todo La Serena y Coquimbo. Si tu compra es menor a $10.000, el despacho cuesta $1.500.');
  assert.equal(result.agentType, 'sales');
  assert.equal(result.newState, 'exploring');
});

test('un pedido agendado para hoy pero fuera de ruta pide confirmación humana con el estado real', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(today, 'draft');

  const result = await pipeline.processMessage(1, 71, '¿Mi pedido de los huevitos hoy se hará el reparto?');

  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /agendado para hoy/i);
  assert.match(result.response, /todavía figura en preparación/i);
  assert.match(result.response, /aún no aparece en ruta/i);
  assert.match(result.escalationReason, /agendado para hoy/i);
});

test('la fecha real de un pedido futuro se responde aunque logística no esté habilitada', async () => {
  const future = new Date(Date.now() + 4 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(future, 'draft');

  const result = await pipeline.processMessage(1, 71, '¿Cuándo llega mi pedido?');

  assert.equal(result.switchToHuman, false);
  assert.match(result.response, new RegExp(`agendado para el fecha ${future}`, 'i'));
});

test('"cuándo me traen el pedido" consulta el pedido real y no retoma un borrador anterior', async () => {
  const pipeline = buildPipeline(null, 'draft');

  const result = await pipeline.processMessage(1, 71, '¿Cuándo me traen el pedido?');

  assert.equal(result.agentType, 'orchestrator');
  assert.match(result.response, /pedido está en preparación/i);
  assert.doesNotMatch(result.response, /pedido confirmado/i);
});

test('la pregunta exacta de Gloria entra al embudo de estado y no repite la confirmación', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    deliveryEnabled: true,
    schedule: 'Lunes a Sábado de 00:00 a 23:59',
    pipelineState: 'confirmed',
  });

  const result = await pipeline.processMessage(1, 71, 'a qué hora traen mi pedido?');

  assert.equal(result.agentType, 'orchestrator');
  assert.match(result.response, /pedido está en preparación/i);
  assert.match(result.response, /00:00 a 23:59/i);
  assert.doesNotMatch(result.response, /pedido confirmado/i);
  assert.doesNotMatch(result.response, /todo correcto/i);
});

test('por despachar sin ruta informa que todavía no existe hora confirmada', async () => {
  const pipeline = buildPipeline(null, 'por_despachar', {
    deliveryEnabled: true,
    schedule: 'Lunes a Sábado de 00:00 a 23:59',
  });

  const result = await pipeline.processMessage(1, 71, '¿A qué hora llega mi pedido?');

  assert.match(result.response, /listo para despachar/i);
  assert.match(result.response, /todavía no aparece en una ruta/i);
  assert.match(result.response, /no hay una hora de entrega confirmada/i);
  assert.doesNotMatch(result.response, /considerado para el reparto de hoy/i);
});

test('asignado a ruta distingue preparación de salida efectiva', async () => {
  const pipeline = buildPipeline(null, 'asignado_ruta', {
    deliveryEnabled: true,
    schedule: 'Lunes a Sábado de 00:00 a 23:59',
  });

  const result = await pipeline.processMessage(1, 71, '¿Cómo va mi pedido?');

  assert.match(result.response, /asignado a una ruta/i);
  assert.match(result.response, /todavía no figura iniciada/i);
  assert.match(result.response, /no hay una hora exacta confirmada/i);
});

test('no entregado deriva la reprogramación con el estado real', async () => {
  const pipeline = buildPipeline(null, 'no_entregado');

  const result = await pipeline.processMessage(1, 71, '¿Cuándo me traen el pedido?');

  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /último intento de entrega.+no se pudo completar/i);
  assert.match(result.response, /próximo intento/i);
  assert.match(result.escalationReason, /no entregado/i);
});

test('un comprobante de pedido manual cierra también un borrador antiguo ya existente', async () => {
  const stateUpdates = [];
  const pipeline = buildPipeline(null, 'draft', {
    pipelineState: 'collecting_order',
    stateUpdates,
    history: [{ direction: 'outbound', content: '🛒 Pedido #88 generado\n\n• Queso de cabra x1' }],
  });

  const result = await pipeline.processMessage(1, 71, '¿Cuándo me traen el pedido?');

  assert.equal(result.agentType, 'orchestrator');
  assert.match(result.response, /pedido está en preparación/i);
  assert.ok(stateUpdates.some(update => update.state === 'done' && Object.keys(update.draft || {}).length === 0));
});

test('una consulta sobre el reparto usa la ruta real y no cae en una escalación genérica', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    deliveryEnabled: true,
    todayRoute: { id: 19, name: 'Ruta viernes', status: 'completed' },
    escalation: { escalate: true, urgency: 'high', reason: 'posible reclamo' },
  });

  const result = await pipeline.processMessage(1, 71, 'No\n¿Hicieron reparto hoy?');

  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /sí, hoy hubo reparto/i);
  assert.match(result.response, /tu pedido todavía no aparece incluido/i);
  assert.match(result.escalationReason, /Ruta viernes/i);
  assert.doesNotMatch(result.response, /lo siento por la molestia/i);
});

test('una solicitud de entrega para hoy toma el pedido sin prometer un cupo de ruta', async () => {
  const pipeline = buildPipeline(null, 'draft', { activeOrder: false });

  const result = await pipeline.processMessage(
    1, 71, '¿Alguna posibilidad de traerme huevos hoy? Olvidé pedirlos ayer', null,
    { now: new Date('2026-10-14T15:49:00.000Z') }
  );

  assert.equal(result.newState, 'collecting_order');
  assert.equal(result.agentType, 'orders');
  assert.match(result.response, /primero te tomo el pedido/i);
  assert.match(result.response, /stock y cupo en la ruta de hoy/i);
  assert.match(result.response, /qué tamaño y cuántos huevos necesitas/i);
  assert.doesNotMatch(result.response, /consulta(rlo)? directamente con el equipo/i);
});

test('a las 12:50 un pedido nuevo ofrece el próximo despacho y no hoy', async () => {
  const pipeline = buildPipeline(null, 'draft', { activeOrder: false });
  const result = await pipeline.processMessage(
    1, 71, '¿Me lo pueden entregar hoy?', null,
    { now: new Date('2026-10-14T15:50:00.000Z') }
  );
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /próximo día de despacho/i);
  assert.doesNotMatch(result.response, /mantendr[ée] la opción de despacho para hoy/i);
});

test('a las 12:55 conserva hoy si el pedido comenzó a las 12:49', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    activeOrder: false,
    pipelineState: 'collecting_order',
    orderDraft: { items: [{ product_name: 'Huevos XL', quantity: 2 }], customer_name: 'Katherine' },
    conversation: {
      sales_started_at: '2026-10-14T15:49:00.000Z',
      same_day_hold_until: '2026-10-14T16:00:00.000Z',
    },
  });
  const result = await pipeline.processMessage(
    1, 71, '¿Entregan hoy?', null,
    { now: new Date('2026-10-14T15:55:00.000Z') }
  );
  assert.match(result.response, /mantengo la opción de despacho para hoy/i);
  assert.doesNotMatch(result.response, /hora.+cerró/i);
});

test('a las 13:00 un pedido protegido pide confirmación humana sin rechazar el despacho', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    activeOrder: false,
    pipelineState: 'collecting_order',
    orderDraft: { items: [{ product_name: 'Huevos XL', quantity: 2 }], customer_name: 'Katherine' },
    conversation: {
      sales_started_at: '2026-10-14T15:49:00.000Z',
      same_day_hold_until: '2026-10-14T16:00:00.000Z',
    },
  });
  const result = await pipeline.processMessage(
    1, 71, '¿Entregan hoy?', null,
    { now: new Date('2026-10-14T16:00:00.000Z') }
  );
  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /estoy confirmando con el equipo/i);
  assert.doesNotMatch(result.response, /no se podr[aá]|no alcanzará/i);
});

test('un pedido explícitamente para mañana no se cambia a despacho de hoy aunque haya reserva', async () => {
  let draftSeen = null;
  let holdCleared = false;
  const pipeline = buildPipeline(null, 'draft', {
    activeOrder: false,
    pipelineState: 'collecting_order',
    orderDraft: { items: [{ product_name: 'Huevos XL', quantity: 2 }] },
    beginSalesClosing: {
      sales_started_at: '2026-10-14T15:40:00.000Z',
      same_day_hold_until: '2026-10-14T16:00:00.000Z',
    },
    clearSameDayHold: async () => { holdCleared = true; },
    ordersAgent: {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => ({ ...draft, delivery_date: '2026-10-15' }),
      generateOrderResponse: async (_history, _message, draft) => {
        draftSeen = { ...draft };
        return 'Perfecto. ¿Me indicas tu dirección?';
      },
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => false,
      missingFields: () => ['dirección'],
    },
  });

  const result = await pipeline.processMessage(
    1, 71, 'Lo quiero para mañana', null,
    { now: new Date('2026-10-14T15:40:00.000Z') }
  );

  assert.equal(result.newState, 'collecting_order');
  assert.equal(draftSeen.delivery_date, '2026-10-15');
  assert.equal(draftSeen.delivery_requested_today, undefined);
  assert.equal(draftSeen.pending_same_day_review, undefined);
  assert.equal(holdCleared, true);
});

test('durante un pedido responde primero si reparten mañana y luego retoma los datos faltantes', async () => {
  const stateUpdates = [];
  const pipeline = buildPipeline(null, 'draft', {
    activeOrder: false,
    pipelineState: 'collecting_order',
    deliveryEnabled: true,
    stateUpdates,
    orderDraft: {
      customer_name: 'Carolina',
      items: [{ product_name: 'Huevos M mixtos – Bandeja 30', quantity: 1 }],
    },
  });

  const result = await pipeline.processMessage(1, 71, '¿Reparten mañana?\n¿Y hasta qué hora?');

  assert.equal(result.agentType, 'orders');
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /reparto habitual/i);
  assert.match(result.response, /15:00 a 21:00/i);
  assert.match(result.response, /direcci[oó]n/i);
  assert.match(result.response, /ciudad/i);
  assert.doesNotMatch(result.response, /solo me falta/i);
  assert.ok(stateUpdates.at(-1).draft.pending_delivery_date);
});

test('un sí posterior confirma la fecha consultada sin confirmar prematuramente todo el pedido', async () => {
  const stateUpdates = [];
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(null, 'draft', {
    activeOrder: false,
    pipelineState: 'collecting_order',
    deliveryEnabled: true,
    stateUpdates,
    orderDraft: {
      customer_name: 'Carolina',
      items: [{ product_name: 'Huevos M mixtos – Bandeja 30', quantity: 1 }],
      pending_delivery_date: tomorrow,
      pending_delivery_label: 'sábado',
    },
  });

  const result = await pipeline.processMessage(1, 71, 'Sí');

  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, new RegExp(`fecha ${tomorrow}`, 'i'));
  assert.match(result.response, /direcci[oó]n/i);
  assert.match(result.response, /ciudad/i);
  assert.doesNotMatch(result.response, /pedido confirmado/i);
  assert.equal(stateUpdates.at(-1).draft.delivery_date, tomorrow);
  assert.equal(stateUpdates.at(-1).draft.pending_delivery_date, undefined);
});

test('una fecha confirmada después de crear el pedido se persiste sin escalar', async () => {
  const poolQueries = [];
  const routeOutcomes = [];
  const pipeline = buildPipeline(null, 'draft', {
    deliveryEnabled: true,
    schedule: 'Lunes a Sábado de 15:00 a 21:00',
    history: [{ direction: 'outbound', content: 'Pedido #88 confirmado. Total $45.000.' }],
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje ambiguo' },
    poolQueries,
    routeOutcomes,
  });

  const result = await pipeline.processMessage(1, 71, '¿Ya para el lunes?');

  const update = poolQueries.find(entry => /UPDATE orders/.test(entry.sql) && /delivery_date/.test(entry.sql));
  assert.ok(update);
  assert.match(update.params[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(update.params[3], 1);
  assert.equal(routeOutcomes.length, 1);
  assert.equal(result.switchToHuman, undefined);
  assert.match(result.response, /qued[oó] registrado/i);
});

test('una clave bancaria bloqueada pide fecha de pago sin escalar', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    pendingCharges: [{ source: 'bot', id: '88', order_label: '#88', customer_phone: '56911111111', total_price: 45000 }],
    escalation: { escalate: true, urgency: 'medium', reason: 'problema de pago' },
  });

  const result = await pipeline.processMessage(1, 71, 'Se me bloqueó la clave del banco');

  assert.equal(result.switchToHuman, undefined);
  assert.match(result.response, /qué día podrás hacer la transferencia/i);
});

test('una promesa de pago se guarda y suspende nuevos cobros hasta la fecha', async () => {
  const promiseRecords = [];
  const pipeline = buildPipeline(null, 'draft', {
    pendingCharges: [{ source: 'bot', id: '88', order_label: '#88', customer_phone: '56911111111', total_price: 45000 }],
    paymentPromise: { date: '2026-10-19', label: 'lunes, 19 de octubre' },
    promiseRecords,
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje ambiguo' },
  });

  const result = await pipeline.processMessage(1, 71, 'El lunes deposito');

  assert.equal(promiseRecords.length, 1);
  assert.equal(promiseRecords[0][0], 1);
  assert.equal(result.switchToHuman, undefined);
  assert.match(result.response, /no te enviaremos otro cobro antes/i);
});

test('una abreviación pregunta por el pedido activo sin caer en escalación genérica', async () => {
  const future = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(future, 'draft', {
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje ambiguo' },
  });

  const result = await pipeline.processMessage(1, 71, 'Q ise');

  assert.equal(result.switchToHuman, undefined);
  assert.equal(result.agentType, 'orchestrator');
  assert.match(result.response, /pedido #DR-88/i);
  assert.match(result.response, /Caja 100 Huevos Jumbo/i);
  assert.match(result.response, new RegExp(`registrado para el fecha ${future}`, 'i'));
  assert.doesNotMatch(result.response, /equipo/i);
});

test('si el cliente aclara que el pedido futuro era para hoy se pide revisar el cambio con contexto', async () => {
  const future = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(future, 'draft', {
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje ambiguo' },
  });

  const result = await pipeline.processMessage(1, 71, 'Era para hoy\nSupue');

  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /necesitabas el pedido para hoy/i);
  assert.match(result.response, new RegExp(`registrado para el fecha ${future}`, 'i'));
  assert.match(result.response, /confirmar el cupo/i);
  assert.match(result.escalationReason, /pedido #DR-88/i);
  assert.match(result.escalationReason, /cambio de fecha/i);
  assert.doesNotMatch(result.response, /Esto lo tiene que ver alguien/i);
});

test('un cliente con pedido confirmado recibe los datos de transferencia aunque escriba la consulta en dos mensajes', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    pipelineState: 'confirmed',
    paymentInfo: 'Agrícola Valdivia Spa\nBanco Santander\nCuenta Corriente 123456',
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje ambiguo' },
  });

  const result = await pipeline.processMessage(1, 71, 'Te deposito\nMandan link o. Como es');

  assert.equal(result.agentType, 'orchestrator');
  assert.match(result.response, /puedes pagar por transferencia/i);
  assert.match(result.response, /no necesitas un link/i);
  assert.match(result.response, /Banco Santander/);
  assert.match(result.response, /env[ií]ame el comprobante/i);
  assert.equal(result.switchToHuman, undefined);
});

test('si el pedido tiene link de pago responde con ese link y no con datos genéricos', async () => {
  const pipeline = buildPipeline(null, 'sent', {
    pipelineState: 'awaiting_payment',
    paymentInfo: 'Banco Santander\nCuenta 123',
    activeOrder: { invoice_url: 'https://pago.example/pedido-88' },
  });

  const result = await pipeline.processMessage(1, 71, '¿Me mandan un link de pago?');

  assert.match(result.response, /https:\/\/pago\.example\/pedido-88/);
  assert.doesNotMatch(result.response, /Banco Santander/);
});

test('los datos de cobranza respaldan la respuesta si payment_info está vacío', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    pipelineState: 'confirmed',
    bankDetails: 'Agrícola Valdivia Spa\nCuenta Corriente 987654',
  });

  const result = await pipeline.processMessage(1, 71, 'Prefiero pagar por transferencia');

  assert.match(result.response, /Cuenta Corriente 987654/);
  assert.match(result.response, /comprobante/i);
});

test('un pedido por despachar todavía acepta cambios de productos', async () => {
  const stateUpdates = [];
  const pipeline = buildPipeline(null, 'por_despachar', {
    intent: 'modify_order',
    stateUpdates,
    products: [{ id: 'p1', title: 'Queso maduro', priceMin: 12000, inventoryQuantity: 10 }],
    ordersAgent: {
      isCancelDuringCollection: () => false,
      extractOrderData: async (_history, draft) => ({ ...draft, items: [{ product_name: 'Queso maduro', quantity: 1 }] }),
      generateOrderResponse: async () => 'Cambié el producto a queso maduro. ¿Confirmas?',
      claimsRegistered: () => false,
      isOrderConfirmed: () => false,
      hasRequiredData: () => false,
      missingFields: () => [],
    },
  });

  const result = await pipeline.processMessage(1, 71, 'Cambia los huevos por un queso maduro');

  assert.equal(result.switchToHuman, undefined);
  assert.equal(result.newState, 'collecting_order');
  assert.match(result.response, /Cambi[eé] el producto/i);
  assert.equal(stateUpdates.at(-1).draft.editing_order_id, 88);
  assert.equal(stateUpdates.at(-1).draft.items[0].name, 'Queso maduro');
});

test('una orden explícita de no enviar cancela el pedido aunque el supervisor quiera escalar', async () => {
  let updatedOrder = null;
  const stateUpdates = [];
  const pipeline = buildPipeline('2026-10-15', 'draft', {
    stateUpdates,
    escalation: { escalate: true, urgency: 'high', reason: 'posible molestia' },
    intent: 'post_sale',
    updatedOrder: update => { updatedOrder = update; },
  });

  const result = await pipeline.processMessage(1, 71, 'No me envíe la compra, dejó nulo');

  assert.equal(updatedOrder.id, 88);
  assert.equal(updatedOrder.orgId, 1);
  assert.equal(updatedOrder.values.status, 'cancelled');
  assert.equal(Number.isNaN(Date.parse(updatedOrder.values.updated_at)), false);
  assert.equal(stateUpdates.at(-1).state, 'exploring');
  assert.equal(result.newState, 'exploring');
  assert.equal(result.switchToHuman, undefined);
  assert.match(result.response, /cancelé tu pedido/i);
  assert.doesNotMatch(result.response, /equipo|molestia/i);
});

test('una cancelación no modifica automáticamente un pedido que ya salió a reparto', async () => {
  let updatedOrder = null;
  const pipeline = buildPipeline('2026-10-15', 'en_camino', {
    escalation: { escalate: true, urgency: 'high', reason: 'posible molestia' },
    intent: 'post_sale',
    updatedOrder: update => { updatedOrder = update; },
  });

  const result = await pipeline.processMessage(1, 71, 'No me envíe el pedido');

  assert.equal(updatedOrder, null);
  assert.equal(result.switchToHuman, true);
  assert.match(result.response, /ya salió a reparto/i);
  assert.match(result.escalationReason, /pedido #DR-88/i);
});
