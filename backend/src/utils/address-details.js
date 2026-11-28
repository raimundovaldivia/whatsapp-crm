// Omitting a field preserves it for older clients. An explicit empty string clears it.
function addressDetails(input = {}) {
  const details = {};
  for (const [key, limit] of [['address2', 150], ['addressDescription', 500]]) {
    const value = input?.[key];
    if (typeof value === 'string') details[key] = value.trim().slice(0, limit);
  }
  return details;
}

function shippingObject(raw) {
  if (typeof raw === 'string') {
    try { return shippingObject(JSON.parse(raw)); } catch { return { address: raw }; }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function shopifyAddress(row) {
  const raw = shippingObject(row.raw_json?.shippingAddress || row.raw_shipping || row.shipping_address);
  return {
    address: row.shipping_address1 || raw.address1 || raw.address || '',
    city: row.shipping_city || raw.city || '',
    address2: row.shipping_address2 ?? raw.address2 ?? '',
    addressDescription: row.shipping_address_description ?? raw.addressDescription ?? '',
  };
}

// Installed driver clients prior to the structured form render only address and city.
function legacyDriverStop(stop) {
  if (!stop || (!stop.address2 && !stop.addressDescription)) return stop;
  const lines = [stop.address || stop.fullAddress || ''];
  if (stop.address2) lines.push('Casa / Depto.: ' + stop.address2);
  if (stop.addressDescription) lines.push('Referencia: ' + stop.addressDescription);
  return { ...stop, address: lines.join('\n') };
}

function legacyDriverResponse(payload, { legacyAddress = true, legacyPayment = false } = {}) {
  const displayStop = stop => {
    const view = legacyAddress ? legacyDriverStop(stop) : stop;
    if (!legacyPayment || !view?.prepaid) return view;
    return { ...view, totalPrice: 0,
      orderName: `${view.orderName || '#' + view.id} · YA PAGADO · Saldo $0. Al entregar, elige «Otro / no corresponde».` };
  };
  const route = value => value && {
    ...value,
    ...(Array.isArray(value.orders) && { orders: value.orders.map(displayStop) }),
    ...(Array.isArray(value.optimized_route) && { optimized_route: value.optimized_route.map(displayStop) }),
  };
  return {
    ...payload,
    ...(payload.route && { route: route(payload.route) }),
    ...(Array.isArray(payload.routes) && { routes: payload.routes.map(route) }),
    ...(payload.stop && { stop: displayStop(payload.stop) }),
    ...(Array.isArray(payload.orders) && { orders: payload.orders.map(displayStop) }),
    ...(Array.isArray(payload.optimizedRoute) && { optimizedRoute: payload.optimizedRoute.map(displayStop) }),
  };
}

function readLegacyDriverAddress(body) {
  const text = body?.address;
  if (typeof text !== 'string') return body;
  const parts = text.match(/^([^\n]*)\n(?:Casa \/ Depto\.: ([^\n]*)(?:\n|$))?(?:Referencia: ([\s\S]*))?$/);
  if (!parts || (parts[2] == null && parts[3] == null)) return body;
  return { ...body, address: parts[1],
    ...(parts[2] !== undefined && { address2: parts[2] }),
    ...(parts[3] !== undefined && { addressDescription: parts[3] }) };
}

module.exports = { addressDetails, shippingObject, shopifyAddress, legacyDriverResponse, readLegacyDriverAddress };
