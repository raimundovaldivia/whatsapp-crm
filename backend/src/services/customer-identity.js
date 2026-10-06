function normalizePhone(raw) {
  if (!raw) return null;
  let phone = String(raw).replace(/\D/g, '');
  if (/^9\d{8}$/.test(phone)) phone = `56${phone}`;
  return phone.length >= 8 ? phone : null;
}

function phoneVariants(raw) {
  const phone = normalizePhone(raw);
  if (!phone) return [];
  const variants = new Set([phone, `+${phone}`]);
  if (/^569\d{8}$/.test(phone)) {
    variants.add(phone.slice(2));
    variants.add(`+${phone.slice(2)}`);
  }
  return [...variants];
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('es-CL')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function identitySignals(record) {
  const signals = [];
  const shopifyId = String(record.shopifyId || record.shopify_id || '').trim();
  const email = normalizeEmail(record.email || record.customer_email);
  const name = normalizeText(record.name || record.customer_name);
  const address = normalizeText(record.address1 || record.address || record.shipping_address1);
  const city = normalizeText(record.city || record.shipping_city);

  if (shopifyId) signals.push(`shopify:${shopifyId}`);
  if (email && email.includes('@')) signals.push(`email:${email}`);
  // El nombre por sí solo nunca establece identidad. Una dirección exacta
  // compartida sí permite enlazar el teléfono anterior con el actual.
  if (name && address) signals.push(`name-address:${name}|${address}|${city}`);
  return signals;
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
}

/**
 * Construye phone -> teléfono canónico sin fusionar por nombre solamente.
 * Dentro de un grupo, el teléfono del pedido más reciente es el destinatario.
 */
function buildCustomerIdentityMap(records = []) {
  const parents = new Map();
  const ranks = new Map();
  const latest = new Map();
  const signalOwners = new Map();

  const ensure = phone => {
    if (!parents.has(phone)) {
      parents.set(phone, phone);
      ranks.set(phone, 0);
      latest.set(phone, 0);
    }
  };
  const find = phone => {
    const parent = parents.get(phone);
    if (parent !== phone) parents.set(phone, find(parent));
    return parents.get(phone);
  };
  const union = (left, right) => {
    let a = find(left);
    let b = find(right);
    if (a === b) return;
    if ((ranks.get(a) || 0) < (ranks.get(b) || 0)) [a, b] = [b, a];
    parents.set(b, a);
    if ((ranks.get(a) || 0) === (ranks.get(b) || 0)) ranks.set(a, (ranks.get(a) || 0) + 1);
  };

  for (const record of records) {
    const phone = normalizePhone(record.phone || record.customer_phone);
    if (!phone) continue;
    ensure(phone);
    const rawDate = record.orderDate || record.order_date || record.lastOrderAt || record.last_order_at;
    const timestamp = rawDate ? new Date(rawDate).getTime() : 0;
    if (Number.isFinite(timestamp)) latest.set(phone, Math.max(latest.get(phone) || 0, timestamp));
    for (const signal of identitySignals(record)) {
      const owner = signalOwners.get(signal);
      if (owner) union(phone, owner);
      else signalOwners.set(signal, phone);
    }
  }

  const members = new Map();
  for (const phone of parents.keys()) {
    const root = find(phone);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(phone);
  }

  const result = new Map();
  for (const phones of members.values()) {
    const canonical = [...phones].sort((a, b) => {
      const dateDiff = (latest.get(b) || 0) - (latest.get(a) || 0);
      return dateDiff || a.localeCompare(b);
    })[0];
    for (const phone of phones) result.set(phone, canonical);
  }
  return result;
}

function consolidateCustomerCandidates(candidates = [], providedIdentityMap = null) {
  const identityMap = providedIdentityMap || buildCustomerIdentityMap(candidates.map(candidate => ({
    phone: candidate.phone,
    name: candidate.name,
    email: candidate.email,
    orderDate: candidate.lastOrderDate,
  })));
  const grouped = new Map();

  for (const candidate of candidates) {
    const phone = normalizePhone(candidate.phone);
    const canonical = identityMap.get(phone) || phone;
    if (!canonical) continue;
    // Los candidatos guardados en caché no siempre incluyen email. El mapa
    // cargado desde Shopify conserva el perfil por teléfono para que la API
    // y el navegador puedan aplicar la misma deduplicación como resguardo.
    const profile = providedIdentityMap?.profiles?.get(phone);
    const canonicalProfile = providedIdentityMap?.profiles?.get(canonical);
    const storedEmail = profile?.email || canonicalProfile?.email || null;
    const current = grouped.get(canonical);
    if (!current) {
      grouped.set(canonical, { ...candidate, phone: canonical, email: candidate.email || storedEmail,
        recentOrders: [...(candidate.recentOrders || [])] });
      continue;
    }

    const candidateIsNewer = String(candidate.lastOrderDate || '') > String(current.lastOrderDate || '');
    const combinedOrders = [...(current.recentOrders || []), ...(candidate.recentOrders || [])]
      .filter((order, index, all) => all.findIndex(other =>
        `${other.orderName || ''}|${other.date || ''}|${other.price || 0}` ===
        `${order.orderName || ''}|${order.date || ''}|${order.price || 0}`) === index)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 5);
    const totalOrders = Number(current.totalOrders || 0) + Number(candidate.totalOrders || 0);
    const totalSpent = Number(current.totalSpent || 0) + Number(candidate.totalSpent || 0);
    grouped.set(canonical, {
      ...current,
      ...(candidateIsNewer ? {
        lastOrderDate: candidate.lastOrderDate,
        lastProducts: candidate.lastProducts,
        daysInactive: candidate.daysInactive,
        predictedDays: candidate.predictedDays,
        buyWindow: candidate.buyWindow,
        urgency: candidate.urgency,
        aiReason: candidate.aiReason,
        predSource: candidate.predSource,
      } : {}),
      phone: canonical,
      name: String(candidate.name || '').length > String(current.name || '').length ? candidate.name : current.name,
      email: current.email || candidate.email || storedEmail,
      totalOrders,
      totalSpent,
      avgOrderVal: totalOrders ? Math.round(totalSpent / totalOrders) : 0,
      recentOrders: combinedOrders,
      identityVersion: Math.max(Number(current.identityVersion || 0), Number(candidate.identityVersion || 0)),
    });
  }

  return [...grouped.values()];
}

async function loadCustomerIdentityMap(pool, orgId, extraRecords = []) {
  const { rows } = await pool.query(
    `SELECT phone, name, email, address, address1, city, shopify_id, last_order_at
       FROM contacts
      WHERE organization_id = $1
     UNION ALL
     SELECT customer_phone AS phone, customer_name AS name, customer_email AS email,
            NULL AS address, shipping_address1 AS address1, shipping_city AS city,
            raw_json->'customer'->>'id' AS shopify_id, shopify_created_at AS last_order_at
       FROM shopify_orders
      WHERE organization_id = $1 AND customer_phone IS NOT NULL AND customer_phone <> ''`,
    [orgId]
  );
  const records = [...rows, ...extraRecords];
  const identityMap = buildCustomerIdentityMap(records);
  const profiles = new Map();
  for (const record of records) {
    const phone = normalizePhone(record.phone || record.customer_phone);
    if (!phone) continue;
    const email = normalizeEmail(record.email || record.customer_email);
    const rawDate = record.orderDate || record.order_date || record.lastOrderAt || record.last_order_at;
    const timestamp = rawDate ? new Date(rawDate).getTime() : 0;
    const current = profiles.get(phone);
    if (!current || timestamp >= current.timestamp) {
      profiles.set(phone, {
        email: email && email.includes('@') ? email : (current?.email || null),
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      });
    } else if (!current.email && email.includes('@')) {
      current.email = email;
    }
  }
  identityMap.profiles = profiles;
  return identityMap;
}

async function resolveCustomerPhones(pool, orgId, rawPhone) {
  const seedPhone = normalizePhone(rawPhone);
  if (!seedPhone) return [];
  const identityMap = await loadCustomerIdentityMap(pool, orgId, [{ phone: seedPhone }]);
  const canonical = identityMap.get(seedPhone) || seedPhone;
  const aliases = [...identityMap.entries()]
    .filter(([, target]) => target === canonical)
    .flatMap(([phone]) => phoneVariants(phone));
  return [...new Set([...phoneVariants(seedPhone), ...aliases])];
}

module.exports = {
  normalizePhone,
  phoneVariants,
  identitySignals,
  normalizeEmail,
  buildCustomerIdentityMap,
  consolidateCustomerCandidates,
  loadCustomerIdentityMap,
  resolveCustomerPhones,
};
