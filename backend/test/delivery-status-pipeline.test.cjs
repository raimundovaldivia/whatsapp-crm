const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

function buildPipeline(deliveryDate, status = 'draft', options = {}) {
  const stateUpdates = options.stateUpdates || [];
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
        return JSON.stringify({ schedule: options.schedule || 'Lunes a Sábado de 15:00 a 21:00' });
      }
      if (key === 'payment_info') return options.paymentInfo || null;
      if (key === 'charge_settings' && options.bankDetails) {
        return JSON.stringify({ bankDetails: options.bankDetails });
      }
      return null;
    },
    getContact: async () => ({ name: 'Katherine Andrea Bravo Becerra', contact_type: 'customer', client_type: 'personal' }),
    getPrimaryDataSource: async () => null,
    getCachedProducts: async () => [],
    getProducts: async () => [],
    getOrderDraft: async () => ({}),
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
    updatePipelineState: async (_id, state, draft) => stateUpdates.push({ state, draft }),
    getPool: () => ({
      query: async sql => ({
        rows: String(sql).includes("COALESCE(r.started_at") && options.todayRoute
          ? [options.todayRoute]
          : [],
        rowCount: 0,
      }),
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
    './promotion-context': {
      fromHistory: () => null,
      restore: () => null,
      promptSection: () => '',
      alignPromotedAvailability: text => text,
      selectedOffer: () => null,
    },
    './payment-collection': { getPendingCharges: async () => [] },
    './scheduled-orders': {
      isFutureOrderIntent: () => false,
      isSoftFutureIntent: () => false,
      extractScheduledOrderData: async () => ({}),
      formatDateEs: value => `fecha ${String(value).slice(0, 10)}`,
    },
    './agents/orchestrator': {
      checkEscalation: async () => options.escalation || ({ escalate: false, urgency: 'low', reason: '' }),
      classifyIntent: async () => ({ intent: 'post_sale', confidence: 1, reason: 'consulta de reparto' }),
    },
  });
}

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

test('una abreviación pregunta por el pedido activo sin caer en escalación genérica', async () => {
  const future = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const pipeline = buildPipeline(future, 'draft', {
    escalation: { escalate: true, urgency: 'medium', reason: 'mensaje ambiguo' },
  });

  const result = await pipeline.processMessage(1, 71, 'Q ise');

  assert.equal(result.switchToHuman, undefined);
  assert.equal(result.agentType, 'orchestrator');
  assert.match(result.response, /pedido #88/i);
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
  assert.match(result.escalationReason, /pedido #88/i);
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
