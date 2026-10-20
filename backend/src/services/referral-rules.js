'use strict';

const DEFAULT_RULES = Object.freeze({
  referrer_amount: 2000, referred_amount: 2000, minimum_purchase: 0,
  validity_days: 30, gift_product_id: null,
  milestones: [{ count: 5, kind: 'gift', amount: 0, quantity: 1 }],
  auto_invite: false, auto_send: false, reminder_days: 7, invite_delay_hours: 24,
});
const PRESETS = [
  { id: 'cinco', name: 'Cinco amigos, una bandeja', description: '$2.000 para ambos y una bandeja al llegar a 5 compradores distintos.', rules: DEFAULT_RULES },
  { id: 'doble', name: 'Doble beneficio', description: '$2.000 por referido válido y $2.000 para cada nuevo comprador.', rules: { ...DEFAULT_RULES, milestones: [] } },
  { id: 'escalera', name: 'Premios por etapas', description: 'Doble beneficio, $2.000 extra al llegar a 3 y una bandeja al llegar a 5.', rules: { ...DEFAULT_RULES, milestones: [{ count: 3, kind: 'discount', amount: 2000, quantity: 1 }, { count: 5, kind: 'gift', amount: 0, quantity: 1 }] } },
];
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name}: ingresa un entero entre ${min} y ${max}`);
  return value;
}
function validateRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración inválida');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_RULES, key)) fail(`Regla desconocida: ${key}`);
  const r = { ...DEFAULT_RULES, ...input };
  for (const key of ['referrer_amount','referred_amount']) integer(r[key], 'Descuento en pesos', 1, 100000);
  integer(r.minimum_purchase, 'Compra mínima', 0, 10000000);
  integer(r.validity_days, 'Vigencia', 1, 365);
  integer(r.reminder_days, 'Recordatorio', 0, 90);
  integer(r.invite_delay_hours, 'Espera después de entrega', 0, 720);
  if (r.gift_product_id !== null) integer(r.gift_product_id, 'Producto de regalo', 1, 2147483647);
  for (const key of ['auto_invite','auto_send']) if (typeof r[key] !== 'boolean') fail('Automatización inválida');
  if (!Array.isArray(r.milestones) || r.milestones.length > 5) fail('Configura hasta cinco metas');
  const seen = new Set();
  r.milestones = r.milestones.map(m => {
    if (!m || !['discount','gift'].includes(m.kind)) fail('Premio de meta inválido');
    integer(m.count, 'Meta de compradores', 1, 100);
    if (seen.has(m.count)) fail('Las metas deben ser distintas');
    seen.add(m.count);
    return { count: m.count, kind: m.kind, amount: m.kind === 'discount' ? integer(m.amount, 'Premio en pesos', 1, 100000) : 0, quantity: m.kind === 'gift' ? integer(m.quantity, 'Bandejas', 1, 10) : 1 };
  }).sort((a,b) => a.count - b.count);
  return r;
}
function money(n) { return `$${Number(n).toLocaleString('es-CL')}`; }
function describeRules(r) {
  return `${money(r.referrer_amount)} para quien invita por cada nuevo comprador y ${money(r.referred_amount)} para el invitado, una sola vez. Bonos personales de un uso, no acumulables entre sí en el mismo pedido, vigentes ${r.validity_days} días. Compra mínima ${money(r.minimum_purchase)}. ` +
    r.milestones.map(m => `Al alcanzar ${m.count} compradores distintos con compra pagada y entregada: ${m.kind === 'gift' ? `${m.quantity} bandeja(s) gratis` : money(m.amount)}, una sola vez.`).join(' ');
}
function invitation(name, code, r) {
  return `Hola ${name || 'amigo/a'}, gracias por comprar con nosotros. Tu código para compartir es ${code}. Por cada persona nueva que compre con él, recibirás ${money(r.referrer_amount)} para tu próxima compra y esa persona tendrá ${money(r.referred_amount)} para su primera compra. ` +
    r.milestones.map(m => m.kind === 'gift' ? `Si ${m.count} personas distintas compran con tu código, te llevaremos ${m.quantity === 1 ? 'una bandeja gratis' : `${m.quantity} bandejas gratis`} con tu próximo pedido. ` : `Al llegar a ${m.count} compradores, ganas ${money(m.amount)} extra. `).join('') +
    `Contamos compras pagadas y entregadas. Cada bono es personal, de un uso, vence en ${r.validity_days} días y no se acumula con otros bonos en el mismo pedido. Compra mínima ${money(r.minimum_purchase)}. Cada meta se premia una sola vez. Si no quieres estos avisos, responde SALIR.`;
}
// Deliberately bounded natural-language grammar: unsupported instructions never
// become an unreviewed change to prices or messaging permissions.
function parseCommand(message, current = DEFAULT_RULES) {
  if (typeof message !== 'string' || !message.trim() || message.length > 1000) fail('Escribe una instrucción de hasta 1.000 caracteres');
  const t = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[.!]$/, '');
  if (/^(pausa|pausar|desactiva|desactivar)( el)?( programa de)? referidos$/.test(t)) return { action: 'pause', summary: 'Pausar nuevas invitaciones y premios. Los bonos ya ganados se conservan.' };
  if (/^(activa|activar)( el)?( programa de)? referidos$/.test(t)) return { action: 'activate', summary: 'Activar el programa con sus reglas guardadas.' };
  if (/^(prepara|preparar)( los)?( codigos| invitaciones)?( de referidos)? para (mis |los )?(clientes|compradores)( que (ya )?(compraron|han comprado))?$/.test(t)) return { action: 'prepare', summary: 'Preparar códigos y mensajes para hasta 100 compradores elegibles. No se enviarán mensajes.' };
  if (/^(revisa|revisar|procesa|procesar|actualiza)( las)? compras( de referidos)?$/.test(t)) return { action: 'reconcile', summary: 'Revisar compras válidas, actualizar las metas y generar bonos únicos.' };
  const preset = PRESETS.find(p => t === `usar ${p.name.toLowerCase()}` || t === p.id || t === `usar ${p.id}`);
  if (preset) return { action: 'configure', rules: validateRules({ ...preset.rules, gift_product_id: current.gift_product_id }), summary: describeRules(preset.rules) };
  let match = t.match(/^(?:da|dar|configura|ofrece) \$?([\d.]+)(?: pesos)? (?:a|para) (?:cada uno|ambos)(?: y (?:una|1) bandeja (?:gratis )?(?:a los|al llegar a|por) (\d+)(?: referidos| compradores| personas)?)?$/);
  if (match) {
    const amount = Number(match[1].replace(/\./g, ''));
    const rules = validateRules({ ...current, referrer_amount: amount, referred_amount: amount,
      ...(match[2] ? { milestones: [{ count: Number(match[2]), kind: 'gift', amount: 0, quantity: 1 }] } : {}) });
    return { action: 'configure', rules, summary: describeRules(rules) };
  }
  match = t.match(/^(?:recuerda|recordar|recordatorio)(?:les)?(?: a los clientes)? (?:en|cada|a los) (\d+) dias$/);
  if (match) return { action: 'configure', rules: validateRules({ ...current, reminder_days: Number(match[1]) }), summary: `Un recordatorio después de ${match[1]} días, solo si aún hay beneficios vigentes.` };
  fail('No entendí toda la instrucción. Prueba: «Da 2000 para ambos y una bandeja a los 5 compradores», «Prepara códigos para mis compradores» o «Pausa referidos».');
}
module.exports = { DEFAULT_RULES, PRESETS, validateRules, describeRules, invitation, parseCommand, money, fail };
