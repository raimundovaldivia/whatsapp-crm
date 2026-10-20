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
    './campaign-offers-store': { latestForConversation: async () => null, redeem: async () => null },
    './campaign-offers': { toPromotionContext: () => null },
    './payment-collection': { getPendingCharges: async () => options.pendingCharges || [] },
    './payment-promises': options.paymentPromises || {
      isTemporaryPaymentAccessIssue: () => false,
      detectPaymentPromise: () => null,
      recordPaymentPromise: async () => {},
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

  const result = await pipeline.processMessage(1, 71, '¿Alguna posibilidad de traerme huevos hoy? Olvidé pedirlos ayer');

  assert.equal(result.newState, 'collecting_order');
  assert.equal(result.agentType, 'orders');
  assert.match(result.response, /primero te tomo el pedido/i);
  assert.match(result.response, /stock y cupo en la ruta de hoy/i);
  assert.match(result.response, /qué tamaño y cuántos huevos necesitas/i);
  assert.doesNotMatch(result.response, /consulta(rlo)? directamente con el equipo/i);
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

test('una fecha confirmada después de crear el pedido se guarda sin escalar', async () => {
  const rawQueries = [];
  const pipeline = buildPipeline(null, 'draft', {
    deliveryEnabled: true,
    rawQueries,
    history: [{ direction: 'outbound', content: 'Pedido confirmado: 100 huevos Jumbo. Total $37.000.' }],
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje breve' },
  });

  const result = await pipeline.processMessage(1, 71, '¿Ya para el lunes?');

  assert.equal(result.switchToHuman, undefined);
  assert.match(result.response, /qued[oó] registrado para el/i);
  const update = rawQueries.find(item => /UPDATE orders\s+SET delivery_date/iu.test(item.sql));
  assert.ok(update);
  assert.equal(update.params[2], 88);
  assert.equal(update.params[3], 1);
});

test('un bloqueo bancario temporal pide fecha de pago y no escala', async () => {
  const pipeline = buildPipeline(null, 'draft', {
    pendingCharges: [{ source: 'bot', id: '88', order_label: '#DR-88', customer_phone: '56911111111', total_price: 45000 }],
    paymentPromises: {
      isTemporaryPaymentAccessIssue: text => /bloque.*clave/iu.test(text),
      detectPaymentPromise: () => null,
      recordPaymentPromise: async () => {},
    },
    escalation: { escalate: true, urgency: 'medium', reason: 'problema bancario' },
  });

  const result = await pipeline.processMessage(1, 71, 'Se me bloqueó la clave del Banco');

  assert.equal(result.switchToHuman, undefined);
  assert.match(result.response, /qu[eé] d[ií]a podr[aá]s hacer la transferencia/i);
});

test('una promesa de pago con fecha queda registrada sin escalar', async () => {
  let recorded = null;
  const pipeline = buildPipeline(null, 'draft', {
    pendingCharges: [{ source: 'bot', id: '88', order_label: '#DR-88', customer_phone: '56911111111', total_price: 45000 }],
    paymentPromises: {
      isTemporaryPaymentAccessIssue: () => false,
      detectPaymentPromise: () => ({ date: '2026-10-19', label: 'lunes 19 de octubre' }),
      recordPaymentPromise: async (...args) => { recorded = args; },
    },
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje breve' },
  });

  const result = await pipeline.processMessage(1, 71, 'El lunes deposito');

  assert.equal(result.switchToHuman, undefined);
  assert.equal(recorded[0], 1);
  assert.equal(recorded[1].id, '88');
  assert.equal(recorded[2].date, '2026-10-19');
  assert.match(result.response, /No te enviaremos otro cobro antes/i);
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
