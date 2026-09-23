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
const pricing      = require('./order-pricing');
const { isFutureOrderIntent, isSoftFutureIntent, extractScheduledOrderData, formatDateEs } = require('./scheduled-orders');

// Un pedido al que todavía tiene sentido anotarle una preferencia de entrega:
// registrado y no cancelado/entregado. Incluye los que ya salieron a reparto
// (por_despachar / en_camino) porque ahí la nota es aún más útil.
function EDITABLE_OR_ACTIVE(status) {
  return ['draft', 'nuevo', 'sent', 'payment_received', 'por_despachar', 'en_camino'].includes(status);
}

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
  const specialPrices = {};   // product_id | título normalizado → precio (lo usa order-pricing)
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
        for (const pr of priceRows) {
          if (pr.product_id != null) specialPrices[String(pr.product_id)] = Number(pr.custom_price);
          if (pr.product_title) {
            const key = String(pr.product_title).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
            specialPrices[key] = Number(pr.custom_price);
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


  let currentState = conversation.pipeline_state || 'exploring';
  let orderDraft = await db.getOrderDraft(conversationId);

  // Contexto que necesita el agente de pedidos para valorizar el carrito
  const orderCtx = { products, specialPrices, isLead };

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
  let deliverySchedule = '';   // el horario tal cual, para responder "¿a qué hora llega?" con dato real
  if (deliveryRaw) {
    try {
      const d = JSON.parse(deliveryRaw);
      deliverySchedule = (d.schedule || '').trim();
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

  // ── Pedido activo de esta conversación (para contexto del bot) ─────────
  let pendingOrderSection = '';
  let activeOrder = null;          // visible para modificar / cancelar más abajo
  let activeOrderSummary = '';
  try {
    activeOrder = await db.getActiveOrderForBot(conversationId);
    if (activeOrder) {
      const STATUS_LABEL = {
        draft:            'Confirmado — en preparación',
        nuevo:            'Confirmado — en preparación',
        sent:             'Confirmado — pendiente de pago',
        payment_received: 'Pago recibido — en preparación',
        por_despachar:    'Listo para despachar 📦',
        en_camino:        'En camino 🚚',
      };
      const statusLabel = STATUS_LABEL[activeOrder.status] || activeOrder.status;

      let itemsLine = '';
      try {
        const items = typeof activeOrder.items === 'string'
          ? JSON.parse(activeOrder.items)
          : activeOrder.items;
        if (Array.isArray(items) && items.length) {
          itemsLine = items
            .map(i => `${i.quantity || 1}x ${i.name || i.title || i.variant_title || ''}`.trim())
            .join(', ');
        }
      } catch (_) {}

      let addrLine = '';
      try {
        const addr = typeof activeOrder.shipping_address === 'string'
          ? JSON.parse(activeOrder.shipping_address)
          : activeOrder.shipping_address;
        const parts = [addr?.address1 || addr?.address, addr?.city].filter(Boolean);
        if (parts.length) addrLine = parts.join(', ');
      } catch (_) {}

      const totalLine = activeOrder.total_price
        ? `$${Number(activeOrder.total_price).toLocaleString('es-CL')}`
        : '';

      activeOrderSummary = [itemsLine, totalLine, statusLabel.replace(/\*\*/g, '')].filter(Boolean).join(' · ');

      pendingOrderSection = `## Pedido activo del cliente ⚠️ LEE ESTO PRIMERO
Este cliente ya tiene un pedido registrado en nuestro sistema:
- Estado: **${statusLabel}**${itemsLine ? `\n- Productos: ${itemsLine}` : ''}${totalLine ? `\n- Total: ${totalLine}` : ''}${addrLine ? `\n- Dirección registrada: ${addrLine}` : ''}

Reglas estrictas para responder sobre este pedido:
1. Si el cliente pregunta "¿cuándo llega?", "¿cómo va mi pedido?", "¿ya lo mandaron?" o similar → responde que su pedido está ${statusLabel.replace(/\*\*/g, '').toLowerCase()} y que pronto recibirá más novedades.
2. NO vuelvas a pedir datos de entrega, dirección ni de pago — el pedido ya está registrado.
3. NO ofrezcas iniciar un nuevo pedido para los mismos productos.
4. Si el cliente quiere modificar o cancelar → dile que sí se puede hacer aquí mismo y pregúntale qué quiere cambiar (el sistema lo procesa automáticamente cuando lo diga).`;

      console.log(`[Pipeline] 📦 Pedido activo inyectado al contexto: id=${activeOrder.id} status=${activeOrder.status}`);
    }
  } catch (e) {
    console.warn('[Pipeline] activeOrder bot context error:', e.message);
  }

  // ── Pedido YA ENTREGADO con pago por transferencia pendiente ("por cobrar") ──
  // Sin esto el bot no sabe que el pedido ya está en manos del cliente y, ante
  // un "transferido", contesta "queda listo para el despacho".
  let chargeOrder = null;
  let chargeSection = '';
  try {
    const phone = String(conversation.phone_number || '').replace(/\D/g, '');
    if (phone) {
      const tail = phone.slice(-9);
      const pend = await require('./payment-collection').getPendingCharges(orgId);   // lazy: evita cargar los senders de WhatsApp al importar el pipeline
      chargeOrder = pend.find(o => String(o.customer_phone || '').replace(/\D/g, '').slice(-9) === tail) || null;
    }
    if (chargeOrder) {
      const total = `$${Number(chargeOrder.total_price || 0).toLocaleString('es-CL')}`;
      const when  = chargeOrder.payment_marked_at
        ? new Date(chargeOrder.payment_marked_at).toLocaleDateString('es-CL', { day: 'numeric', month: 'long' })
        : null;
      const proofLine = chargeOrder.proofs_pending > 0
        ? 'Comprobante: YA lo mandó y está en revisión por el equipo.'
        : 'Comprobante: todavía NO lo ha mandado.';
      const cobroLine = chargeOrder.charge_requested_at
        ? 'Ya se le envió por este chat el mensaje de cobro con los datos bancarios.'
        : '';
      chargeSection = `## Pedido ${chargeOrder.order_label} YA ENTREGADO — pago por transferencia pendiente ⚠️
El cliente YA RECIBIÓ este pedido${when ? ` (entregado el ${when})` : ''} por ${total} y eligió pagar por transferencia.
${proofLine}${cobroLine ? `\n${cobroLine}` : ''}

Reglas estrictas:
1. Este pedido NO se despacha ni se coordina: ya está entregado. NUNCA digas "queda listo para el despacho", "te contactamos para coordinar la entrega" ni nada parecido sobre este pedido.
2. Si dice que transfirió / pagó: agradece y, si aún no ha mandado el comprobante, pídele la captura por este chat. Si ya lo mandó, dile que lo tenemos y que se lo confirmamos.
3. Si pregunta cuánto debe o los datos para transferir: ${total} por el pedido ${chargeOrder.order_label}; los datos bancarios están en la sección de Instrucciones de Pago.
4. Si quiere hacer OTRO pedido, atiéndelo normalmente — es un pedido nuevo, distinto de este.`;
      console.log(`[Pipeline] 💸 Pedido por cobrar inyectado al contexto: ${chargeOrder.order_label}`);
    }
  } catch (e) {
    console.warn('[Pipeline] chargeOrder bot context error:', e.message);
  }

  L.context({
    products: products.length,
    history:  purchaseHistorySection ? (purchaseHistorySection.match(/\n-/g) || []).length : 0,
    agentMode: conversation.agent_mode || 'ai',
    state: currentState,
  });

  // ── Direcciones de despacho pasadas (para preguntar cuál usar si hay varias) ──
  // Un cliente puede haber recibido despachos en más de una dirección (casa,
  // trabajo, la de un familiar…). Si es así, el bot NO debe asumir — debe
  // preguntar a cuál despachar, ofreciendo las que ya conocemos de sus pedidos.
  let pastAddresses = [];
  try {
    if (conversation.phone_number) {
      const pool  = getPool();
      const phone = String(conversation.phone_number).replace(/\s+/g, '');
      const variants = [phone];
      if (phone.startsWith('56') && phone.length >= 10) variants.push(phone.slice(2));
      if (phone.startsWith('9')  && phone.length === 9) variants.push('56' + phone);
      if (!phone.startsWith('+') && phone.startsWith('56')) variants.push('+' + phone);

      const [botRes, shopRes] = await Promise.all([
        pool.query(
          `SELECT shipping_address AS addr
             FROM orders
            WHERE organization_id = $1 AND customer_phone = ANY($2::text[])
              AND shipping_address IS NOT NULL
            ORDER BY created_at DESC LIMIT 30`,
          [orgId, variants]
        ),
        pool.query(
          `SELECT NULLIF(TRIM(CONCAT_WS(', ', shipping_address1, shipping_city)), '') AS addr
             FROM shopify_orders
            WHERE organization_id = $1 AND customer_phone = ANY($2::text[])
            ORDER BY shopify_created_at DESC LIMIT 30`,
          [orgId, variants]
        ),
      ]);

      const botAddr = a => {
        if (!a) return '';
        let x = a;
        if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return String(a).trim(); } }
        if (x && typeof x === 'object') return [x.address || x.address1, x.city].filter(Boolean).join(', ');
        return String(a).trim();
      };
      const seen = new Map();   // clave normalizada -> display (primero visto = más reciente)
      const push = raw => {
        const disp = String(raw || '').trim();
        if (!disp) return;
        const key = disp.toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim();
        if (key && !seen.has(key)) seen.set(key, disp);
      };
      for (const r of botRes.rows)  push(botAddr(r.addr));
      for (const r of shopRes.rows) push(r.addr);
      pastAddresses = [...seen.values()];
    }
  } catch (e) {
    console.warn('[Pipeline] pastAddresses error:', e.message);
  }

  // ── Dirección registrada del contacto ─────────────────────────────────────
  let contactAddressSection = '';
  try {
    if (pastAddresses.length > 1) {
      // El cliente tiene VARIAS direcciones conocidas: el bot debe preguntar.
      const listado = pastAddresses.map((a, i) => `${i + 1}. ${a}`).join('\n');
      contactAddressSection = `## Dirección de despacho — ESTE CLIENTE TIENE VARIAS ⚠️\nEste cliente ha recibido despachos en más de una dirección. Direcciones conocidas de sus pedidos anteriores:\n${listado}\n\nReglas estrictas al registrar el pedido:\n1. NO asumas la dirección. ANTES de confirmar el pedido, pregúntale al cliente a cuál de sus direcciones quiere el despacho, ofreciéndole la lista de arriba (puedes numerarlas para que responda con el número).\n2. Si elige una (por número o por nombre), usa esa dirección exacta para el pedido.\n3. Si menciona una dirección nueva que no está en la lista, úsala tal cual la diga.\n4. No vuelvas a pedir la ciudad si ya la sabes por la dirección elegida; pide solo lo que falte.`;
    } else {
      const cAddr = contact?.address || contact?.address1;
      const cCity = contact?.city;
      if (cAddr && cCity) {
        contactAddressSection = `## Dirección del cliente ✅ NO PEDIR\nTienes la dirección completa registrada: **${cAddr}, ${cCity}**.\n⚠️ NO pidas la dirección al cliente — ya está en el sistema. Cuando registres un pedido, usa esta dirección directamente sin pedírsela.`;
      } else if (cAddr) {
        contactAddressSection = `## Dirección del cliente ✅ NO PEDIR\nDirección registrada: **${cAddr}**.\n⚠️ NO pidas la dirección — ya la tienes. Úsala para el pedido.`;
      } else if (cCity) {
        contactAddressSection = `## Dirección del cliente (ciudad conocida)\nCiudad: **${cCity}**. Si necesitas la dirección de calle para el pedido, pide SOLO la calle y número (ya conoces la ciudad).`;
      }
    }
  } catch (_) {}

  // pendingOrderSection va PRIMERO para que el LLM lo lea antes de cualquier otro contexto
  // Fecha y hora actual (Chile). Sin esto el bot no puede interpretar "hoy",
  // "mañana" ni "el viernes": ante "¿mañana reparten?" respondía que no tenía
  // información, aunque el horario de reparto estuviera en sus instrucciones.
  const nowCl = new Date();
  const fechaLarga = nowCl.toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const horaCl     = nowCl.toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' });
  const manana     = new Date(nowCl.getTime() + 86400000).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'long' });
  const dateSection = `## Fecha y hora actual\nHoy es ${fechaLarga}, ${horaCl} (hora de Chile). Mañana es ${manana}. Usa esto para interpretar "hoy", "mañana", "el viernes", etc., y para saber si un día cae dentro del horario de reparto.`;

  const storeCustomPrompt = [dateSection, chargeSection, pendingOrderSection, contactAddressSection, leadSection, clientTypeSection, specialPricesSection, purchaseHistorySection, paymentSection, deliverySection, tiendaSection, storeContext, extraPrompt, botRulesSection].filter(Boolean).join('\n\n---\n\n');

  // ── Agendado vigente? ──────────────────────────────────────────────────────
  // Solo cuenta un pedido agendado cuya fecha NO haya pasado todavía.
  // Si la fecha ya pasó, el pedido se entregó (o se perdió): seguir tratándolo
  // como "apartado" hace que el bot le ofrezca al cliente algo que ya recibió,
  // y con una fecha vieja ("está apartado para el jueves 3" un día 11).
  let activeScheduled = null;
  if (currentState === 'scheduled') {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT id, desired_date, product_notes FROM scheduled_orders
         WHERE conversation_id = $1 AND status = 'pending'
           AND desired_date >= CURRENT_DATE
         ORDER BY desired_date ASC LIMIT 1`,
        [conversationId]
      );
      activeScheduled = rows[0] || null;

      if (!activeScheduled) {
        // Cerrar los agendados vencidos para que no vuelvan a aparecer, y
        // devolver la conversación al flujo normal.
        const { rowCount } = await pool.query(
          `UPDATE scheduled_orders SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
           WHERE conversation_id = $1 AND status = 'pending' AND desired_date < CURRENT_DATE`,
          [conversationId]
        );
        console.log(`[Pipeline] 📅 Agendado vencido en conv ${conversationId} (${rowCount} cerrado${rowCount === 1 ? '' : 's'}) — volviendo a exploring`);
        await db.updatePipelineState(conversationId, 'exploring').catch(() => {});
        currentState = 'exploring';
      }
    } catch (err) {
      // Si la consulta falla, no asumir que hay un agendado vigente: es peor
      // afirmarle al cliente una fecha equivocada que perder el contexto.
      console.warn('[Pipeline] No se pudo verificar el pedido agendado:', err.message);
      activeScheduled = null;
      currentState = 'exploring';
    }
  }

  // ── Estado agendado: el cliente ya tiene un pedido futuro registrado ──
  // NO pedir dirección, pago ni más info. Responder contextualmente y esperar el día.
  // El cron job enviará el template cuando llegue el día.
  if (currentState === 'scheduled' && activeScheduled) {
    const dateLabel = formatDateEs(activeScheduled.desired_date);
    const producto  = activeScheduled.product_notes || 'tu pedido';
    const scheduledProductNotes = activeScheduled.product_notes;

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
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, preDraft, productosTexto, orderCtx);
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

  // ── Estado ya confirmado: el cliente ya hizo un pedido en esta sesión ─
  // Antes se respondía SIEMPRE "¡Ya tenemos tu pedido registrado!" sin leer el
  // mensaje: "agrégame dos más" o "cambia la dirección" recibían eso. Ahora
  // solo un agradecimiento/cierre corto recibe respuesta enlatada (sin LLM);
  // cualquier otra cosa sigue el flujo normal, que ya conoce el pedido activo
  // y puede modificarlo o cancelarlo.
  if (currentState === 'confirmed' || currentState === 'done' || currentState === 'awaiting_payment') {
    await db.updatePipelineState(conversationId, 'exploring', {});
    currentState = 'exploring';
    orderDraft = {};
    const closingMsg = /^(gracias|muchas gracias|mil gracias|ok|oka|okey|listo|perfecto|genial|dale|vale|buenísimo|buenisimo|excelente|👍|🙏|😊)[\s!.]*$/i;
    if (closingMsg.test(userMessage.trim())) {
      L.agent('sales', 0);
      return { response: '¡Gracias a ti! 😊 Cualquier cosa me escribes por aquí.', agentType: 'sales', newState: 'exploring' };
    }
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

  // ── "Transferido" / "ya pagué" con un pedido entregado por cobrar ───────
  // Respuesta determinística: no se le pide al LLM que adivine el estado.
  // Agradece, pide la captura si falta, y avisa al admin para que cruce la
  // cartola (Conciliación) — el comprobante lo procesa el webhook aparte.
  // Ojo: \b no funciona después de una vocal con tilde ("transferí"), por eso
  // el cierre de palabra es (?!\p{L}) con la bandera u.
  const PAID_PATTERNS = [
    /\btransferid[oa]s?(?!\p{L})/iu,
    /\b(ya|reci[eé]n|listo|lista)\b.{0,25}\b(transfer[ií]|pagu[eé]|deposit[eé]|pag[oó])(?!\p{L})/iu,
    /\b(te|les|le)\s+(transfer[ií]|pagu[eé]|deposit[eé])(?!\p{L})/iu,
    /\b(hice|realic[eé])\s+(la\s+|el\s+)?(transferencia|pago|dep[oó]sito)(?!\p{L})/iu,
    /\btransferencia\s+(hecha|lista|realizada|enviada)(?!\p{L})/iu,
    /\bpago\s+(hecho|listo|realizado|enviado)(?!\p{L})/iu,
    /\blisto\s+el\s+pago(?!\p{L})/iu,
  ];
  if (chargeOrder && !['collecting_order'].includes(currentState)
      && userMessage.length <= 160 && PAID_PATTERNS.some(p => p.test(userMessage))) {
    const first = (conversation.contact_name || chargeOrder.customer_name || '').trim().split(/\s+/)[0] || '';
    const hi = first ? ` ${first}` : '';
    const total = `$${Number(chargeOrder.total_price || 0).toLocaleString('es-CL')}`;
    const response = chargeOrder.proofs_pending > 0
      ? `¡Gracias${hi}! 🙌 Ya nos llegó tu comprobante del pedido ${chargeOrder.order_label}, lo estamos revisando y te confirmamos por acá.`
      : `¡Gracias${hi}! 🙌 Cuando puedas, mándanos la captura del comprobante por este chat y dejamos registrado el pago del pedido ${chargeOrder.order_label} (${total}).`;
    L.agent('orchestrator', 0);
    L.step('paid_notice', `cliente dice que pagó ${chargeOrder.order_label}`);
    return {
      response,
      agentType: 'orchestrator',
      newState: currentState,
      adminNotice: `💸 *${conversation.contact_name || chargeOrder.customer_name || conversation.phone_number}* dice que transfirió el pedido ${chargeOrder.order_label} (${total})${chargeOrder.proofs_pending > 0 ? ' — comprobante en revisión' : ' — sin comprobante aún'}.\nRevisa Pagos o cruza la cartola en Pedidos → Conciliación.`,
    };
  }

  // ── Entrega incompleta / faltante ─────────────────────────────────────
  // "Pedí 3 y llegó 1", "me faltó una caja", "¿las otras quedaron pendientes?"
  // Si hay un pedido entregado hace poco, el bot lo resuelve solo: registra
  // las unidades que faltan como pedido nuevo para el próximo reparto, le
  // confirma al cliente y te avisa (sin bloquear la conversación). Si no
  // logra entender cantidades, escala como antes.
  const PARTIAL_PATTERNS = [
    /\bfalt(a|an|ó|o|aron|aba)\b/i,
    /(lleg[oó]|llegaron|trajeron|vino|vinieron|recib[ií]|entregaron)\s+(solo|solamente|s[oó]lo|nada\s+m[aá]s\s+que|apenas)\b/i,
    /(quedaron|quedan|qued[oó])\s+pendientes?/i,
    /(ped[ií]|hab[ií]a\s+pedido|encargu[eé])\s+\w+.{0,40}(lleg|recib|trajeron)/i,
    /entrega\s+incompleta|incompleto|me\s+llegaron?\s+menos/i,
  ];
  if (!['collecting_order', 'scheduled'].includes(currentState) && PARTIAL_PATTERNS.some(p => p.test(userMessage))) {
    const delivered = await db.getRecentDeliveredOrder(conversationId, 7).catch(() => null);
    if (delivered) {
      const r = await handlePartialDelivery(orgId, conversationId, conversation, userMessage, history, delivered, orderCtx, L);
      if (r) return r;   // null → no se pudo interpretar: sigue el flujo normal (escalación)
    }
  }

  // ── Agente de escalación — corre en paralelo con la clasificación ──
  const effectiveState = isTemplateReply ? 'interested' : currentState;
  const [escalationResult, intentResult] = await Promise.all([
    orchestrator.checkEscalation(userMessage, history, effectiveState, orgId),
    (currentState === 'collecting_order')
      ? Promise.resolve(null)
      : orchestrator.classifyIntent(userMessage, history, effectiveState, { hasActiveOrder: !!activeOrder, activeOrderSummary }),
  ]);

  L.escalation(escalationResult.escalate, escalationResult.urgency, escalationResult.reason);

  // Si el agente de escalación detecta que se necesita humano
  if (escalationResult.escalate) {
    console.log(`[Pipeline] 🚨 Escalación detectada (${escalationResult.urgency}): ${escalationResult.reason}`);
    await db.setAgentMode(conversationId, 'human');
    await db.setLastEscalation(conversationId, userMessage, escalationResult.reason);
    await db.updatePipelineState(conversationId, currentState); // mantiene el estado actual

    // Acuse honesto: no prometer "ya te atienden" — el equipo puede tardar.
    // El webhook envía este texto y, si nadie responde, manda un recordatorio
    // (ver escalation-watch.js).
    const escalationMessages = {
      high: 'Entiendo, y lo siento por la molestia 🙏 Le paso tu caso al equipo para que lo revise personalmente y te respondan por aquí mismo.',
      medium: 'Esto lo tiene que ver alguien del equipo. Ya se lo pasé y te escriben por aquí en cuanto lo revisen 🙏',
      low: 'Déjame consultarlo con el equipo y te confirmo por aquí 🙏',
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
    return await handleOrderCollection(orgId, conversationId, conversation, userMessage, history, orderDraft, productosTexto, orderCtx);
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

  // ── "¿A qué hora llega mi pedido?" / "¿ya viene?" ──────────────────────
  // Con un pedido activo, el bot responde con el DATO REAL (estado del pedido +
  // ventana de reparto configurada) en vez de inventar una hora o prometer
  // "le consulto al equipo" y dejar al cliente esperando.
  const DELIVERY_STATUS_PATTERNS = [
    /(a\s+qu[eé]\s+hora|qu[eé]\s+hora|en\s+qu[eé]\s+horario|qu[eé]\s+horario|horario\s+de\s+(entrega|reparto|despacho))\b/i,
    /\bcu[aá]ndo\b.{0,25}\b(llega|lleg[aá]|entregan?|entrega|despachan?|sale|viene|reparten)\b/i,
    /\b(ya\s+)?(va\s+en\s+camino|est[aá]\s+en\s+camino|en\s+ruta|va\s+en\s+ruta|salió\s+(mi|el)|despacharon|lo\s+mandaron|lo\s+enviaron)\b/i,
    /\b(hoy|ma[ñn]ana)\b.{0,20}\b(llega|entregan?|reparten|despachan?|lo\s+traen)\b/i,
    /\b(mi|el)\s+pedido\b.{0,30}\b(llega|viene|hora|cu[aá]ndo|en\s+camino|ruta)\b/i,
    /\bpara\s+cu[aá]ndo\s+(lo\s+)?(tengo|llega|entregan)\b/i,
  ];
  if (activeOrder && userMessage.length <= 160
      && intent !== 'modify_order' && intent !== 'cancel_order'
      && DELIVERY_STATUS_PATTERNS.some(p => p.test(userMessage))) {
    const first = (conversation.contact_name || activeOrder.customer_name || '').trim().split(/\s+/)[0] || '';
    const hi = first ? ` ${first}` : '';
    const win = deliverySchedule ? ` La entrega es ${deliverySchedule}.` : '';
    // Fecha programada (reprogramado / agendado a futuro)
    let schedFuture = null;
    try {
      if (activeOrder.delivery_date) {
        const dd = new Date(activeOrder.delivery_date);
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
        const ddStr = new Date(activeOrder.delivery_date).toISOString().slice(0, 10);
        if (ddStr > todayStr) schedFuture = formatDateEs(activeOrder.delivery_date);
      }
    } catch (_) {}

    let response;
    if (schedFuture) {
      response = `Tu pedido quedó agendado para el ${schedFuture} 📅.${win} Ese día te avisamos cuando vaya saliendo. ¿Algo más?`;
    } else if (activeOrder.status === 'en_camino') {
      response = `¡Tu pedido va en la ruta de hoy${hi}! 🚚${win} No te puedo dar una hora exacta porque depende del orden del recorrido, pero apenas el repartidor vaya llegando te avisamos. 😊`;
    } else if (activeOrder.status === 'por_despachar') {
      response = `Tu pedido está listo para salir${hi} 📦.${win} Hoy te llega dentro de ese horario; cuando salga a la ruta te avisamos. 😊`;
    } else {
      // draft / nuevo / sent / payment_received → aún en preparación
      response = `Tu pedido está en preparación${hi} 😊.${win} Sale en el próximo reparto y te avisamos apenas vaya en camino.`;
    }
    L.agent('orchestrator', 0);
    L.step('delivery_status', `pedido #${activeOrder.id} estado ${activeOrder.status}`);
    return { response, agentType: 'orchestrator', newState: currentState };
  }

  // ── Preferencia / restricción de horario de entrega ────────────────────
  // "a las 15:00", "no tan tarde", "temprano", "tengo restricción de horario",
  // "déjenlo en conserjería". Con un pedido activo, el bot lo ANOTA en el
  // pedido y te avisa, en vez de deflectar con "el equipo coordina" (que
  // obligaba a coordinar todo a mano) o de decir "pedido actualizado" en falso.
  const DELIVERY_PREF_PATTERNS = [
    /\ba\s+las?\s*\d{1,2}([:.]\d{2})?\s*(hrs?|horas?|am|pm|de la (ma[ñn]ana|tarde|noche))?\b/i,
    /\b\d{1,2}[:.]\d{2}\b/,
    /\b(antes|despu[eé]s)\s+de\s+las?\s*\d{1,2}/i,
    /\bentre\s+las?\s*\d{1,2}\s*(y|a)\s*(las?\s*)?\d{1,2}/i,
    /\bno\s+tan\s+(tarde|temprano)\b/i,
    /\b(m[aá]s\s+)?(temprano|tempranito)\b/i,
    /\b(en|por)\s+la\s+(ma[ñn]ana|tarde|noche)\b/i,
    /\b(al\s+)?mediod[ií]a\b/i,
    /\btengo\s+(una\s+)?restricci[oó]n\b/i,
    /\brestricci[oó]n\s+de\s+horario\b/i,
    /\b(d[eé]jalo|d[eé]jenlo|dejar|entregar|toca(r)?|timbre|conserjer[ií]a|port[oó]n|reja)\b.{0,30}\b(timbre|conserjer[ií]a|port[oó]n|reja|vecin|casa|depto|departamento)\b/i,
  ];
  // No confundir con cambiar productos o cancelar: esas van por su propio flujo.
  const looksLikeProductChange = /\b(agrega|añade|anade|quita|saca|cambia|otra|otro|m[aá]s|bandeja|caja|docena|talla|xl|jumbo|huevos?|aceitunas?)\b/i.test(userMessage);
  const looksLikeCancel = ordersAgent.isCancelDuringCollection(userMessage) || intent === 'cancel_order';
  const isDeliveryPref = activeOrder
    && EDITABLE_OR_ACTIVE(activeOrder.status)
    && userMessage.length <= 160
    && !looksLikeProductChange
    && !looksLikeCancel
    && DELIVERY_PREF_PATTERNS.some(p => p.test(userMessage));

  if (isDeliveryPref) {
    const pref = userMessage.trim().slice(0, 200);
    const first = (conversation.contact_name || activeOrder.customer_name || '').trim().split(/\s+/)[0] || '';
    const hi = first ? ` ${first}` : '';
    try {
      const stamp = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });
      await getPool().query(
        `UPDATE orders
            SET delivery_note = $1,
                notes = COALESCE(notes, '') || $2,
                updated_at = NOW()
          WHERE id = $3 AND organization_id = $4`,
        [pref, `\n[bot] Preferencia de horario del cliente (${stamp}): "${pref}"`, activeOrder.id, orgId]
      ).catch(() => {});
    } catch (e) { console.warn('[Pipeline] no se pudo anotar preferencia de horario:', e.message); }
    L.agent('orders', 0);
    L.step('delivery_pref', `pedido #${activeOrder.id}: "${pref}"`);
    return {
      response: `¡Anotado${hi}! 📝 Le paso al equipo tu preferencia para la entrega ("${pref}") y lo tienen en cuenta al coordinar el despacho. ¿Algo más?`,
      agentType: 'orders',
      newState: currentState,
      adminNotice: `🕒 *Preferencia de entrega* — ${conversation.contact_name || activeOrder.customer_name || conversation.phone_number}, pedido #${activeOrder.id}: "${pref}"`,
    };
  }

  // ── Modificar / cancelar un pedido ya registrado ───────────────────
  // Editable mientras no salió a reparto. Si ya está por despachar o en
  // camino, se avisa al equipo (con acuse al cliente) en vez de tocarlo.
  const EDITABLE = ['draft', 'nuevo', 'sent', 'payment_received'];
  if ((intent === 'cancel_order' || intent === 'modify_order') && activeOrder) {
    const editable = EDITABLE.includes(activeOrder.status);
    const orderItemsText = (() => {
      try {
        const its = typeof activeOrder.items === 'string' ? JSON.parse(activeOrder.items) : activeOrder.items;
        return Array.isArray(its) ? its.map(i => `${i.quantity || 1}x ${i.name || i.title || ''}`).join(', ') : '';
      } catch { return ''; }
    })();

    if (!editable) {
      const verb = intent === 'cancel_order' ? 'cancelar' : 'cambiar';
      L.step(intent, `pedido ${activeOrder.id} en estado ${activeOrder.status} — no editable, se avisa al equipo`);
      return {
        response: `Tu pedido ya salió a reparto, así que no lo puedo ${verb} desde aquí 😕 Le aviso al equipo ahora mismo para ver qué se puede hacer y te confirman por este chat 🙏`,
        agentType: 'orders',
        newState: currentState,
        switchToHuman: true,
        escalationReason: `Cliente quiere ${verb} el pedido #${activeOrder.id} (${orderItemsText}) que ya está ${activeOrder.status}`,
      };
    }

    if (intent === 'cancel_order') {
      await db.updateOrder(activeOrder.id, { status: 'cancelled', updated_at: new Date() });
      await db.updatePipelineState(conversationId, 'exploring', {});
      L.step('cancel_order', `pedido ${activeOrder.id} cancelado por el cliente`);
      return {
        response: `Listo, cancelé tu pedido${orderItemsText ? ` (${orderItemsText})` : ''} ✅ Si más adelante quieres pedir de nuevo, aquí estoy 😊`,
        agentType: 'orders',
        newState: 'exploring',
        orderCancelled: { orderId: activeOrder.id },
      };
    }

    // modify_order → volver a recopilar sobre el pedido existente
    let addr = {};
    try { addr = typeof activeOrder.shipping_address === 'string' ? JSON.parse(activeOrder.shipping_address) : (activeOrder.shipping_address || {}); } catch { addr = {}; }
    let items = [];
    try {
      const its = typeof activeOrder.items === 'string' ? JSON.parse(activeOrder.items) : activeOrder.items;
      items = (Array.isArray(its) ? its : []).filter(i => i && !i._deliveryExtra)
        .map(i => ({ product_name: i.name || i.title || i.product_name, quantity: parseInt(i.quantity, 10) || 1 }));
    } catch { items = []; }
    const editDraft = {
      editing_order_id: activeOrder.id,
      customer_name: activeOrder.customer_name || undefined,
      address: addr.address || addr.address1 || undefined,
      city:    addr.city || undefined,
      items,
    };
    Object.keys(editDraft).forEach(k => editDraft[k] === undefined && delete editDraft[k]);
    L.step('modify_order', `editando pedido ${activeOrder.id}`);
    L.agent('orders', 0);
    return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, editDraft, productosTexto, orderCtx);
  }

  // ── Pedido futuro: el cliente quiere pedir para después ────────────
  // Detectar ANTES del mapeo normal. Solo aplica cuando el cliente muestra
  // intención de compra pero indica una fecha futura.
  const BUY_INTENTS = ['wants_to_order', 'interested', 'exploring'];

  // ── ¿La respuesta de ventas debe pasar al agente de pedidos? ─────────────
  // Sí cuando usa una frase de cierre (diseño original) Y TAMBIÉN cuando le
  // afirma al cliente que el pedido "queda registrado" sin que exista: ese
  // texto nunca se envía; se delega a handleOrderCollection, que crea el
  // pedido si hay datos o pide lo que falta. No aplica si el cliente está
  // preguntando por el estado de un pedido que ya tiene.
  const isStatusQuestion = /c[oó]mo\s+va|cu[aá]ndo\s+(llega|viene|sale|lo\s+mandan)|estado\s+de\s+mi\s+pedido|ya\s+(lo\s+)?(mandaron|enviaron|sali[oó]|despacharon)|d[oó]nde\s+(viene|est[aá])\s+mi\s+pedido/iu.test(userMessage);
  const recentActiveOrder = !!activeOrder && (Date.now() - new Date(activeOrder.created_at || 0).getTime()) < 24 * 3600 * 1000;
  const goesToOrders = (txt) => {
    if (salesAgent.isReadyToOrder(txt)) return true;
    if (BUY_INTENTS.includes(intent) && !isStatusQuestion && !recentActiveOrder && ordersAgent.claimsRegistered(txt)) {
      console.warn(`[Pipeline] ⚠️  Ventas afirmó "pedido registrado" sin pedido — delegando al agente de pedidos (conv ${conversationId})`);
      return true;
    }
    return false;
  };

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
    if (goesToOrders(salesResponse)) {
      // Igual que en los otros caminos: el agente de pedidos toma el turno con
      // los datos conocidos, en vez de mandar el texto de ventas tal cual.
      L.agent('orders', Date.now() - tDel);
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto, orderCtx);
    }
    await db.updatePipelineState(conversationId, effectiveState, undefined);
    L.agent('sales', Date.now() - tDel);
    return { response: salesResponse, agentType: 'sales', newState: effectiveState };
  }

  // El cliente quiere hablar con humano — salvo si ya detectamos bucle de escalación
  if (intent === 'human_request' && !escalationResult.loopDetected) {
    await db.setAgentMode(conversationId, 'human');
    await db.updatePipelineState(conversationId, 'exploring');
    L.agent('orchestrator', 0);
    return {
      response: '¡Claro! Le aviso al equipo para que te atienda una persona. Te escriben por aquí mismo en cuanto puedan 🙏',
      agentType: 'orchestrator',
      newState: 'exploring',
      switchToHuman: true,
    };
  }

  // Lead caliente (respuesta a template) o cliente quiere ordenar → Agente de ventas en modo warm
  if (isTemplateReply || intent === 'wants_to_order' || (intent === 'interested' && confidence > 0.85)) {
    const tWarm = Date.now();
    const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
    let newState = goesToOrders(salesResponse) ? 'collecting_order' : 'interested';

    // Safety net: si el bot mandó la URL de la tienda pero el cliente quería comprar,
    // forzar collecting_order — el agente de ventas no debía mandar un link aquí
    const hasShopUrl = tiendaUrl && salesResponse.includes(tiendaUrl);
    const hasShopifyUrl = shop && salesResponse.includes(shop);
    if ((hasShopUrl || hasShopifyUrl) && (intent === 'wants_to_order' || isTemplateReply)) {
      console.warn('[Pipeline] ⚠️  Agente mandó URL de tienda al cerrar venta — forzando collecting_order');
      // Delegar a handleOrderCollection para que pre-llene los datos del cliente
      L.agent('orders', Date.now() - tWarm);
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto, orderCtx);
    }

    // Si el agente de ventas decidió pasar a pedido, delegar a handleOrderCollection en lugar
    // de usar su respuesta genérica — así el bot pre-llena datos conocidos y no repregunta el nombre
    if (newState === 'collecting_order') {
      L.agent('orders', Date.now() - tWarm);
      return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto, orderCtx);
    }

    await db.updatePipelineState(conversationId, newState, undefined);
    L.agent('sales', Date.now() - tWarm);
    return { response: salesResponse, agentType: 'sales', newState };
  }

  // Interés, objeción, exploración, delivery, soporte → Agente de ventas
  const tGen = Date.now();
  const salesResponse = await salesAgent.generateSalesResponse(history, userMessage, productosTexto, storeCustomPrompt, salesOpts);
  const finalState = goesToOrders(salesResponse) ? 'collecting_order' : (intent === 'interested' ? 'interested' : effectiveState);
  if (finalState === 'collecting_order') {
    L.agent('orders', Date.now() - tGen);
    return handleOrderCollection(orgId, conversationId, conversation, userMessage, history, {}, productosTexto, orderCtx);
  }
  await db.updatePipelineState(conversationId, finalState, undefined);
  L.agent('sales', Date.now() - tGen);
  return { response: salesResponse, agentType: 'sales', newState: finalState };
}

/**
 * Reclamo de entrega incompleta. Extrae con Haiku qué pidió vs qué recibió,
 * valida contra el pedido entregado y el catálogo, y crea el pedido de las
 * unidades faltantes para el próximo reparto (mañana).
 *
 * @returns {object|null} resultado del pipeline, o null si no se pudo resolver
 */
async function handlePartialDelivery(orgId, conversationId, conversation, userMessage, history, delivered, orderCtx, L) {
  const { products = [], specialPrices = {} } = orderCtx || {};
  let deliveredItems = [];
  try {
    const its = typeof delivered.items === 'string' ? JSON.parse(delivered.items) : delivered.items;
    deliveredItems = (Array.isArray(its) ? its : []).map(i => ({ name: i.name || i.title || i.product_name, quantity: Number(i.quantity) || 0 }));
  } catch { deliveredItems = []; }
  if (!deliveredItems.length) return null;

  // 1. Entender cantidades: qué dice el cliente que pidió y qué recibió
  const Anthropic = require('@anthropic-ai/sdk');
  const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const recent = history.slice(-8).map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n');
  const deliveredText = deliveredItems.map(i => `${i.quantity}x ${i.name}`).join(', ');
  let claim = null;
  try {
    const resp = await aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `El cliente reclama que su entrega llegó incompleta. Lo que el sistema registra como ENTREGADO: ${deliveredText}.
Lee la conversación y devuelve SOLO un JSON: {"items":[{"product_name":"<nombre del producto tal como está en lo entregado>","ordered":N,"received":N}],"confident":true|false}
- "ordered" es lo que el cliente dice que pidió; "received" lo que dice que le llegó (si no lo dice, usa la cantidad entregada registrada).
- Si no queda claro cuántas unidades faltan, devuelve "confident": false.
- Solo el JSON.`,
      messages: [{ role: 'user', content: `Conversación:\n${recent}\n\nÚltimo mensaje del cliente: "${userMessage}"` }],
    });
    claim = JSON.parse((resp.content[0]?.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null');
  } catch (e) {
    console.warn('[Pipeline] faltante: extracción falló:', e.message);
    return null;
  }
  if (!claim || claim.confident === false || !Array.isArray(claim.items) || !claim.items.length) return null;

  // 2. Calcular faltantes y validarlos (producto real, cantidades razonables)
  const missing = [];
  for (const c of claim.items) {
    const ordered  = parseInt(c.ordered, 10);
    const known    = deliveredItems.find(d => pricing.matchProduct(c.product_name || '', pricing.flattenCatalog([{ id: 'x', title: d.name, priceMin: 0 }])));
    const received = Number.isFinite(parseInt(c.received, 10)) ? parseInt(c.received, 10) : (known?.quantity ?? 0);
    const diff = ordered - received;
    if (!Number.isFinite(ordered) || diff <= 0 || diff > 20) continue;
    missing.push({ product_name: known?.name || c.product_name, quantity: diff, ordered, received });
  }
  if (!missing.length) return null;

  // 3. Valorizar con el catálogo (mismo precio que el pedido original si coincide el producto)
  const priced = pricing.priceItems(missing, products, { specialPrices });
  if (!priced.items.length || priced.items.some(it => !it.matched)) return null;
  for (const it of priced.items) {
    const orig = deliveredItems.find(d => d.name === it.name);
    // si el pedido original traía precio unitario, respetarlo
    const origPriced = (() => { try { const its = typeof delivered.items === 'string' ? JSON.parse(delivered.items) : delivered.items; return its.find(x => (x.name || x.title) === it.name && Number(x.price) > 0); } catch { return null; } })();
    if (origPriced) it.price = Number(origPriced.price);
    void orig;
  }
  const total = priced.items.reduce((s, it) => s + it.price * it.quantity, 0);

  // 4. Crear el pedido de lo que falta para el próximo reparto (mañana)
  let addr = {};
  try { addr = typeof delivered.shipping_address === 'string' ? JSON.parse(delivered.shipping_address) : (delivered.shipping_address || {}); } catch { addr = {}; }
  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowISO = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const label = `#${delivered.id}`;
  const summaryText = missing.map(m => `${m.quantity}x ${m.product_name}`).join(', ');
  const noteText = `Faltante del pedido ${label}: el cliente pidió ${missing.map(m => `${m.ordered} ${m.product_name}`).join(', ')} y recibió ${missing.map(m => m.received).join(', ')}. Registrado por el bot.`;

  let order;
  try {
    order = await db.createOrder({
      conversationId,
      organizationId: orgId,
      items: priced.items.map(it => ({ name: it.name, title: it.name, quantity: it.quantity, price: it.price, product_id: it.product_id || null, variant_id: it.variant_id || null })),
      customerName:  delivered.customer_name,
      customerPhone: delivered.customer_phone || conversation.phone_number,
      shippingAddress: { address: addr.address || addr.address1 || '', city: addr.city || '' },
      totalPrice: total,
      status: 'por_despachar',
    });
    await db.updateOrder(order.id, { delivery_date: tomorrowISO, delivery_note: `Faltante de ${label}`, notes: noteText, updated_at: new Date() });
  } catch (e) {
    console.error('[Pipeline] faltante: no se pudo crear el pedido:', e.message);
    return null;
  }

  L.step('faltante', `pedido ${order.id} por ${summaryText} (falta de ${label})`);
  const [y, m, d] = tomorrowISO.split('-');
  const first = (delivered.customer_name || '').split(' ')[0];
  return {
    response: `Tienes razón${first ? `, ${first}` : ''} 🙏 Te ${missing.reduce((s, x) => s + x.quantity, 0) === 1 ? 'faltó' : 'faltaron'} ${summaryText}. Ya lo dejé registrado para el próximo reparto (${d}/${m}) y el equipo te confirma la hora por aquí. Disculpa la molestia.`,
    agentType: 'orders',
    newState: 'exploring',
    orderCreated: { orderId: order.id },
    adminNotice: `⚠️ *Entrega incompleta* — ${delivered.customer_name || conversation.phone_number} reclama que del pedido ${label} le faltó ${summaryText}.\nEl bot creó el pedido #${order.id} (${summaryText}, $${Math.round(total).toLocaleString('es-CL')}) para el ${d}/${m}. Revísalo en Pedidos: si no corresponde, cancélalo.`,
  };
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
 * Maneja la recopilación de datos para el pedido.
 *
 * El borrador lleva `items: [{product_name, quantity}]` (varios productos).
 * Los precios NO vienen del modelo: cada turno se valoriza el carrito contra
 * el catálogo (order-pricing.js) y el total se calcula en código. Si el
 * borrador trae `editing_order_id`, al confirmar se ACTUALIZA ese pedido en
 * vez de crear uno nuevo.
 *
 * @param {object} orderCtx — { products, specialPrices, isLead }
 */
async function handleOrderCollection(orgId, conversationId, conversation, userMessage, history, orderDraft, productosTexto, orderCtx = {}) {
  const { products = [], specialPrices = {}, isLead = false } = orderCtx;
  orderDraft = pricing.normalizeDraft(orderDraft || {});

  // 0a. ¿Se arrepintió a mitad del pedido? Antes el estado quedaba pegado en
  //     collecting_order para siempre y cada mensaje iba al agente de pedidos.
  if (ordersAgent.isCancelDuringCollection(userMessage)) {
    await db.updatePipelineState(conversationId, 'exploring', {});
    const msg = orderDraft.editing_order_id
      ? 'Entendido, dejo tu pedido tal como estaba 😊 ¿Te ayudo con algo más?'
      : 'Entendido, no hay problema 😊 Si más adelante quieres pedir, aquí estoy.';
    return { response: msg, agentType: 'orders', newState: 'exploring' };
  }

  // 0b. Siempre fusionar datos del cliente desde CRM/Shopify — no solo la primera vez.
  try {
    const ds    = await db.getPrimaryDataSource(orgId);
    const known = await getKnownCustomerData(orgId, conversation.phone_number, ds);
    if (Object.keys(known).length > 0) {
      for (const [key, val] of Object.entries(known)) {
        if (val && !orderDraft[key]) orderDraft[key] = val;
      }
      const fuente = known.found_in_shopify ? 'Shopify' : 'historial CRM';
      console.log(`[Pipeline] Datos del cliente fusionados desde ${fuente}: ${known.customer_name || '?'}`);
    }
  } catch (e) {
    console.warn('[Pipeline] Error fusionando datos del cliente:', e.message);
  }

  // 1. Extraer datos del historial y actualizar el draft.
  //    Si se está editando un pedido, el extractor necesita saber qué había
  //    registrado (el pedido pudo crearse hace días, fuera de los últimos 20
  //    mensajes) para que "agrégame 2 más" parta de la lista real.
  let extractHistory = history;
  if (orderDraft.editing_order_id && orderDraft.items?.length) {
    const base = orderDraft.items.map(i => `${i.quantity}x ${i.product_name || i.name}`).join(', ');
    extractHistory = [
      { direction: 'outbound', content: `[Sistema] Pedido registrado actualmente: ${base}. El cliente quiere modificarlo: la lista final de items debe partir de este pedido y aplicar solo los cambios que pida.` },
      ...history,
    ];
  }
  const updatedDraft = await ordersAgent.extractOrderData(extractHistory, orderDraft);

  // 1a. Valorizar el carrito contra el catálogo. El descuento solo aplica a
  //     leads (es la escalera de bienvenida del prompt de ventas); para
  //     clientes existentes cualquier descuento lo maneja el equipo.
  const priced = pricing.priceItems(updatedDraft.items, products, {
    specialPrices,
    discountPct: isLead ? updatedDraft.discount_pct : 0,
  });
  updatedDraft.items    = priced.items;
  updatedDraft.subtotal = priced.subtotal;
  updatedDraft.discount_pct = priced.discountPct;
  updatedDraft.discount_amount = priced.discountAmount;
  updatedDraft.total    = priced.total;
  if (priced.unmatched.length) console.log(`[Pipeline] 🛒 Ítems sin match en catálogo: ${priced.unmatched.join(' | ')}`);
  await db.updatePipelineState(conversationId, 'collecting_order', updatedDraft);

  // 1b. Si el cliente acaba de dar dirección o ciudad que no teníamos → guardar en contacts.
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

  // 2. Respuesta del agente de órdenes (con el carrito valorizado en el prompt)
  const pricingText   = pricing.pricingContext(priced);
  const agentResponse = await ordersAgent.generateOrderResponse(history, userMessage, updatedDraft, productosTexto, pricingText);

  // 3. ¿Confirmó?
  //    REGLA DURA: si el modelo le dice al cliente "tu pedido queda
  //    registrado" / "todo listo" sin emitir ORDEN_CONFIRMADA, ese texto NO
  //    sale. Se trata como confirmación: con datos completos se crea el pedido
  //    de verdad (y el cliente recibe el resumen real); si falta algo, se pide.
  const claimed = ordersAgent.claimsRegistered(agentResponse);
  if (claimed) console.warn(`[Pipeline] ⚠️  El agente afirmó "pedido registrado" sin ORDEN_CONFIRMADA — forzando cierre real (conv ${conversationId})`);
  const confirmed = ordersAgent.isOrderConfirmed(agentResponse, userMessage, updatedDraft) || claimed;
  const allMatched = priced.items.length > 0 && priced.items.every(it => it.matched);

  if (confirmed && ordersAgent.hasRequiredData(updatedDraft) && allMatched) {
    const itemsForDb = priced.items.map(it => ({
      name: it.name, title: it.name, quantity: it.quantity, price: it.price,
      product_id: it.product_id || null, variant_id: it.variant_id || null,
    }));
    const shippingAddress = { address: updatedDraft.address, city: updatedDraft.city };
    const summary = pricing.summaryBlock(priced);
    const who = `👤 ${updatedDraft.customer_name}\n📍 ${updatedDraft.address}, ${updatedDraft.city}`;

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

    // ── Edición de un pedido existente ─────────────────────────────
    if (updatedDraft.editing_order_id) {
      const orderId = updatedDraft.editing_order_id;
      try {
        const updated = await db.updateOrder(orderId, {
          items: JSON.stringify(itemsForDb),
          total_price: priced.total,
          customer_name: updatedDraft.customer_name,
          shipping_address: JSON.stringify(shippingAddress),
          customer_modified: true,
          updated_at: new Date(),
        });
        // Dejar rastro en las notas del pedido (el CRM muestra la marca "modificado por el cliente")
        getPool().query(
          `UPDATE orders SET notes = COALESCE(notes, '') || $1 WHERE id = $2`,
          [`\n[bot] Modificado por el cliente por WhatsApp (${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })})`, orderId]
        ).catch(() => {});
        saveContact();
        await db.updatePipelineState(conversationId, 'done', updatedDraft);
        console.log(`[Pipeline] ✏️ Pedido ${orderId} modificado por el cliente`);
        const msg = `✅ ¡Pedido actualizado!\n\n${summary}\n${who}\n\n¡Te avisamos cuando esté en camino! 🚀`;
        return {
          response: msg, agentType: 'orders', newState: 'confirmed',
          orderUpdated: { orderId, shopifyDraftId: updated?.shopify_draft_id || null },
        };
      } catch (err) {
        console.error('[Pipeline] ❌ Error modificando pedido:', err.message);
        await db.setAgentMode(conversationId, 'human');
        return {
          response: `Recibí los cambios 📝 pero hubo un problema técnico al actualizar tu pedido 😔 Se lo paso al equipo para que lo corrija y te confirmen por aquí.`,
          agentType: 'orders', newState: 'collecting_order', switchToHuman: true,
          escalationReason: `Error actualizando pedido #${orderId}: ${err.message}`,
        };
      }
    }

    // ── Lock atómico anti-duplicado ────────────────────────────────
    const claimed = await db.claimOrderCreation(conversationId);
    if (!claimed) {
      console.warn(`[Pipeline] ⚠️  Pedido duplicado bloqueado para conv ${conversationId}`);
      return { response: null, agentType: 'orders', newState: 'confirmed', duplicate: true };
    }

    const paymentMode = (await db.getSetting(orgId, 'payment_mode')) || 'cod';
    const techErrorMsg = `Recibí todos tus datos 📝\n\n${summary}\n\nHubo un problema técnico al registrar tu pedido 😔 Se lo paso al equipo para que lo confirme por aquí. ¡Gracias por tu paciencia!`;

    // ── COD: solo guardar en nuestra DB ────────────────────────────
    if (paymentMode === 'cod') {
      try {
        const order = await db.createOrder({
          conversationId,
          organizationId: orgId,
          items:           itemsForDb,
          customerName:    updatedDraft.customer_name,
          customerPhone:   updatedDraft.customer_phone || conversation.phone_number,
          shippingAddress,
          totalPrice:      priced.total,
        });
        if (updatedDraft.notes) db.updateOrder(order.id, { notes: updatedDraft.notes }).catch(() => {});
        saveContact();
        await db.updatePipelineState(conversationId, 'done', updatedDraft);
        console.log(`[Pipeline] ✅ Pedido COD guardado en DB: ${order.id} (${itemsForDb.length} ítems, total ${priced.total})`);
        const successMsg = `✅ ¡Pedido confirmado!\n\n${summary}\n${who}\n\nEl pago es al momento del despacho. ¡Te avisamos cuando esté en camino! 🚀`;
        return { response: successMsg, agentType: 'orders', newState: 'confirmed', orderCreated: { orderId: order.id } };
      } catch (err) {
        console.error('[Pipeline] ❌ Error guardando pedido COD:', err.message);
        await db.setAgentMode(conversationId, 'human');
        return { response: techErrorMsg, agentType: 'orders', newState: 'collecting_order', switchToHuman: true, escalationReason: `Error creando pedido: ${err.message}` };
      }
    }

    // ── Link de pago: crear draft en Shopify + guardar en DB ───────
    try {
      const result = await createShopifyOrder(orgId, conversationId, { ...updatedDraft, items: itemsForDb, total: priced.total });
      saveContact();
      await db.updatePipelineState(conversationId, 'awaiting_payment', updatedDraft);
      const successMsg = `✅ ¡Pedido creado!\n\n${summary}\n👤 ${updatedDraft.customer_name}\n\n💳 Completa tu pago aquí:\n${result.invoiceUrl}\n\n¡Te avisamos cuando esté en camino! 🚀`;
      return { response: successMsg, agentType: 'orders', newState: 'awaiting_payment', orderCreated: result };
    } catch (err) {
      const status  = err.response?.status;
      const detail  = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[Pipeline] ❌ Error creando orden en Shopify (HTTP ${status || 'N/A'}):`, detail);
      if (status === 401 || detail?.includes('Invalid API key') || detail?.includes('access token')) {
        console.error('[Pipeline] ⚠️  Token de Shopify inválido — reconecta Shopify desde Ajustes del CRM.');
      }
      await db.setAgentMode(conversationId, 'human');
      return { response: techErrorMsg, agentType: 'orders', newState: 'collecting_order', switchToHuman: true, escalationReason: `Error creando orden Shopify: ${detail}` };
    }
  }

  // Confirmó pero hay ítems que no calzan con el catálogo → pedir aclaración (sin crear pedido)
  if (confirmed && ordersAgent.hasRequiredData(updatedDraft) && !allMatched) {
    const amb = priced.items.find(it => it.ambiguous);
    const dudosos = priced.items.filter(it => !it.matched && !it.ambiguous).map(it => it.name);
    const askMsg = amb
      ? `Casi listo 😊 Para "${amb.name}", ¿cuál prefieres: ${amb.alternatives.join(' o ')}?`
      : `Casi listo 😊 Solo necesito confirmar un producto: "${dudosos.join('", "')}" no lo encuentro tal cual en el catálogo. ¿Cuál de los productos de la lista es?`;
    return { response: askMsg, agentType: 'orders', newState: 'collecting_order' };
  }

  // Si la IA dijo ORDEN_CONFIRMADA pero faltan datos, pedirlos amablemente
  if (confirmed && !ordersAgent.hasRequiredData(updatedDraft)) {
    const missing = ordersAgent.missingFields(updatedDraft);
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
 * Crea la orden en Shopify vía GraphQL directo y la guarda en la DB local.
 * Acepta varios ítems; cada uno intenta resolverse a una variante de Shopify
 * (por variant_id si order-pricing lo encontró, si no por nombre) y cae a
 * custom line item con el precio ya calculado.
 */
async function createShopifyOrder(orgId, conversationId, draft) {
  const ds = await db.getPrimaryDataSource(orgId);
  if (!ds?.config?.accessToken) throw new Error('No hay tienda Shopify conectada. Reconecta desde Ajustes.');

  const conversation = await db.getConversationById(conversationId);
  const customerPhone = draft.customer_phone || conversation.phone_number;

  const items = Array.isArray(draft.items) && draft.items.length
    ? draft.items
    : [{ name: draft.product_name, quantity: parseInt(draft.quantity) || 1, price: draft.price || 0 }];

  const lineItems = [];
  for (const it of items) {
    let variantId = it.variant_id || null;
    let price = it.price || null;
    if (!variantId) {
      const resolved = await resolveVariantId(ds, it.name || it.product_name);
      variantId = resolved.variantId;
      price = price || resolved.price;
    }
    if (!variantId) console.warn(`[Pipeline] ⚠️  Sin variantId para "${it.name}" — custom line item`);
    lineItems.push({ variantId, title: it.name || it.product_name, price: price || 0, quantity: parseInt(it.quantity) || 1 });
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
  const shopifyResult = await shopifyApi.createDraftOrder(
    shopDomain,
    shopToken,
    customer,
    lineItems,
    `WhatsApp CRM | Dir: ${draft.address}, ${draft.city} | Conv: ${conversationId}${draft.discount_pct ? ` | Desc. ${draft.discount_pct}%` : ''}`,
  );

  const order = await db.createOrder({
    conversationId,
    organizationId: orgId,
    items: items.map(it => ({ name: it.name || it.product_name, title: it.name || it.product_name, quantity: it.quantity, price: it.price, product_id: it.product_id || null, variant_id: it.variant_id || null })),
    customerName: draft.customer_name,
    customerPhone,
    shippingAddress: { address: draft.address, city: draft.city },
    totalPrice: shopifyResult.totalPrice || draft.total || null,
  });

  await db.updateOrder(order.id, {
    shopify_draft_id: shopifyResult.shopifyDraftId,
    invoice_url: shopifyResult.invoiceUrl,
    status: 'sent',
  });

  return shopifyResult;
}

module.exports = { processMessage };
