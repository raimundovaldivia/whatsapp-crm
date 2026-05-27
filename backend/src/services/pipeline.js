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

  // Contexto de la tienda + info de entrega estructurada + instrucciones adicionales
  const storeContext  = await db.getSetting(orgId, 'store_context') || '';
  const extraPrompt   = await db.getSetting(orgId, 'ai_system_prompt_extra') || '';
  const deliveryRaw   = await db.getSetting(orgId, 'delivery_info');
  let deliverySection = '';
  if (deliveryRaw) {
    try {
      const d = JSON.parse(deliveryRaw);
      const lines = [];
      if (d.schedule)       lines.push(`📅 Horarios de entrega: ${d.schedule}`);
      if (d.zone)           lines.push(`📍 Zona de reparto: ${d.zone}`);
      if (d.minimum)        lines.push(`💰 Pedido mínimo: ${d.minimum}`);
      if (d.paymentMethods) lines.push(`💳 Métodos de pago: ${d.paymentMethods}`);
      if (lines.length) deliverySection = `## Información de Entrega\n${lines.join('\n')}`;
    } catch { /* JSON inválido — ignorar */ }
  }
  const storeCustomPrompt = [deliverySection, storeContext, extraPrompt].filter(Boolean).join('\n\n---\n\n');

  // ── Detectar respuesta a template de re-engagement ─────────────────
  // Si el último estado era 'template_sent', el cliente acaba de responder
  // a uno de nuestros templates → lead caliente, ir directo a venta
  const isTemplateReply = currentState === 'template_sent';
  let templateName = '';
  if (isTemplateReply) {
    // Extraer nombre del template del último mensaje outbound
    const lastOutbound = history.filter(m => m.direction === 'outbound').pop();
    const match = lastOutbound?.content?.match(/\[Template:\s*([^\]]+)\]/);
    templateName = match?.[1] || '';
    // Resetear estado para que la conversación continúe normalmente
    await db.updatePipelineState(conversationId, 'interested');
    console.log(`[Pipeline] 🔥 Template reply detectado (${templateName}) — modo warm lead`);
  }

  // ── Agente de escalación — corre en paralelo con la clasificación ──
  const effectiveState = isTemplateReply ? 'interested' : currentState;
  const [escalationResult, intentResult] = await Promise.all([
    orchestrator.checkEscalation(userMessage, history, effectiveState, orgId),
    (currentState === 'collecting_order')
      ? Promise.resolve(null)
      : orchestrator.classifyIntent(userMessage, history, effectiveState),
  ]);

  // Si el agente de escalación detecta que se necesita humano
  if (escalationResult.escalate) {
    console.log(`[Pipeline] 🚨 Escalación detectada (${escalationResult.urgency}): ${escalationResult.reason}`);
    await db.setAgentMode(conversationId, 'human');
    await db.setLastEscalation(conversationId, userMessage, escalationResult.reason);
    await db.updatePipelineState(conversationId, currentState); // mantiene el estado actual

    const escalationMessages = {
      high: '⚠️ Entiendo tu situación. Voy a conectarte ahora mismo con un asesor para que te ayude personalmente. ¡Ya te atienden! 👋',
      medium: 'Quiero asegurarme de que recibas la mejor atención. Te voy a conectar con uno de nuestros asesores. En un momento alguien te escribe 😊',
      low: 'Para darte una mejor atención, voy a pasarte con un asesor que podrá ayudarte con esto. ¡Un momento! 👋',
    };

    return {
      response: escalationMessages[escalationResult.urgency] || escalationMessages.low,
      agentType: 'orchestrator',
      newState: currentState,
      switchToHuman: true,
      escalationReason: escalationResult.reason,
    };
  }

  // ── Si estamos en proceso de recopilación de datos ──────────────
  if (currentState === 'collecting_order') {
    return await handleOrderCollection(orgId, conversationId, conversation, userMessage, history, orderDraft, productosTexto);
  }

  // ── Paso 1: Orquestador clasifica la intención ──────────────────
  const { intent, confidence } = intentResult || { intent: 'interested', confidence: 0.9 };
  console.log(`[Pipeline] Intent: ${intent} (${Math.round(confidence * 100)}%) | State: ${effectiveState}${isTemplateReply ? ' 🔥 WARM LEAD' : ''}`);

  const salesOpts = { isWarmLead: isTemplateReply, templateName };

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

  // Lead caliente (respuesta a template) o cliente quiere ordenar → Agente de ventas en modo warm
  if (isTemplateReply || intent === 'wants_to_order' || (intent === 'interested' && confidence > 0.85)) {
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
    const newState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : 'interested';
    await db.updatePipelineState(conversationId, newState, newState === 'collecting_order' ? {} : undefined);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // Cliente muestra interés o tiene objeción → Agente de ventas
  if (intent === 'interested' || intent === 'objection') {
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
    const newState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : 'interested';
    await db.updatePipelineState(conversationId, newState, newState === 'collecting_order' ? {} : undefined);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // Exploración general o soporte → Agente de ventas en modo informativo
  const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
  return { response: salesResponse, agentType: 'sales', newState: 'exploring' };
}

/**
 * Busca datos de un cliente por teléfono en dos fuentes:
 * 1. Órdenes previas en la DB local del CRM (bot)
 * 2. Base de clientes de Shopify via raigentic
 *
 * Si se encuentra en Shopify, guarda el customerId para linkear la nueva orden.
 */
async function getKnownCustomerData(orgId, phoneNumber, ds = null) {
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
    const known = await getKnownCustomerData(orgId, conversation.phone_number, ds);
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

      // Construir mensaje de error con resumen del pedido para que el cliente sepa que recibimos su info
      const productInfo = updatedDraft.product_name
        ? `📦 *${updatedDraft.product_name}* x${updatedDraft.quantity || 1}\n📍 ${updatedDraft.address || ''}, ${updatedDraft.city || ''}`
        : '';

      const errorMsg = productInfo
        ? `Recibí todos tus datos 📝${productInfo ? '\n\n' + productInfo : ''}\n\nHubo un problema técnico al generar tu link de pago 😔 Un asesor te lo enviará manualmente en unos minutos. ¡Gracias por tu paciencia!`
        : 'Recibí tu pedido pero hubo un problema técnico al generarlo 😔 Un asesor te ayudará a completarlo en breve. ¡Gracias!';

      if (status === 401 || detail?.includes('Invalid API key') || detail?.includes('access token')) {
        console.error('[Pipeline] ⚠️  Token de Shopify inválido — reconecta Shopify desde Ajustes del CRM.');
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
    const nameLower = (productName || '').toLowerCase().trim();

    // Búsqueda 1: con el nombre completo
    const res = await shopifyApi.getProducts(shop, token, { limit: 250, search: productName });
    const allProducts = res.products || [];

    // Buscar primero por coincidencia exacta de título
    for (const p of allProducts) {
      const titleLower = p.title.toLowerCase();
      // Coincidencia exacta o contenida
      if (titleLower === nameLower || nameLower.includes(titleLower) || titleLower.includes(nameLower)) {
        // Buscar variante que coincida
        const matchVariant = (p.variants || []).find(v => {
          const vLow = v.title.toLowerCase();
          return vLow !== 'default title' && (nameLower.includes(vLow) || vLow.includes(nameLower));
        });
        if (matchVariant?.id) {
          console.log(`[Pipeline] variantId resuelto (variante exacta): ${matchVariant.id}`);
          return { variantId: matchVariant.id, price: matchVariant.price };
        }
        // Usar la primera variante disponible del producto
        const firstVariant = p.variants?.find(v => v.available !== false) || p.variants?.[0];
        if (firstVariant?.id) {
          console.log(`[Pipeline] variantId resuelto (primera variante): ${firstVariant.id} del producto "${p.title}"`);
          return { variantId: firstVariant.id, price: firstVariant.price };
        }
      }
    }

    // Búsqueda 2: con palabras clave del nombre (tomar primeras 2-3 palabras)
    const keywords = nameLower.split(/\s+/).slice(0, 3).join(' ');
    if (keywords !== nameLower) {
      const res2 = await shopifyApi.getProducts(shop, token, { limit: 100, search: keywords });
      for (const p of (res2.products || [])) {
        const titleLower = p.title.toLowerCase();
        if (titleLower.includes(keywords) || keywords.includes(titleLower.split(' ')[0])) {
          const firstVariant = p.variants?.find(v => v.available !== false) || p.variants?.[0];
          if (firstVariant?.id) {
            console.log(`[Pipeline] variantId resuelto (palabras clave "${keywords}"): ${firstVariant.id} del producto "${p.title}"`);
            return { variantId: firstVariant.id, price: firstVariant.price };
          }
        }
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

  if (!variantId) {
    console.warn(`[Pipeline] ⚠️  No se encontró variantId para "${draft.product_name}" — usando custom line item`);
  }

  const shopifyResult = await shopifyApi.createDraftOrder(
    shopDomain,
    shopToken,
    customer,
    [{
      variantId,
      title:    draft.product_name,
      price:    price || draft.price || 0,
      quantity: parseInt(draft.quantity) || 1,
    }],
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
