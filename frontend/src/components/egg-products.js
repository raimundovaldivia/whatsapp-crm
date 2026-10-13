const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

export function eggColor(product) {
  const structured = normalize(product?.egg_color);
  if (structured.includes('blanc')) return 'blancos';
  if (structured.includes('cafe')) return 'cafe';
  if (structured.includes('mixt')) return 'mixtos';

  const name = normalize(product?.title);
  if (name.includes('blanc')) return 'blancos';
  if (name.includes('cafe')) return 'cafe';
  if (name.includes('mixt')) return 'mixtos';
  return null;
}

export function matchesEggColor(product, selectedColor) {
  return selectedColor === 'all' || eggColor(product) === selectedColor;
}

export function eggImage(product, units) {
  const name = normalize(product?.title);
  const color = eggColor(product);
  const bulk = Number(units) >= 100;

  if (bulk) {
    return color
      ? `caja-logo-huevos-${color}-v6.jpg`
      : name.includes('xl') ? 'caja-logo-huevos-xl-v6.jpg' : 'huevos-bandeja.png';
  }
  if (!color) return name.includes('xl')
    ? `huevos-xl-${Number(units) === 20 ? 20 : 30}-hogar-v5.jpg`
    : 'huevos-bandeja.png';
  if (Number(units) === 20) return `huevos-${color}-20-hogar-v4.jpg`;
  if (color === 'cafe') return 'huevos-cafe-30-hogar-v4.jpg';
  return `huevos-${color}-hogar-v3.jpg`;
}
