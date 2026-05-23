/**
 * Pipeline de agentes — Orquesta los 3 agentes y gestiona la creación de órdenes
 *
 * Flujo:
 *   1. Orquestador → clasifica la intención del mensaje
 *   2. Agente de Ventas → responde con info de productos, persuade
 *   3. Agente de Órdenes → recopila datos del pedido
 *   4. raigentic API → crea el Draft Order en Shopify + devuelve link de pago
 */

const db          = require('../db/database');
const { getPool } = require('../db/database');
const shopifyApi  = require('./shopify-api');  // Shopify: productos y pedidos (directo)
const orchestrator = require('./agents/orchestrator');
const salesAgent   = require('./agents/sales');
const ordersAgent  = require('./agents/orders');

/**
 * Procesa un mensaje entrante y genera la respuesta adecuada
 * @returns {{ response: string, agentType: string, newState: string }}
 */
async function processMessage(orgId, conversationId, userMessage) {
  const conversation = await db.getConversationById(conversationId);
  const history = await db.getLastMessages(conversationId, 12);
  // Obtener catálogo desde raigentic (DB local, sin llamar a Shopify en cada mensaje)
  const ds = await db.getPrimaryDataSource(orgId);
  const shop = ds?.config?.storeUrl;
  let products = [];
  let productosTexto = '';
  if (ds?.config?.accessToken) {
    try {
      const { shop: s, token } = shopifyApi.credentialsFrom(ds);
      const res = await shopifyApi.getProducts(s, token, { limit: 250 });
      products = res.products || [];
      productosTexto = shopifyApi.formatProductsForAI(products, s);
    } catch (err) {
      console.warn('[Pipeline] No se pudieron cargar productos de Shopify:', err.message);
    }
  }

  const currentState = conversation.pipeline_state || 'exploring';
  let orderDraft = await db.getOrderDraft(conversationId);

  // ── Si estamos en proceso de recopilación de datos ──────────────
  if (currentState === 'collecting_order') {
    return await handleOrderCollection(orgId, conversationId, conversation, userMessage, history, orderDraft, productosTexto);
  }

  // ── Paso 1: Orquestador clasifica la intención ──────────────────
  const { intent, confidence } = await orchestrator.classifyIntent(userMessage, history, currentState);
  console.log(`[Pipeline] Intent: ${intent} (${Math.round(confidence * 100)}%) | State: ${currentState}`);

  // ── Mapeo de intent → acción ─────────────────────────────────────

  // El cliente quiere hablar con humano
  if (intent === 'human_request') {
    await db.setAgentMode(conversationId, 'human');
    await db.updatePipelineState(conversationId, 'exploring');
    return {
      response: '¡Claro! Te voy a conectar con uno de nuestros asesores ahora mismo. En un momento alguien te atiende 👋',
      agentType: 'orchestrator',
      newState: 'exploring',
      switchToHuman: true,
    };
  }

  // Cliente quiere ordenar directamente
  if (intent === 'wants_to_order' || (intent === 'interested' && confidence > 0.85)) {
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto);
    const newState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : 'interested';
    await db.updatePipelineState(conversationId, newState, newState === 'collecting_order' ? {} : undefined);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // Cliente muestra interés o tiene objeción → Agente de ventas
  if (intent === 'interested' || intent === 'objection') {
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto);
    const newState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : 'interested';
    await db.updatePipelineState(conversationId, newState, newState === 'collecting_order' ? {} : undefined);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // Exploración general o soporte → Agente de ventas en modo informativo
  const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto);
  return { response: salesResponse, agentType: 'sales', newState: 'exploring' };
}

/**
 * Busca datos de un cliente por teléfono en dos fuentes:
 * 1. Órdenes previas en la DB local del CRM (bot)
 * 2. Base de clientes de Shopify via raigentic
 *
 * Si se encuentra en Shopify, guarda el customerId para linkear la nueva orden.
 */
async function getKnownCustomerData(orgId, phoneNumber, shop = null) {
  const result = {};

  // ── Fuente 1: órdenes previas del bot ──────────────────────────
  try {
    const { rows } = await getPool().query(
      `SELECT o.customer_name, o.shipping_address
       FROM orders o
       JOIN conversations c ON o.conversation_id = c.id
       WHERE c.phone_number = $1
         AND o.organization_id = $2
         AND o.status NOT IN ('cancelled')
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [phoneNumber, orgId]
    );
    const row = rows[0];
    if (row) {
      const addr = (() => { try { return JSON.parse(row.shipping_address || '{}'); } catch { return {}; } })();
      if (row.customer_name) result.customer_name = row.customer_name;
      if (addr.address)      result.address       = addr.address;
      if (addr.city)         result.city          = addr.city;
    }
  } catch (err) {
    console.warn('[Pipeline] Error buscando en DB local:', err.message);
  }

  // ── Fuente 2: clientes de Shopify vía GraphQL directo ───────────
  if (ds?.config?.accessToken) {
    try {
      const { shop: s, token } = shopifyApi.credentialsFrom(ds);
      const shopifyCustomer = await shopifyApi.getCustomerByPhone(s, token, phoneNumber);
      if (shopifyCustomer) {
        const addr = shopifyCustomer.address;
        if (!result.customer_name && shopifyCustomer.name) {
          result.customer_name = shopifyCustomer.name;
        }
        if (addr) {
          if (!result.address && addr.address1) result.address = addr.address1;
          if (!result.city   && addr.city)      result.city    = addr.city;
        }
        if (shopifyCustomer.email) result.customer_email = shopifyCustomer.email;
        result.shopify_customer_id = shopifyCustomer.id;
        result.found_in_shopify    = true;
        console.log(`[Pipeline] ✅ Cliente en Shopify: ${result.customer_name} (${shopifyCustomer.id})`);
      }
    } catch (err) {
      console.warn('[Pipeline] No se pudo buscar cliente en Shopify:', err.message);
    }
  }

  return result;
}

/**
 * Maneja la recopilación de datos para el pedido
 */
async function handleOrderCollection(orgId, conversationId, conversation, userMessage, history, orderDraft, productosTexto) {
  // 0. Pre-llenar con datos del cliente si ya existe en CRM o en Shopify
  if (Object.keys(orderDraft).length === 0) {
    const ds   = await db.getPrimaryDataSource(orgId);
    const shop = ds?.config?.storeUrl || null;
    const known = await getKnownCustomerData(orgId, conversation.phone_number, shop);
    if (Object.keys(known).length > 0) {
      orderDraft = { ...known };
      const fuente = known.found_in_shopify ? 'Shopify' : 'historial CRM';
      console.log(`[Pipeline] Cliente pre-llenado desde ${fuente}: ${known.customer_name || '?'}`);
    }
  }

  // 1. Extraer datos del mensaje del cliente y actualizar el draft
  const updatedDraft = await ordersAgent.extractOrderData(history, orderDraft);
  await db.updatePipelineState(conversationId, 'collecting_order', updatedDraft);

  // 2. Generar respuesta del agente de órdenes
  const agentResponse = await ordersAgent.generateOrderResponse(history, userMessage, updatedDraft, productosTexto);

  // 3. Verificar si el cliente confirmó
  const confirmed = ordersAgent.isOrderConfirmed(agentResponse, userMessage);

  if (confirmed && ordersAgent.hasRequiredData(updatedDraft)) {
    // ── CREAR ORDEN EN SHOPIFY ─────────────────────────────────
    try {
      const result = await createShopifyOrder(orgId, conversationId, updatedDraft);
      await db.updatePipelineState(conversationId, 'awaiting_payment', updatedDraft);

      const successMsg = `✅ ¡Pedido creado exitosamente!\n\n📦 *${updatedDraft.product_name}* x${updatedDraft.quantity}\n👤 ${updatedDraft.customer_name}\n\n💳 Completa tu pago aquí:\n${result.invoiceUrl}\n\n¡Gracias por tu compra! Te avisaremos cuando tu pedido esté en camino 🚀`;

      return { response: successMsg, agentType: 'orders', newState: 'awaiting_payment', orderCreated: result };
    } catch (err) {
      const status  = err.response?.status;
      const resData = err.response?.data;
      const detail  = resData ? JSON.stringify(resData) : err.message;
      console.error(`[Pipeline] ❌ Error creando orden en Shopify (HTTP ${status || 'N/A'}):`, detail);
      console.error('[Pipeline] Draft que se intentó enviar:', JSON.stringify(updatedDraft));

      let errorMsg = 'Lo siento, hubo un problema al crear tu pedido automáticamente. Un asesor te ayudará a completarlo enseguida.';

      if (status === 401 || detail?.includes('Invalid API key') || detail?.includes('access token')) {
        console.error('[Pipeline] ⚠️  Token de Shopify inválido — la app raigentic necesita reautorizarse. Visita /auth en raigentic.');
      }

      await db.setAgentMode(conversationId, 'human');
      return { response: errorMsg, agentType: 'orders', newState: 'collecting_order', switchToHuman: true };
    }
  }

  // Si la IA dijo ORDEN_CONFIRMADA pero faltan datos, pedirlos amablemente
  if (confirmed && !ordersAgent.hasRequiredData(updatedDraft)) {
    const missing = ['customer_name','product_name','quantity','address','city']
      .filter(f => !updatedDraft[f])
      .map(f => ({ customer_name:'nombre completo', product_name:'producto', quantity:'cantidad', address:'dirección', city:'ciudad' }[f]));
    const missingMsg = `Casi listo 😊 Solo me falta: ${missing.join(', ')}. ¿Me lo puedes confirmar?`;
    return { response: missingMsg, agentType: 'orders', newState: 'collecting_order' };
  }

  // Aún recopilando datos — quitar la palabra clave si apareció en el texto
  const cleanResponse = agentResponse.replace(/ORDEN_CONFIRMADA/g, '').trim();
  return { response: cleanResponse || '¡Entendido! Déjame verificar los datos.', agentType: 'orders', newState: 'collecting_order' };
}

/**
 * Busca el variantId de Shopify por nombre de producto/variante
 */
async function resolveVariantId(ds, productName) {
  try {
    const { shop, token } = shopifyApi.credentialsFrom(ds);
    const res = await shopifyApi.getProducts(shop, token, { limit: 250, search: productName });
    const products = res.products || [];
    const nameLower = (productName || '').toLowerCase();

    for (const p of products) {
      const matchVariant = (p.variants || []).find(v =>
        nameLower.includes(v.title.toLowerCase()) ||
        v.title.toLowerCase().includes(nameLower) ||
        nameLower.includes(p.title.toLowerCase())
      );
      if (matchVariant?.id) return { variantId: matchVariant.id, price: matchVariant.price };

      if (nameLower.includes(p.title.toLowerCase()) && p.variants?.[0]?.id) {
        return { variantId: p.variants[0].id, price: p.variants[0].price };
      }
    }
  } catch (err) {
    console.warn('[Pipeline] No se pudo resolver variantId:', err.message);
  }
  return { variantId: null, price: null };
}

/**
 * Crea la orden en Shopify vía GraphQL directo y la guarda en la DB local
 */
async function createShopifyOrder(orgId, conversationId, draft) {
  const ds = await db.getPrimaryDataSource(orgId);
  if (!ds?.config?.accessToken) throw new Error('No hay tienda Shopify conectada. Reconecta desde Ajustes.');
  const shop = ds.config.storeUrl;

  const conversation = await db.getConversationById(conversationId);
  const customerPhone = draft.customer_phone || conversation.phone_number;

  let variantId = draft.variant_id || null;
  let price = draft.price || null;
  if (!variantId) {
    const resolved = await resolveVariantId(ds, draft.product_name);
    variantId = resolved.variantId;
    price = price || resolved.price;
    if (variantId) console.log(`[Pipeline] variantId resuelto por nombre: ${variantId}`);
  }

  const customer = {
    name:       draft.customer_name,
    phone:      customerPhone,
    email:      draft.customer_email || null,
    customerId: draft.shopify_customer_id || null,  // linkear al cliente existente de Shopify
  };

  if (draft.shopify_customer_id) {
    console.log(`[Pipeline] Linkeando orden al cliente Shopify existente: ${draft.shopify_customer_id}`);
  }

  const { shop: shopDomain, token: shopToken } = shopifyApi.credentialsFrom(ds);
  const shopifyResult = await shopifyApi.createDraftOrder(
    shopDomain,
    shopToken,
    customer,
    [{ variantId, quantity: parseInt(draft.quantity) || 1 }],
    `WhatsApp CRM | Dir: ${draft.address}, ${draft.city} | Conv: ${conversationId}`,
  );

  const order = await db.createOrder({
    conversationId,
    organizationId: orgId,
    items: [{ name: draft.product_name, quantity: draft.quantity }],
    customerName: draft.customer_name,
    customerPhone,
    shippingAddress: { address: draft.address, city: draft.city },
    totalPrice: shopifyResult.totalPrice,
  });

  await db.updateOrder(order.id, {
    shopify_draft_id: shopifyResult.shopifyDraftId,
    invoice_url: shopifyResult.invoiceUrl,
    status: 'sent',
  });

  return shopifyResult;
}

module.exports = { processMessage };
