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
    lineItems: items.map(item => ({
      variantId: item.variantId,
      quantity:  parseInt(item.quantity) || 1,
    })),
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
};
