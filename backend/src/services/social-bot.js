const db = require('../db/database');
const shopifyApi = require('./shopify-api');
const salesAgent = require('./agents/sales');
const inboundPolicy = require('./inbound-message-policy');
const outboundPolicy = require('./outbound-text-policy');

async function publicCatalog(orgId) {
  const [source, cached, own, storeUrl] = await Promise.all([
    db.getSetting(orgId, 'catalog_source'),
    db.getCachedProducts(orgId).catch(() => []),
    db.getProducts(orgId, true).catch(() => []),
    db.getSetting(orgId, 'store_public_url').catch(() => null),
  ]);
  let products = [];
  if (source !== 'local' && cached?.length) {
    products = cached.filter(item => !item.is_business).map(item => {
      if (item.raw_json) {
        try { return JSON.parse(item.raw_json); } catch (_) { /* use normalized fields */ }
      }
      return {
        id: item.external_id, title: item.title, description: item.description,
        priceMin: Number(item.price) || 0, priceMax: Number(item.price) || 0,
        inventoryQuantity: item.inventory_quantity, imageUrl: item.image_url,
        productType: item.product_type, handle: item.handle,
      };
    });
  } else {
    products = (own || []).filter(item => !item.is_business).map(item => ({
      id: String(item.id), title: item.title, description: item.description,
      priceMin: Number(item.price) || 0, priceMax: Number(item.price) || 0,
      compare_price: item.compare_price ?? null, bulk_price: item.bulk_price ?? null,
      bulk_min_qty: item.bulk_min_qty ?? null, inventoryQuantity: item.stock ?? null,
      imageUrl: item.image_url || null, handle: item.handle,
      productType: item.category || '',
    }));
  }
  return shopifyApi.formatProductsForAI(products, null, storeUrl || null);
}

async function generateSocialReply({ orgId, channel, content, history = [], authorName = null }) {
  const message = String(content || '').trim().slice(0, 4000);
  if (!message) return { skipped: true, reason: 'EMPTY' };
  try {
    await require('./commercial').consumeBotTurn(orgId);
  } catch (error) {
    if ([403, 429].includes(error.status)) return { skipped: true, reason: error.code || 'COMMERCIAL_ACCESS' };
    throw error;
  }

  const [catalog, storeContext, extraPrompt, deliveryRaw, storeUrl] = await Promise.all([
    publicCatalog(orgId),
    db.getSetting(orgId, 'store_context').catch(() => ''),
    db.getSetting(orgId, 'ai_system_prompt_extra').catch(() => ''),
    db.getSetting(orgId, 'delivery_info').catch(() => ''),
    db.getSetting(orgId, 'store_public_url').catch(() => ''),
  ]);
  let delivery = '';
  try {
    const parsed = deliveryRaw ? JSON.parse(deliveryRaw) : null;
    if (parsed) delivery = [parsed.schedule && `Horario: ${parsed.schedule}`, parsed.zone && `Zona: ${parsed.zone}`, parsed.minimum && `Pedido mínimo: ${parsed.minimum}`, parsed.paymentMethods && `Pagos: ${parsed.paymentMethods}`].filter(Boolean).join('\n');
  } catch { /* setting inválido: no inventar */ }

  const isComment = channel.endsWith('_comment') || channel === 'comment';
  const channelRules = isComment
    ? `Estás respondiendo un comentario público de ${channel.startsWith('instagram') ? 'Instagram' : 'Facebook'}.
- Responde en una o dos frases, únicamente lo preguntado.
- Nunca publiques datos personales, bancarios, de pedidos ni información interna.
- No tomes pedidos ni pidas teléfono, dirección o nombre en público. Si quiere comprar o requiere datos privados, invítalo a escribir por mensaje directo${storeUrl ? ` o visitar ${storeUrl}` : ''}.
- No prometas enviar un mensaje privado por iniciativa propia.`
    : `Estás respondiendo un mensaje privado de ${channel === 'instagram' ? 'Instagram' : 'Facebook'}.
- Responde la pregunta comercial usando solo el catálogo y la información confirmada.
- Si la persona quiere comprar, indícale que puede completar el pedido en este mismo chat${storeUrl ? ` o visitar ${storeUrl}` : ''}.
- Esta respuesta simple no confirma pedidos: el pipeline CRM privado recopila los datos y emite la confirmación real.`;
  const customPrompt = [storeContext, extraPrompt, delivery && `Información confirmada de entrega:\n${delivery}`, channelRules]
    .filter(Boolean).join('\n\n');
  let response = await salesAgent.generateSalesResponse(history, message, catalog, customPrompt, {
    customerName: authorName || '', intent: 'exploring',
  });
  if (inboundPolicy.isInternalSilenceResponse?.(response)) return { skipped: true, reason: 'NO_RESPONSE' };
  const checked = outboundPolicy.checkOutboundText(response);
  if (!checked.ok) return { skipped: true, reason: checked.reason || 'OUTBOUND_POLICY' };
  response = String(response || '').trim();
  if (!response) return { skipped: true, reason: 'EMPTY_RESPONSE' };
  return { response: response.slice(0, 1000), agentType: 'sales' };
}

module.exports = { generateSocialReply, _publicCatalog: publicCatalog };
