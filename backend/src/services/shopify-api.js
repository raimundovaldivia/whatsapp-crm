/**
 * shopify-api.js — Cliente directo a Shopify Admin GraphQL API
 *
 * Usa el access_token OAuth guardado en data_sources.config.accessToken.
 * No depende de raigentic. El token es permanente (offline token).
 *
 * Uso:
 *   const shopify = require('./shopify-api');
 *   const ds = await db.getPrimaryDataSource(orgId);
 *   const { shop, token } = shopify.credentialsFrom(ds);
 *   const products = await shopify.getProducts(shop, token, { limit: 50 });
 */

const axios = require('axios');

const API_VERSION = '2025-01';

// ─── Cliente base ───────────────────────────────────────────────

function graphqlClient(shop, token) {
  return axios.create({
    baseURL: `https://${shop}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

/**
 * Extrae shop y accessToken desde un data source row.
 * Lanza error si faltan credenciales.
 */
function credentialsFrom(ds) {
  if (!ds) throw new Error('No hay tienda Shopify conectada');
  const shop  = ds.config?.storeUrl;
  const token = ds.config?.accessToken;
  if (!shop)  throw new Error('Falta storeUrl en la conexión Shopify');
  if (!token) throw new Error('Falta accessToken — reconecta Shopify desde Ajustes');
  return { shop, token };
}

// ─── Productos ──────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          vendor
          productType
          status
          images(first: 1) { edges { node { url altText } } }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                sku
                availableForSale
                inventoryQuantity
              }
            }
          }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

/**
 * Obtiene productos de Shopify.
 * @param {string} shop
 * @param {string} token
 * @param {object} opts - { limit, cursor, search }
 */
async function getProducts(shop, token, opts = {}) {
  const { limit = 50, cursor = null, search = '' } = opts;
  const client = graphqlClient(shop, token);

  const variables = {
    first: Math.min(limit, 250),
    after: cursor || null,
    query: search ? `title:*${search}* OR product_type:*${search}*` : null,
  };

  const { data } = await client.post('/graphql.json', {
    query: PRODUCTS_QUERY,
    variables,
  });

  if (data.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors));

  const conn     = data.data.products;
  const products = conn.edges.map(({ node }) => ({
    id:          node.id,
    title:       node.title,
    handle:      node.handle,
    description: node.descriptionHtml?.replace(/<[^>]*>/g, '').slice(0, 300) || '',
    vendor:      node.vendor,
    productType: node.productType,
    status:      node.status,
    image:       node.images?.edges?.[0]?.node?.url || null,
    imageUrl:    node.images?.edges?.[0]?.node?.url || null,
    priceMin:    parseFloat(node.priceRangeV2?.minVariantPrice?.amount || 0),
    priceMax:    parseFloat(node.priceRangeV2?.maxVariantPrice?.amount || 0),
    currency:    node.priceRangeV2?.minVariantPrice?.currencyCode || 'CLP',
    variants:    node.variants?.edges?.map(({ node: v }) => ({
      id:        v.id,
      title:     v.title,
      price:     parseFloat(v.price || 0),
      compareAt: parseFloat(v.compareAtPrice || 0) || null,
      sku:       v.sku,
      available: v.availableForSale,
      stock:     v.inventoryQuantity,
    })) || [],
  }));

  return {
    success:     true,
    products,
    total:       products.length,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor:   conn.pageInfo.endCursor,
  };
}

/**
 * Descarga TODOS los productos paginando internamente.
 */
async function getAllProducts(shop, token) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let all = [], cursor = null, page = 0;

  while (true) {
    page++;
    const result = await getProducts(shop, token, { limit: 250, cursor });
    all = all.concat(result.products);
    if (!result.hasNextPage || page >= 20) break;
    cursor = result.endCursor;
    await sleep(200);
  }
  return all;
}

// ─── Clientes ───────────────────────────────────────────────────

const CUSTOMERS_QUERY = `
  query GetCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          numberOfOrders
          amountSpent { amount currencyCode }
          createdAt
          updatedAt
          defaultAddress {
            address1 city province country zip
          }
          tags
        }
      }
    }
  }
`;

/**
 * Obtiene clientes de Shopify.
 * @param {string} shop
 * @param {string} token
 * @param {object} opts - { limit, cursor, query }
 */
async function getCustomers(shop, token, opts = {}) {
  const { limit = 50, cursor = null, query = '' } = opts;
  const client = graphqlClient(shop, token);

  const { data } = await client.post('/graphql.json', {
    query:     CUSTOMERS_QUERY,
    variables: { first: Math.min(limit, 250), after: cursor || null, query: query || null },
  });

  if (data.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors));

  const conn      = data.data.customers;
  const customers = conn.edges.map(({ node }) => ({
    id:            node.id,
    firstName:     node.firstName,
    lastName:      node.lastName,
    name:          `${node.firstName || ''} ${node.lastName || ''}`.trim(),
    email:         node.email,
    phone:         node.phone,
    ordersCount:   node.numberOfOrders,
    totalSpent:    parseFloat(node.amountSpent?.amount || 0),
    currency:      node.amountSpent?.currencyCode || 'CLP',
    createdAt:     node.createdAt,
    updatedAt:     node.updatedAt,
    address:       node.defaultAddress || null,
    tags:          node.tags || [],
  }));

  return {
    success:     true,
    customers,
    total:       customers.length,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor:   conn.pageInfo.endCursor,
  };
}

/**
 * Descarga TODOS los clientes paginando internamente.
 */
async function getAllCustomers(shop, token, searchQuery = '') {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let all = [], cursor = null, page = 0;

  while (true) {
    page++;
    const result = await getCustomers(shop, token, { limit: 250, cursor, query: searchQuery });
    all = all.concat(result.customers);
    if (!result.hasNextPage || page >= 50) break; // máx 12.500 clientes
    cursor = result.endCursor;
    await sleep(300);
  }
  return all;
}

/**
 * Busca un cliente por teléfono.
 */
async function getCustomerByPhone(shop, token, phone) {
  try {
    const normalize = p => (p || '').replace(/\D/g, '').slice(-9);
    const target = normalize(phone);
    if (!target || target.length < 8) return null;

    const result = await getCustomers(shop, token, { limit: 10, query: `phone:${phone}` });
    const match  = result.customers.find(c => normalize(c.phone) === target);
    return match || result.customers[0] || null;
  } catch (err) {
    console.warn('[ShopifyAPI] getCustomerByPhone error:', err.message);
    return null;
  }
}

// ─── Órdenes ────────────────────────────────────────────────────

const ORDERS_QUERY = `
  query GetOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer {
            id firstName lastName email phone
          }
          shippingAddress {
            firstName lastName phone
          }
          billingAddress {
            firstName lastName phone
          }
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Obtiene órdenes de Shopify.
 * @param {string} shop
 * @param {string} token
 * @param {object} opts - { limit, cursor, status }
 */
async function getOrders(shop, token, opts = {}) {
  const { limit = 50, cursor = null, status = 'any' } = opts;
  const client = graphqlClient(shop, token);

  const query = status === 'any' ? null : `financial_status:${status}`;

  const { data } = await client.post('/graphql.json', {
    query:     ORDERS_QUERY,
    variables: { first: Math.min(limit, 250), after: cursor || null, query },
  });

  if (data.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors));

  const conn   = data.data.orders;
  const orders = conn.edges.map(({ node }) => ({
    id:                node.id,
    name:              node.name,
    createdAt:         node.createdAt,
    financialStatus:   node.displayFinancialStatus,
    fulfillmentStatus: node.displayFulfillmentStatus,
    totalPrice:        parseFloat(node.totalPriceSet?.shopMoney?.amount || 0),
    currency:          node.totalPriceSet?.shopMoney?.currencyCode || 'CLP',
    customer:          node.customer ? {
      id:        node.customer.id,
      name:      `${node.customer.firstName || ''} ${node.customer.lastName || ''}`.trim(),
      email:     node.customer.email,
      phone:     node.customer.phone,
    } : null,
    shippingAddress:   node.shippingAddress ? {
      firstName: node.shippingAddress.firstName,
      lastName:  node.shippingAddress.lastName,
      phone:     node.shippingAddress.phone,
    } : null,
    billingAddress:    node.billingAddress ? {
      firstName: node.billingAddress.firstName,
      lastName:  node.billingAddress.lastName,
      phone:     node.billingAddress.phone,
    } : null,
    items: node.lineItems?.edges?.map(({ node: li }) => ({
      title:    li.title,
      quantity: li.quantity,
      price:    parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || 0),
    })) || [],
  }));

  return {
    success:     true,
    orders,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor:   conn.pageInfo.endCursor,
  };
}

// ─── Draft Orders (crear pedido desde el bot) ───────────────────

const CREATE_DRAFT_ORDER_MUTATION = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
        totalPrice
        status
      }
      userErrors { field message }
    }
  }
`;

/**
 * Crea un Draft Order en Shopify y devuelve el link de pago.
 *
 * @param {string} shop
 * @param {string} token
 * @param {object} customer  - { name, phone, email? }
 * @param {Array}  items     - [{ variantId, quantity }]
 * @param {string} note      - nota opcional (ej: dirección)
 */
async function createDraftOrder(shop, token, customer, items, note = '') {
  const client = graphqlClient(shop, token);

  const input = {
    lineItems: items.map(item => {
      if (item.variantId) {
        // Producto Shopify real — linkea al catálogo
        return {
          variantId: item.variantId,
          quantity:  parseInt(item.quantity) || 1,
        };
      }
      // Custom line item — cuando no se encontró variantId por nombre
      return {
        title:             item.title || 'Producto',
        originalUnitPrice: String(parseFloat(item.price) || 0),
        quantity:          parseInt(item.quantity) || 1,
        requiresShipping:  true,
        taxable:           true,
      };
    }),
    note: note || undefined,
    shippingAddress: customer.address || undefined,
    email: customer.email || undefined,
    phone: customer.phone || undefined,
    customAttributes: [
      { key: 'whatsapp_crm', value: 'true' },
      { key: 'customer_name', value: customer.name || '' },
    ],
  };

  const { data } = await client.post('/graphql.json', {
    query:     CREATE_DRAFT_ORDER_MUTATION,
    variables: { input },
  });

  if (data.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors));

  const result     = data.data.draftOrderCreate;
  const userErrors = result.userErrors || [];
  if (userErrors.length) throw new Error('Error creando pedido: ' + userErrors.map(e => e.message).join(', '));

  const draft = result.draftOrder;
  return {
    success:     true,
    orderId:     draft.id,
    orderNumber: draft.name,
    invoiceUrl:  draft.invoiceUrl,
    totalPrice:  draft.totalPrice,
    status:      draft.status,
  };
}

// ─── Formato para el agente IA ──────────────────────────────────

/**
 * Formatea el catálogo para enviarlo al contexto del agente IA.
 * @param {Array} products
 * @param {string} shop
 */
function formatProductsForAI(products, shop = null) {
  if (!products?.length) return 'No hay productos disponibles en este momento.';

  return products.map(p => {
    const precio = p.priceMin === p.priceMax
      ? `$${Number(p.priceMin).toLocaleString('es-CL')}`
      : `$${Number(p.priceMin).toLocaleString('es-CL')} – $${Number(p.priceMax).toLocaleString('es-CL')}`;

    const productLink = shop && p.handle
      ? `  🔗 https://${shop}/products/${p.handle}`
      : '';

    const variantes = p.variants?.length > 0
      ? p.variants.map(v => {
          const stockInfo  = v.stock != null ? ` (stock: ${v.stock})` : '';
          const agotado    = v.available === false ? ' ❌ agotado' : '';
          return `  · ${v.title}: $${Number(v.price).toLocaleString('es-CL')}${stockInfo}${agotado}`;
        }).join('\n')
      : '';

    return [
      `• ${p.title} | ${precio}`,
      p.vendor      ? `  Marca: ${p.vendor}` : '',
      p.productType ? `  Categoría: ${p.productType}` : '',
      p.description ? `  ${p.description.slice(0, 250)}` : '',
      variantes,
      productLink,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

// ─── Información de la tienda (REST) ───────────────────────────

/** Quita etiquetas HTML y decodifica entidades básicas */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function restClient(shop, token) {
  return axios.create({
    baseURL: `https://${shop}/admin/api/${API_VERSION}`,
    headers: { 'X-Shopify-Access-Token': token },
    timeout: 20000,
  });
}

/**
 * Obtiene información básica de la tienda.
 * Incluye: nombre, email, descripción, dirección, moneda.
 */
async function getShopInfo(shop, token) {
  try {
    const res = await restClient(shop, token).get('/shop.json');
    const s = res.data?.shop || {};
    return {
      name:        s.name        || '',
      email:       s.email       || s.customer_email || '',
      description: s.description || '',
      address:     [s.address1, s.city, s.country].filter(Boolean).join(', '),
      phone:       s.phone       || '',
      currency:    s.currency    || '',
      domain:      s.myshopify_domain || shop,
    };
  } catch (e) {
    console.warn('[shopify-api] getShopInfo error:', e.message);
    return {};
  }
}

/**
 * Obtiene todas las páginas publicadas de la tienda (About, FAQ, etc.)
 * Retorna array de { title, content } con HTML ya limpiado.
 */
async function getPages(shop, token) {
  try {
    const res = await restClient(shop, token).get('/pages.json', {
      params: { limit: 50, published_status: 'published' },
    });
    return (res.data?.pages || []).map(p => ({
      title:   p.title || '',
      content: stripHtml(p.body_html || ''),
    })).filter(p => p.content.length > 20);
  } catch (e) {
    console.warn('[shopify-api] getPages error:', e.message);
    return [];
  }
}

/**
 * Obtiene las políticas de la tienda (envío, devolución, privacidad, etc.)
 * Retorna array de { title, content } con HTML limpiado.
 */
async function getPolicies(shop, token) {
  try {
    const res = await restClient(shop, token).get('/policies.json');
    return (res.data?.policies || []).map(p => ({
      title:   p.title || '',
      content: stripHtml(p.body || ''),
    })).filter(p => p.content.length > 20);
  } catch (e) {
    console.warn('[shopify-api] getPolicies error:', e.message);
    return [];
  }
}

/**
 * Construye un contexto completo de la tienda combinando:
 * shop info + productos + páginas + políticas.
 * Listo para usar como system prompt del agente IA.
 */
async function buildFullStoreContext(shop, token, orgName = '') {
  const [shopInfo, pages, policies, productsRes] = await Promise.all([
    getShopInfo(shop, token),
    getPages(shop, token),
    getPolicies(shop, token),
    getProducts(shop, token, { limit: 20 }).catch(() => ({ products: [] })),
  ]);

  const displayName = orgName || shopInfo.name || shop.replace('.myshopify.com', '');
  const parts = [];

  // ── Info básica ──────────────────────────────────────────────────
  parts.push(`Tienda: ${displayName}`);
  if (shopInfo.description) parts.push(`Descripción: ${shopInfo.description}`);
  if (shopInfo.address)     parts.push(`Dirección: ${shopInfo.address}`);
  if (shopInfo.phone)       parts.push(`Teléfono: ${shopInfo.phone}`);
  if (shopInfo.email)       parts.push(`Email: ${shopInfo.email}`);
  if (shopInfo.currency)    parts.push(`Moneda: ${shopInfo.currency}`);

  // ── Productos ────────────────────────────────────────────────────
  const productList = (productsRes.products || []).slice(0, 15);
  if (productList.length) {
    const lines = productList.map(p => {
      const price = p.priceMin > 0 ? ` ($${p.priceMin.toLocaleString('es-CL')} ${p.currency || ''})` : '';
      return `  - ${p.title}${price}`;
    });
    parts.push(`\nProductos del catálogo:\n${lines.join('\n')}`);
  }

  // ── Páginas personalizadas ───────────────────────────────────────
  if (pages.length) {
    for (const page of pages) {
      const content = page.content.slice(0, 1500); // limitar para no exceder tokens
      parts.push(`\n--- ${page.title} ---\n${content}`);
    }
  }

  // ── Políticas ────────────────────────────────────────────────────
  if (policies.length) {
    for (const pol of policies) {
      const content = pol.content.slice(0, 800);
      parts.push(`\n--- ${pol.title} ---\n${content}`);
    }
  }

  return parts.join('\n');
}

module.exports = {
  credentialsFrom,
  getProducts,
  getAllProducts,
  getCustomers,
  getAllCustomers,
  getCustomerByPhone,
  getOrders,
  createDraftOrder,
  formatProductsForAI,
  getShopInfo,
  getPages,
  getPolicies,
  buildFullStoreContext,
  stripHtml,
};
