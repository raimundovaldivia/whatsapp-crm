export const DIRECT_PARAMETERS = [
  { key: 'nombre', mode: 'name', label: 'Primer nombre' },
  { key: 'nombre_completo', mode: 'full_name', label: 'Nombre completo' },
  { key: 'producto_favorito', mode: 'fav', label: 'Producto favorito' },
  { key: 'tiempo_sin_comprar', mode: 'since_order', label: 'Tiempo sin comprar' },
  { key: 'fecha_ultima_compra', mode: 'last_order_date', label: 'Fecha última compra' },
  { key: 'cantidad_pedidos', mode: 'orders_count', label: 'Cantidad de pedidos' },
  { key: 'ciudad', mode: 'city', label: 'Ciudad' },
  { key: 'telefono', mode: 'phone', label: 'Teléfono' },
  { key: 'pedido_no_entregado', mode: 'delivery_order', label: 'Pedido no entregado' },
  { key: 'motivo_no_entrega', mode: 'delivery_reason', label: 'Motivo de no entrega' },
];

export function renderDirectMessage(source, values) {
  const missing = new Set();
  const text = String(source || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, key) => {
    if (!DIRECT_PARAMETERS.some(parameter => parameter.key === key)
      || !Object.hasOwn(values, key) || !String(values[key] ?? '').trim()) {
      missing.add(key);
      return token;
    }
    return String(values[key]);
  });
  return { text, missing: [...missing] };
}

export function insertDirectParameter(source, key, start = source.length, end = start) {
  const token = `{{${key}}}`;
  return { text: source.slice(0, start) + token + source.slice(end), cursor: start + token.length };
}
