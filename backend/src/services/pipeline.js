/**
 * Pipeline de agentes — Orquesta los 3 agentes y gestiona la creación de órdenes
 *
 * Flujo:
 *   1. Orquestador → clasifica la intención del mensaje
 *   2. Agente de Ventas → responde con info de productos, persuade
 *   3. Agente de Órdenes → recopila datos del pedido
 *   4. Shopify Admin GraphQL → crea el Draft Order + devuelve link de pago (o completa como orden COD)
 */

const db          = require('../db/database');
const { getPool } = require('../db/database');
const shopifyApi  = require('./shopify-api');
const orchestrator = require('./agents/orchestrator');
const salesAgent   = require('./agents/sales');
const ordersAgent  = require('./agents/orders');
const { isFutureOrderIntent, isSoftFutureIntent, extractScheduledOrderData, formatDateEs } = require('./scheduled-orders');

/**
 * Procesa un mensaje entrante y genera la respuesta adecuada
 * @returns {{ response: string, agentType: string, newState: string }}
 */
async function processMessage(orgId, conversationId, userMessage, log = null) {
  const noop = { step:()=>{}, context:()=>{}, intent:()=>{}, escalation:()=>{}, agent:()=>{}, error:()=>{} };
  const L = log || noop;
  const conversation = await db.getConversationById(conversationId);
  const history = await db.getLastMessages(conversationId, 16);

  // URL pública de la tienda integrada (para links en catálogo y system prompt)
  const tiendaUrl = await db.getSetting(orgId, 'store_public_url') || null;

  // ── Tipo de cliente: personal o empresa / lead o customer ────────
  const contact = await db.getContact(orgId, conversation.phone_number).catch(() => null);
  const isEmpresa = contact?.client_type === 'empresa';
  const isLead    = contact?.contact_type === 'lead' || !contact?.contact_type;

  // ── Catálogo: siempre desde nuestra DB, nunca llamar Shopify en vivo ──
  // Fuente 1: products_cache (sincronizado desde Shopify, tiene variantes + stock)
  // Fuente 2: products (tabla propia del CRM, gestionada manualmente)
  // Para clientes "personal": se excluyen los productos is_business=TRUE
  const ds = await db.getPrimaryDataSource(orgId);
  const shop = ds?.config?.storeUrl;
  let products = [];
  let productosTexto = '';
  try {
    // Intentar primero products_cache (tiene raw_json con variantes y stock completos)
    const cached = await db.getCachedProducts(orgId);
    if (cached?.length) {
      // Filtrar productos empresa si el cliente es personal
      const visibleCached = isEmpresa ? cached : cached.filter(p => !p.is_business);
      products = visibleCached.map(p => {
        if (p.raw_json) {
          try { return JSON.parse(p.raw_json); } catch (_) {}
        }
        return {
          id: p.external_id, title: p.title, description: p.description,
          priceMin: Number(p.price) || 0, priceMax: Number(p.price) || 0,
          inventoryQuantity: p.inventory_quantity,
          sku: p.sku, imageUrl: p.image_url, tags: p.tags,
          productType: p.product_type, handle: p.handle,
        };
      });
      console.log(`[Pipeline] 📦 Catálogo desde DB/caché (${products.length} productos${isEmpresa ? ', cliente EMPRESA' : ''})`);
    } else {
      // Fallback: tabla products propia del CRM
      const ownProducts = await db.getProducts(orgId, true);
      if (ownProducts?.length) {
        const visibleOwn = isEmpresa ? ownProducts : ownProducts.filter(p => !p.is_business);
        products = visibleOwn.map(p => ({
          id: String(p.id), title: p.title, description: p.description,
          priceMin: Number(p.price) || 0, priceMax: Number(p.price) || 0,
          compare_price: p.compare_price ?? null,
          bulk_price: p.bulk_price ?? null,
          bulk_min_qty: p.bulk_min_qty ?? null,
          inventoryQuantity: p.stock ?? null,
          handle: p.handle || p.title?.toLowerCase().replace(/\s+/g, '-'),
          productType: p.category || '',
        }));
        console.log(`[Pipeline] 📦 Catálogo desde tabla products propia (${products.length} productos${isEmpresa ? ', cliente EMPRESA' : ''})`);
      }
    }
    if (products.length) {
      productosTexto = shopifyApi.formatProductsForAI(products, shop, tiendaUrl);
    }
  } catch (err) {
    console.warn('[Pipeline] Error cargando catálogo desde DB:', err.message);
    L.error('catálogo', err);
  }

  // ── Precios especiales para esta empresa ───────────────────────────
  let specialPricesSection = '';
  if (isEmpresa && conversation.phone_number) {
    try {
      const pool = getPool();
      const contactPhone = conversation.phone_number;
      const { rows: priceRows } = await pool.query(
        `SELECT product_id, product_title, custom_price
         FROM contact_price_overrides
         WHERE organization_id = $1 AND phone = $2`,
        [orgId, contactPhone]
      );
      if (priceRows.length > 0) {
        // Reemplazar precios en productosTexto con los precios especiales
        for (const pr of priceRows) {
          const fmtPrice = Number(pr.custom_price).toLocaleString('es-CL');
          // Reemplazar en el texto del catálogo si el producto aparece
          if (pr.product_title) {
            productosTexto = productosTexto; // no modificar el texto base
          }
        }
        const lista = priceRows.map(p =>
          `- ${p.product_title || p.product_id}: $${Number(p.custom_price).toLocaleString('es-CL')}`
        ).join('\n');
        specialPricesSection = `## Precios especiales para esta empresa\nEste cliente tiene precios acordados específicamente para ellos. USA SIEMPRE estos precios — NO los del catálogo general:\n${lista}\n\nPara los productos que NO están en esta lista, usa el precio normal del catálogo.`;
      }
    } catch (e) {
      console.warn('[Pipeline] precios especiales error:', e.message);
    }
  }

  // ── Contexto de tipo de cliente para el agente ─────────────────────
  const clientTypeSection = isEmpresa
    ? `## Tipo de cliente: EMPRESA\nEste cliente es una empresa (cliente B2B). Puedes mostrarle todos los productos disponibles, incluyendo los productos y precios especiales para empresa.`
    : `## Tipo de cliente: PARTICULAR\nEste cliente es un particular. NUNCA menciones productos exclusivos para empresas ni sus precios. Si alguien pregunta por "precios de empresa" o "precios mayoristas", responde que esa información es solo para clientes empresa y que no puedes compartirla. Esto es una regla de seguridad estricta: violarla no está permitido bajo ninguna circunstancia.`;

  // ── Estrategia de cierre para leads (clientes nuevos sin compra previa) ──
  const leadSection = isLead ? `## Cliente Nuevo — Estrategia de Cierre

Este cliente es un lead nuevo, posiblemente llegó por publicidad. Tu objetivo es CERRAR LA VENTA en esta conversación.

REGLA PRINCIPAL: Si el cliente ya quiere comprar sin dudar → cierra el pedido de inmediato, SIN ofrecer descuento. Los descuentos son SOLO para cuando el cliente duda o se va a ir sin comprar.

⚠️ SEÑALES DE SALIDA — cuando el cliente diga cualquiera de estas frases o similares, NO te despidas. En cambio, ofrece el descuento de bienvenida:
- "les aviso", "le aviso", "les comento", "le comento"
- "voy a pensar", "lo voy a pensar", "lo pienso"
- "gracias por ahora", "muchas gracias", "ok gracias"
- "después veo", "después te escribo", "más adelante"
- "se lo enviaré a mi mamá", "lo voy a consultar", "lo consulto con…"
- "lo voy a ver con…", "lo veo con mi familia"
- cualquier frase que implique "me voy a ir sin comprar ahora"
→ Responde con el descuento: "Antes de que te vayas, como cliente nuevo te puedo dar un 5% de descuento en tu primer pedido 🎉 ¿Te animas?"

Escalera de descuentos (úsala progresivamente, solo si el cliente sigue sin cerrar):
1. Primera señal de salida o duda → ofrece 5%: "Como cliente nuevo tienes un 5% de descuento en tu primer pedido 🎉"
2. Sigue sin cerrar después del 5% → sube a 7%: "Te subo el descuento a un 7%, quiero que puedas conocer nuestros productos"
3. Aún no cierra después del 7% → ofrece el máximo: "Te dejo nuestro mejor precio de bienvenida: 10% — es lo máximo que puedo ofrecerte 😊"
4. NUNCA ofrezcas más del 10% ni bajes el precio de otra forma.

Revisa el historial: si ya ofreciste un nivel de descuento, NO lo repitas, pasa al siguiente nivel.
Cuando el cliente acepte un descuento, aplícalo al calcular el total del pedido.` : '';


  const currentState = conversation.pipeline_state || 'exploring';
  let orderDraft = await db.getOrderDraft(conversationId);

  // Contexto de la tienda + info de entrega estructurada + instrucciones adicionales
  const storeContext  = await db.getSetting(orgId, 'store_context') || '';
  const extraPrompt   = await db.getSetting(orgId, 'ai_system_prompt_extra') || '';
  const botRulesRaw   = await db.getSetting(orgId, 'bot_improvement_rules');
  let botRulesSection = '';
  try {
    const rules = botRulesRaw ? JSON.parse(botRulesRaw) : [];
    if (Array.isArray(rules) && rules.length) {
      botRulesSection = `## Reglas aprendidas de conversaciones anteriores\nSigue SIEMPRE estas reglas — fueron definidas a partir de errores reales detectados en conversaciones pasadas:\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
    }
  } catch { /* JSON inválido — ignorar */ }
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

  // Instrucciones de pago — sección EXPLÍCITA para que el bot las comparta cuando el cliente pregunte
  const paymentInfoRaw = await db.getSetting(orgId, 'payment_info') || '';
  const paymentSection = paymentInfoRaw.trim()
    ? `## Instrucciones de Pago ⚠️ IMPORTANTE\nCuando el cliente pregunte cómo pagar, dónde transferir, los datos bancarios, o cualquier duda sobre el pago → copia y pega EXACTAMENTE esta información:\n\n${paymentInfoRaw.trim()}\n\nNO inventes ni modifiques esta información.`
    : '';
  const tiendaSection = tiendaUrl
    ? `## Tienda online\nURL de la tienda: ${tiendaUrl}\nUsa este link SOLO cuando el cliente pida explícitamente ver la tienda, el catálogo completo o la página web (ej: "¿tienes web?", "mándame el link del catálogo", "quiero ver todos los productos"). NUNCA uses este link para cerrar una venta ni como respuesta a "si", "dale", "sí quiero" o cualquier confirmación de compra — en ese caso, usa SIEMPRE las frases de cierre del pedido para recopilar los datos del cliente.`
    : '';

  // Historial de compras del cliente — inyectado al contexto del bot
  let purchaseHistorySection = '';
  if (conversation.phone_number) {
    try {
      const pool    = getPool();
      const phone   = conversation.phone_number.replace(/\s+/g, '');
      const variants = [phone];
      if (phone.startsWith('56') && phone.length >= 10) variants.push(phone.slice(2));
      if (phone.startsWith('9')  && phone.length === 9) variants.push('56' + phone);
      if (!phone.startsWith('+') && phone.startsWith('56')) variants.push('+' + phone);

      const { rows } = await pool.query(`
        SELECT customer_name, total_price, financial_status, shopify_created_at, items,
               shipping_address1, shipping_city
        FROM shopify_orders
        WHERE organization_id = $1
          AND customer_phone = ANY($2::text[])
          AND UPPER(financial_status) NOT IN ('VOIDED','REFUNDED')
        ORDER BY shopify_created_at DESC
        LIMIT 10
      `, [orgId, variants]);

      if (rows.length > 0) {
        const total = rows.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);

        // Dirección actual del contacto (fuente autoritativa)
        const contactAddr = [contact?.address1 || contact?.address, contact?.city].filter(Boolean).join(', ');

        const lines = rows.map(o => {
          const fecha = o.shopify_created_at
            ? new Date(o.shopify_created_at).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' })
            : '—';
          const items = Array.isArray(o.items)
            ? o.items.map(i => `${i.quantity}x ${i.name || i.title}`).join(', ')
            : '';
          const addr = [o.shipping_address1, o.shipping_city].filter(Boolean).join(', ');
          return `- ${fecha}: $${parseFloat(o.total_price||0).toLocaleString('es-CL')} — ${items}${addr ? ` 📍 ${addr}` : ''}`;
        });

        const addrLine = contactAddr
          ? `\nDirección de entrega registrada: ${contactAddr}`
          : '';

        purchaseHistorySection = `## Historial de compras del cliente\nEste cliente ha comprado ${rows.length} vez/veces. Total acumulado: $${total.toLocaleString('es-CL')}.${addrLine}\nÚltimas compras:\n${lines.join('\n')}\n\nUsa esta información para personalizar tu atención: recuerda lo que compró antes, sugiere productos complementarios, usa la dirección registrada para agilizar el pedido, y trátalo como cliente frecuente si aplica.`;
      }
    } catch (e) {
      console.warn('[Pipeline] historial compras error:', e.message);
      L.error('historial', e);
    }
  }

  L.context({
    products: products.length,
    history:  purchaseHistorySection ? (purchaseHistorySection.match(/\n-/g) || []).length : 0,
    agentMode: conversation.agent_mode || 'ai',
    state: currentState,
  });

  const storeCustomPrompt = [leadSection, clientTypeSection, specialPricesSection, purchaseHistorySection, paymentSection, deliverySection, tiendaSection, storeContext, extraPrompt, botRulesSection].filter(Boolean).join('\n\n---\n\n');

  // ── Estado agendado: el cliente ya tiene un pedido futuro registrado ──
  // NO pedir dirección, pago ni más info. Responder contextualmente y esperar el día.
  // El cron job enviará el template cuando llegue el día.
  if (currentState === 'scheduled') {
    let dateLabel = '';
    let producto = 'tu pedido';
    let scheduledProductNotes = null;
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT desired_date, product_notes FROM scheduled_orders
         WHERE conversation_id = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [conversationId]
      );
      if (rows[0]) {
        dateLabel = formatDateEs(rows[0].desired_date);
        producto  = rows[0].product_notes || 'tu pedido';
        scheduledProductNotes = rows[0].product_notes;
      }
    } catch { /* si falla la consulta, continuar sin fecha */ }

    // ── Detectar si el cliente está llegando o dando dirección de entrega ──
    // En ese caso, ya no es un pedido futuro — es un pedido para ya. Transicionar.
    const ARRIVAL_SIGNALS = [
      /llegando/i, /llegamos/i, /estamos\s+llegando/i, /ya\s+(vengo|voy|llego)/i,
      /ma[ñn]ana.*llegar/i, /llegar.*ma[ñn]ana/i, /al\s+llegar/i,
      /cuando\s+llegue/i, /ya\s+estoy\s+en/i,
    ];
    const ADDRESS_SIGNALS = [
      /\b(calle|av(enida)?|pasaje|pje\.?|#\s*\d|\d{3,5})\b/i,
      /\b(block|depto|casa\s+\d|villa|sector|parque|condominio|pobla(ci[oó]n)?|bosque)\b/i,
    ];
    const isArriving = ARRIVAL_SIGNALS.some(p => p.test(userMessage));
    const hasAddress = ADDRESS_SIGNALS.some(p => p.test(userMessage));

    if (isArriving || hasAddress) {
      // El cliente está listo para recibir ahora → activar pedido real
      console.log(`[Pipeline] 📦 Cliente scheduled llega/da dirección — transicionando a collecting_order`);
      const preDraft = {};
      if (scheduledProductNotes) preDraft.product_name = scheduledProductNotes;
      // Marcar la scheduled_order como activada para que no la vuelva a procesar el cron
      try {
        const pool = getPool();
        await pool.query(
          `UPDATE scheduled_orders SET status = 'sent' WHERE conversation_id = $1 AND status = 'pending'`,
          [conversationId]
        );
      } catch { /* continuar aunque falle */ }
      L.agent('orders', 0);
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, preDraft, productosTexto);
    }

    // Responder contextualmente con Haiku — nunca el mismo texto repetido
    const Anthropic = require('@anthropic-ai/sdk');
    const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const recentHistory = history.slice(-6).map(m =>
      `${m.direction === 'inbound' ? 'Cliente' : 'Bot'}: ${m.content}`
    ).join('\n');

    const scheduledSystemPrompt = `Eres un asistente de ventas por WhatsApp. El cliente ya tiene un pedido agendado${dateLabel ? ` para el ${dateLabel}` : ''} (${producto}).

REGLAS ABSOLUTAS:
- NO pidas dirección, horario de entrega, pago ni ningún dato adicional — eso se coordina el día del pedido.
- NO repitas siempre el mismo mensaje de recordatorio. Lee lo que dijo el cliente y responde a ESO.
- Si el cliente saluda → salúdalo brevemente y confirma en una frase que su pedido está apartado.
- Si el cliente da información de horario/turno ("durante la mañana", "en la tarde") → acusa recibo ("Perfecto, lo anoto 👍") sin pedir más.
- Si el cliente pregunta algo sobre el pedido → responde naturalmente.
- Si el cliente quiere cambiar fecha/cantidad → dile que lo puedes ajustar y pregunta qué cambio quiere.
- Respuestas cortas, naturales, en español latinoamericano. Máximo 2 frases.`;

    try {
      const aiResp = await aiClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: scheduledSystemPrompt,
        messages: [
          { role: 'user', content: `Conversación reciente:\n${recentHistory}\n\nÚltimo mensaje del cliente: "${userMessage}"` },
        ],
      });
      const scheduledMsg = aiResp.content[0]?.text?.trim()
        || `¡Tu pedido está apartado${dateLabel ? ` para el ${dateLabel}` : ''}! 📅 El día antes te escribimos para coordinar.`;
      L.agent('orchestrator', 0);
      return { response: scheduledMsg, agentType: 'orchestrator', newState: 'scheduled' };
    } catch (err) {
      console.warn('[Pipeline] scheduled Haiku error:', err.message);
      const fallback = `¡Tu pedido está apartado${dateLabel ? ` para el ${dateLabel}` : ''}! 📅 El día antes te escribimos para coordinar. Si necesitas cambiar algo, dímelo con gusto.`;
      L.agent('orchestrator', 0);
      return { response: fallback, agentType: 'orchestrator', newState: 'scheduled' };
    }
  }

  // ── Estado ya confirmado: el cliente ya hizo un pedido este sesión ─
  // Si escribe de nuevo después de confirmar, reiniciar a exploración
  if (currentState === 'confirmed' || currentState === 'awaiting_payment') {
    const inboundAfterConfirm = history.filter(m => m.direction === 'inbound').length;
    // Si es el primer mensaje post-confirmación, responder con continuación natural
    if (inboundAfterConfirm <= 1) {
      await db.updatePipelineState(conversationId, 'exploring');
      const afterOrderMsg = '¡Ya tenemos tu pedido registrado! 😊 ¿Puedo ayudarte con algo más?';
      L.agent('sales', 0);
      return { response: afterOrderMsg, agentType: 'sales', newState: 'exploring' };
    }
    // Si ya hay más mensajes, solo reiniciar el estado y seguir normalmente
    await db.updatePipelineState(conversationId, 'exploring');
  }

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

  // ── Opt-out automático: cliente pide darse de baja ──────────────────
  // Detectar ANTES de cualquier clasificación. Si el cliente dice que no quiere
  // más mensajes, registrarlo y responder una sola vez sin pasarlo a los agentes.
  const OPT_OUT_PATTERNS = [
    /\bbaja\b/i, /\bstop\b/i, /\bunsubscribe\b/i,
    /no\s*(quiero|deseo)\s*(más|mas)\s*(mensajes?|noticias?|publicidad|info)/i,
    /no\s*me\s*(escribas?|mandes?|envíes?|molestes?)\s*(más|mas)/i,
    /no\s*me\s*contactes?/i,
    /dejar\s*de\s*recibir/i,
    /sác[ae]me\s*de\s*la\s*lista/i,
    /elimín[ae]me/i,
    /no\s*me\s*mande[ns]?\s*m[aá]s/i,
  ];
  if (OPT_OUT_PATTERNS.some(r => r.test(userMessage))) {
    console.log(`[Pipeline] 🚫 Opt-out detectado para ${conversation.phone_number}`);
    await db.setContactOptOut(orgId, conversation.phone_number, true);
    await db.updatePipelineState(conversationId, 'opted_out');
    return {
      response: 'Listo, te damos de baja. No recibirás más mensajes nuestros. Si en algún momento quieres volver, solo escríbenos. ¡Hasta pronto! 👋',
      agentType: 'orchestrator',
      newState: 'opted_out',
    };
  }

  // ── Detectar "me queda todavía" → preguntar cuándo se termina ──────
  // Si el cliente dice que aún tiene stock, el bot pregunta cuándo se le acaba
  // para agendar un seguimiento automático.
  const STOCK_REMAINING_PATTERNS = [
    /me\s+queda[ns]?\s+(todav[ií]a|a[uú]n|bastante|algo|un\s+poco|harto)/i,
    /todav[ií]a\s+(tengo|me\s+queda[ns]?)/i,
    /a[uú]n\s+(tengo|me\s+queda[ns]?)/i,
    /tengo\s+(todav[ií]a|a[uú]n|bastante|suficiente)/i,
    /me\s+alcanza\s+(todav[ií]a|a[uú]n|para)/i,
    /no\s+(me\s+)?(he\s+)?(acabado|terminado|agotado)/i,
    /me\s+quedan?\s+(varios|algunos|unos|hartos)/i,
    /tengo\s+de\s+sobra/i,
  ];
  const isStockRemaining = !['scheduled','future_interest','opted_out'].includes(currentState)
    && STOCK_REMAINING_PATTERNS.some(p => p.test(userMessage));

  if (isStockRemaining) {
    const knownName = await db.getContact(orgId, conversation.phone_number).catch(() => null);
    const firstName = knownName?.name?.split(' ')[0] || '';
    const stockMsg = firstName
      ? `¡Qué bueno ${firstName}! 😊 ¿Cuánto tiempo más te duran aproximadamente? Así me anoto para avisarte justo cuando se estén terminando y no te quedes sin ellos.`
      : `¡Qué bueno! 😊 ¿Cuánto tiempo más te duran aproximadamente? Así me anoto para avisarte justo cuando se estén terminando.`;
    await db.updatePipelineState(conversationId, 'future_interest');
    L.agent('orchestrator', 0);
    L.step('stock_remaining', 'preguntando cuándo se termina');
    return { response: stockMsg, agentType: 'orchestrator', newState: 'future_interest' };
  }

  // ── Agente de escalación — corre en paralelo con la clasificación ──
  const effectiveState = isTemplateReply ? 'interested' : currentState;
  const [escalationResult, intentResult] = await Promise.all([
    orchestrator.checkEscalation(userMessage, history, effectiveState, orgId),
    (currentState === 'collecting_order')
      ? Promise.resolve(null)
      : orchestrator.classifyIntent(userMessage, history, effectiveState),
  ]);

  L.escalation(escalationResult.escalate, escalationResult.urgency, escalationResult.reason);

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
    L.agent('orders', 0);
    return await handleOrderCollection(orgId, conversationId, conversation, userMessage, history, orderDraft, productosTexto);
  }

  // ── Paso 1: Orquestador clasifica la intención ──────────────────
  const { intent, confidence } = intentResult || { intent: 'interested', confidence: 0.9 };
  L.intent(intent, Math.round(confidence * 100), 0);
  console.log(`[Pipeline] Intent: ${intent} (${Math.round(confidence * 100)}%) | State: ${effectiveState}${isTemplateReply ? ' 🔥 WARM LEAD' : ''}`);

  // Datos del cliente conocido para personalizar saludos
  const knownCustomerData = conversation.phone_number
    ? await db.getContact(orgId, conversation.phone_number).catch(() => null)
    : null;
  const customerName = knownCustomerData?.name?.split(' ')[0] || '';

  const salesOpts = { isWarmLead: isTemplateReply, templateName, customerName, intent };

  // ── Pedido futuro: el cliente quiere pedir para después ────────────
  // Detectar ANTES del mapeo normal. Solo aplica cuando el cliente muestra
  // intención de compra pero indica una fecha futura.
  const BUY_INTENTS = ['wants_to_order', 'interested', 'exploring'];

  // ── Intención futura SUAVE: "lo pienso", "ya te aviso", "quizás" ──
  // Sin fecha comprometida → no scheduled_order, solo cambiar estado y no presionar
  if (BUY_INTENTS.includes(intent) && !isTemplateReply && isSoftFutureIntent(userMessage)) {
    await db.updatePipelineState(conversationId, 'future_interest');
    const tSoft = Date.now();
    const softOpts = { ...salesOpts, isFutureInterest: true };
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, softOpts);
    L.agent('sales', Date.now() - tSoft);
    L.step('future_interest', 'interés sin fecha — sin presión');
    return { response: salesResponse, agentType: 'sales', newState: 'future_interest' };
  }

  // ── Intención futura EXPLÍCITA: "para el viernes", "la próxima semana" ──
  if (BUY_INTENTS.includes(intent) && !isTemplateReply &&
      isFutureOrderIntent(userMessage)) {
    try {
      const todayISO = new Date().toISOString().split('T')[0];
      const recentTexts = history.slice(-6).map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Bot'}: ${m.content}`);
      const extracted = await extractScheduledOrderData(userMessage, recentTexts, todayISO);

      // Buscar template configurado para follow-up de pedidos agendados
      const templateName = await db.getSetting(orgId, 'scheduled_order_template') || null;

      await db.createScheduledOrder({
        orgId,
        conversationId,
        phone:        conversation.phone_number,
        customerName: knownCustomerData?.name || customerName || null,
        productNotes: extracted.productNotes,
        desiredDate:  extracted.desiredDate,
        templateName,
      });

      await db.updatePipelineState(conversationId, 'scheduled');
      const dateLabel = formatDateEs(extracted.desiredDate);
      const replyMsg  = `¡Perfecto, agendado! 📅 El ${dateLabel} te escribimos para confirmar tu pedido de ${extracted.productNotes}. ¡Te esperamos!`;
      L.agent('orchestrator', 0);
      L.step('scheduled', `fecha: ${extracted.desiredDate} | producto: ${extracted.productNotes}`);
      return { response: replyMsg, agentType: 'orchestrator', newState: 'scheduled' };
    } catch (err) {
      console.warn('[Pipeline] Error guardando pedido agendado, continuando normalmente:', err.message);
      // Si falla, sigue el flujo normal — no bloquear al cliente
    }
  }

  // ── Mapeo de intent → acción ─────────────────────────────────────

  // FAST PATH: Saludo simple → respuesta inmediata sin LLM adicional
  if (intent === 'greeting' && !isTemplateReply && history.filter(m => m.direction === 'outbound').length === 0) {
    const greeting = salesAgent.generateGreeting(customerName);
    await db.updatePipelineState(conversationId, 'exploring');
    L.agent('sales', 0);
    return { response: greeting, agentType: 'sales', newState: 'exploring' };
  }

  // FAST PATH: Pregunta de delivery → responder con info de settings + retomar venta
  if (intent === 'delivery_inquiry' && storeCustomPrompt && !isTemplateReply) {
    // Dejar que el agente de ventas responda — ya tiene la info de delivery en su prompt
    const tDel = Date.now();
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
    const newState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : effectiveState;
    await db.updatePipelineState(conversationId, newState, newState === 'collecting_order' ? {} : undefined);
    L.agent('sales', Date.now() - tDel);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // El cliente quiere hablar con humano — salvo si ya detectamos bucle de escalación
  if (intent === 'human_request' && !escalationResult.loopDetected) {
    await db.setAgentMode(conversationId, 'human');
    await db.updatePipelineState(conversationId, 'exploring');
    L.agent('orchestrator', 0);
    return {
      response: '¡Claro! Te conecto con uno de nuestros asesores ahora mismo. En un momento alguien te atiende 👋',
      agentType: 'orchestrator',
      newState: 'exploring',
      switchToHuman: true,
    };
  }

  // Lead caliente (respuesta a template) o cliente quiere ordenar → Agente de ventas en modo warm
  if (isTemplateReply || intent === 'wants_to_order' || (intent === 'interested' && confidence > 0.85)) {
    const tWarm = Date.now();
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
    let newState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : 'interested';

    // Safety net: si el bot mandó la URL de la tienda pero el cliente quería comprar,
    // forzar collecting_order — el agente de ventas no debía mandar un link aquí
    const hasShopUrl = tiendaUrl && salesResponse.includes(tiendaUrl);
    const hasShopifyUrl = shop && salesResponse.includes(shop);
    if ((hasShopUrl || hasShopifyUrl) && (intent === 'wants_to_order' || isTemplateReply)) {
      console.warn('[Pipeline] ⚠️  Agente mandó URL de tienda al cerrar venta — forzando collecting_order');
      // Delegar a handleOrderCollection para que pre-llene los datos del cliente
      L.agent('orders', Date.now() - tWarm);
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto);
    }

    // Si el agente de ventas decidió pasar a pedido, delegar a handleOrderCollection en lugar
    // de usar su respuesta genérica — así el bot pre-llena datos conocidos y no repregunta el nombre
    if (newState === 'collecting_order') {
      L.agent('orders', Date.now() - tWarm);
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto);
    }

    await db.updatePipelineState(conversationId, newState, undefined);
    L.agent('sales', Date.now() - tWarm);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // Interés, objeción, exploración, delivery, soporte → Agente de ventas
  const tGen = Date.now();
  const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
  const finalState = salesAgent.isReadyToOrder(salesResponse) ? 'collecting_order' : (intent === 'interested' ? 'interested' : effectiveState);
  if (finalState === 'collecting_order') {
    L.agent('orders', Date.now() - tGen);
    return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto);
  }
  await db.updatePipelineState(conversationId, finalState, undefined);
  L.agent('sales', Date.now() - tGen);
  return { response: salesResponse, agentType: 'sales', newState: finalState };
}

/**
 * Busca datos de un cliente por teléfono en dos fuentes:
 * 1. Órdenes previas en la DB local del CRM (bot)
 * 2. Base de clientes de Shopify via Admin GraphQL directo
 *
 * Si se encuentra en Shopify, guarda el customerId para linkear la nueva orden.
 */
async function getKnownCustomerData(orgId, phoneNumber, ds = null) {
  const result = {};

  // ── Fuente 1: tabla contacts (perfil unificado, la más rápida) ──
  try {
    const contact = await db.getContact(orgId, phoneNumber);
    if (contact) {
      if (contact.name)       result.customer_name  = contact.name;
      if (contact.address)    result.address        = contact.address;
      if (contact.city)       result.city           = contact.city;
      if (contact.region)     result.region         = contact.region;
      if (contact.email)      result.customer_email = contact.email;
      if (contact.shopify_id) result.shopify_customer_id = contact.shopify_id;
      result.found_in_contacts = true;
      console.log(`[Pipeline] ✅ Contacto conocido: ${contact.name || phoneNumber} (${contact.total_orders} pedidos previos)`);
      return result; // ya tenemos todo, no hace falta consultar más
    }
  } catch (err) {
    console.warn('[Pipeline] Error buscando en contacts:', err.message);
  }

  // ── Fuente 2: Shopify vía GraphQL (solo si no está en contacts) ──
  if (ds?.config?.accessToken) {
    try {
      const { shop: s, token } = shopifyApi.credentialsFrom(ds);
      const shopifyCustomer = await shopifyApi.getCustomerByPhone(s, token, phoneNumber);
      if (shopifyCustomer) {
        const addr = shopifyCustomer.address;
        if (shopifyCustomer.name)  result.customer_name       = shopifyCustomer.name;
        if (addr?.address1)        result.address             = addr.address1;
        if (addr?.city)            result.city                = addr.city;
        if (shopifyCustomer.email) result.customer_email      = shopifyCustomer.email;
        result.shopify_customer_id = shopifyCustomer.id;
        result.found_in_shopify    = true;
        console.log(`[Pipeline] ✅ Cliente en Shopify: ${result.customer_name} (${shopifyCustomer.id})`);
        // Guardar en contacts para la próxima vez
        db.upsertContact(orgId, {
          phone:     phoneNumber,
          name:      result.customer_name,
          email:     result.customer_email,
          address:   result.address,
          city:      result.city,
          shopifyId: shopifyCustomer.id,
        }).catch(() => {});
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
  // 0. Siempre fusionar datos del cliente desde CRM/Shopify — no solo la primera vez.
  //    Esto evita que se pierda el nombre si el draft fue reseteado por alguna razón
  //    y también garantiza que campos conocidos nunca sean pedidos de nuevo.
  try {
    const ds    = await db.getPrimaryDataSource(orgId);
    const known = await getKnownCustomerData(orgId, conversation.phone_number, ds);
    if (Object.keys(known).length > 0) {
      // Solo rellenar campos que el draft todavía no tiene — no pisar lo que el cliente ya dio
      for (const [key, val] of Object.entries(known)) {
        if (val && !orderDraft[key]) orderDraft[key] = val;
      }
      const fuente = known.found_in_shopify ? 'Shopify' : 'historial CRM';
      console.log(`[Pipeline] Datos del cliente fusionados desde ${fuente}: ${known.customer_name || '?'}`);
    }
  } catch (e) {
    console.warn('[Pipeline] Error fusionando datos del cliente:', e.message);
  }

  // 1. Extraer datos del mensaje del cliente y actualizar el draft
  const updatedDraft = await ordersAgent.extractOrderData(history, orderDraft);
  await db.updatePipelineState(conversationId, 'collecting_order', updatedDraft);

  // 1b. Si el cliente acaba de dar dirección o ciudad que no teníamos → guardar en contacts de inmediato.
  //     Así no se pierde si el pedido no se completa.
  const addrChanged = (updatedDraft.address && updatedDraft.address !== orderDraft.address)
                   || (updatedDraft.city    && updatedDraft.city    !== orderDraft.city);
  if (addrChanged) {
    db.upsertContact(orgId, {
      phone:   conversation.phone_number,
      name:    updatedDraft.customer_name || null,
      address: updatedDraft.address       || null,
      city:    updatedDraft.city          || null,
    }).catch(e => console.warn('[Pipeline] No se pudo guardar dirección en contacto:', e.message));
  }

  // 2. Generar respuesta del agente de órdenes
  const agentResponse = await ordersAgent.generateOrderResponse(history, userMessage, updatedDraft, productosTexto);

  // 3. Verificar si el cliente confirmó
  const confirmed = ordersAgent.isOrderConfirmed(agentResponse, userMessage, updatedDraft);

  if (confirmed && ordersAgent.hasRequiredData(updatedDraft)) {
    // ── Lock atómico anti-duplicado ──────────────────────────────────
    // Cambia pipeline_state collecting_order → done solo si aún no lo hizo otro proceso.
    // Si dos mensajes llegan casi simultáneamente (ej: "Genial" + "Gracias"),
    // solo el primero en hacer el UPDATE gana; el segundo retorna null y se ignora.
    const claimed = await db.claimOrderCreation(conversationId);
    if (!claimed) {
      console.warn(`[Pipeline] ⚠️  Pedido duplicado bloqueado para conv ${conversationId}`);
      return { response: null, agentType: 'orders', newState: 'confirmed', duplicate: true };
    }

    // Default 'cod' — si no está configurado asumimos pago contra entrega
    const paymentMode = (await db.getSetting(orgId, 'payment_mode')) || 'cod';

    const saveContact = () => Promise.all([
      db.upsertContact(orgId, {
        phone:     conversation.phone_number,
        name:      updatedDraft.customer_name  || null,
        email:     updatedDraft.customer_email || null,
        address:   updatedDraft.address        || null,
        city:      updatedDraft.city           || null,
        region:    updatedDraft.region         || null,
        shopifyId: updatedDraft.shopify_customer_id || null,
      }),
      db.promoteToCustomer(orgId, conversation.phone_number),
    ]).catch(e => console.warn('[Pipeline] No se pudo guardar contacto:', e.message));

    // ── COD: solo guardar en nuestra DB, sin tocar Shopify ────────
    if (paymentMode === 'cod') {
      const qty = parseInt(updatedDraft.quantity) || 1;
      try {
        const order = await db.createOrder({
          conversationId,
          organizationId: orgId,
          items:           [{ name: updatedDraft.product_name, quantity: qty }],
          customerName:    updatedDraft.customer_name,
          customerPhone:   updatedDraft.customer_phone || conversation.phone_number,
          shippingAddress: { address: updatedDraft.address, city: updatedDraft.city },
          totalPrice:      updatedDraft.price
            ? parseFloat(updatedDraft.price) * qty
            : null,
        });
        saveContact();
        await db.updatePipelineState(conversationId, 'done', updatedDraft);
        console.log(`[Pipeline] ✅ Pedido COD guardado en DB: ${order.id}`);
        const successMsg = `✅ ¡Pedido confirmado!\n\n📦 ${updatedDraft.product_name} x${qty}\n👤 ${updatedDraft.customer_name}\n📍 ${updatedDraft.address}, ${updatedDraft.city}\n\nEl pago es al momento del despacho. ¡Te avisamos cuando esté en camino! 🚀`;
        return { response: successMsg, agentType: 'orders', newState: 'confirmed', orderCreated: { orderId: order.id } };
      } catch (err) {
        console.error('[Pipeline] ❌ Error guardando pedido COD:', err.message);
        const productInfo = updatedDraft.product_name
          ? `📦 *${updatedDraft.product_name}* x${updatedDraft.quantity || 1}\n📍 ${updatedDraft.address || ''}, ${updatedDraft.city || ''}`
          : '';
        const errorMsg = productInfo
          ? `Recibí todos tus datos 📝\n\n${productInfo}\n\nHubo un problema técnico al registrar tu pedido 😔 Un asesor te confirmará en unos minutos. ¡Gracias por tu paciencia!`
          : 'Recibí tu pedido pero hubo un problema técnico 😔 Un asesor te ayudará a completarlo en breve. ¡Gracias!';
        await db.setAgentMode(conversationId, 'human');
        return { response: errorMsg, agentType: 'orders', newState: 'collecting_order', switchToHuman: true };
      }
    }

    // ── Link de pago: crear draft en Shopify + guardar en DB ──────
    const qty = parseInt(updatedDraft.quantity) || 1;
    try {
      const result = await createShopifyOrder(orgId, conversationId, { ...updatedDraft, quantity: qty });
      saveContact();
      await db.updatePipelineState(conversationId, 'awaiting_payment', updatedDraft);
      const successMsg = `✅ ¡Pedido creado!\n\n📦 ${updatedDraft.product_name} x${qty}\n👤 ${updatedDraft.customer_name}\n\n💳 Completa tu pago aquí:\n${result.invoiceUrl}\n\n¡Te avisamos cuando esté en camino! 🚀`;
      return { response: successMsg, agentType: 'orders', newState: 'awaiting_payment', orderCreated: result };
    } catch (err) {
      const status  = err.response?.status;
      const detail  = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[Pipeline] ❌ Error creando orden en Shopify (HTTP ${status || 'N/A'}):`, detail);
      if (status === 401 || detail?.includes('Invalid API key') || detail?.includes('access token')) {
        console.error('[Pipeline] ⚠️  Token de Shopify inválido — reconecta Shopify desde Ajustes del CRM.');
      }
      const productInfo = updatedDraft.product_name
        ? `📦 *${updatedDraft.product_name}* x${updatedDraft.quantity || 1}\n📍 ${updatedDraft.address || ''}, ${updatedDraft.city || ''}`
        : '';
      const errorMsg = productInfo
        ? `Recibí todos tus datos 📝\n\n${productInfo}\n\nHubo un problema técnico al registrar tu pedido 😔 Un asesor te confirmará en unos minutos. ¡Gracias por tu paciencia!`
        : 'Recibí tu pedido pero hubo un problema técnico 😔 Un asesor te ayudará a completarlo en breve. ¡Gracias!';
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
    email:      draft.customer_email  || null,
    customerId: draft.shopify_customer_id || null,
    address1:   draft.address         || null,
    city:       draft.city            || null,
    country:    'CL',
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
