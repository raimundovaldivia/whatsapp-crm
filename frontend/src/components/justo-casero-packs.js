export const eggTypes = [
  {
    size: 'Extra', trayUnits: 30, boxUnits: 180,
    text: 'Huevos de color, calibre Extra de 61–68 g.',
    formats: [90, 120, 150, 180].map(units => ({ units, sku: `JC-EXTRA-${units}` })),
  },
  {
    size: 'Súper Extra', trayUnits: 20, boxUnits: 100,
    text: 'Huevos de color, calibre Súper Extra / Especial de 69–76 g.',
    formats: [60, 80, 100].map(units => ({ units, sku: `JC-SUPER-EXTRA-${units}` })),
  },
];

export const clp = value => `$${Number(value).toLocaleString('es-CL', { maximumFractionDigits: 0 })}`;

export function resolveFormats(type, catalog) {
  return type.formats.map(format => {
    const item = catalog?.find(product => product?.sku === format.sku);
    const price = Number(item?.price);
    const stock = item?.stock == null ? NaN : Number(item.stock);
    const available = Boolean(item && item.active !== false && Number.isFinite(price) && price > 0
      && (stock === -1 || stock > 0));
    return { ...format, price, available, trays: format.units / type.trayUnits,
      isBox: format.units === type.boxUnits, size: type.size };
  });
}

export function selectedFormat(type, catalog, sku) {
  const formats = resolveFormats(type, catalog);
  return formats.find(format => format.sku === sku && format.available)
    || formats.find(format => format.available) || formats[0];
}

export function orderMessage(formats) {
  const lines = formats.filter(format => format.available).map(format =>
    `• ${format.size}: ${format.units} huevos (${format.trays} bandejas), ${clp(format.price)}.`);
  if (!lines.length) return '';
  const total = formats.filter(format => format.available).reduce((sum, format) => sum + format.price, 0);
  return `Hola, quiero confirmar disponibilidad y pedir en Justo Casero:\n${lines.join('\n')}\nTotal de productos: ${clp(total)}. Reparto incluido en La Serena urbana; para otras zonas, confirmar cobertura y costo.\nMi dirección es: `;
}
