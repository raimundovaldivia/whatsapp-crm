// Stable commercial identifiers. A UI flag is a preference, never a purchase.
const SOLUTIONS = [
  { key: 'sales_ai', name: 'Ventas con IA', description: 'Atiende consultas y acompaña la venta por WhatsApp.', includes: ['Agente de ventas', 'Evaluación del bot'], requires: ['orders'], flags: ['evaluacion'] },
  { key: 'orders', name: 'Gestión de pedidos', description: 'Organiza y da seguimiento a los pedidos de tu tienda.', includes: ['Pedidos', 'Seguimiento operativo'], requires: [], flags: ['orders'] },
  { key: 'marketing', name: 'Marketing y recompra', description: 'Segmenta clientes y prepara campañas de reactivación.', includes: ['Campañas', 'Reenganche', 'Seguimientos comerciales'], requires: [], flags: ['mensajeria'] },
  { key: 'payments', name: 'Pagos y cobranza', description: 'Centraliza comprobantes, conciliación y cobros pendientes.', includes: ['Comprobantes', 'Conciliación', 'Cobranza automática'], requires: ['orders'], flags: ['pagos', 'cobranza'] },
  { key: 'delivery', name: 'Logística', description: 'Coordina rutas, entregas y el trabajo de tus repartidores.', includes: ['Rutas', 'App de reparto', 'Gastos y entregas'], requires: ['orders'], flags: ['repartos', 'edit_delivered_items'] },
  { key: 'storefront', name: 'Tienda y catálogo', description: 'Publica tus productos en una tienda conectada a tu operación.', includes: ['Catálogo propio', 'Tienda pública'], requires: ['orders'], flags: ['productos'] },
  { key: 'analytics', name: 'Analítica', description: 'Consulta indicadores para entender la operación y las ventas.', includes: ['Estadísticas', 'Panel de resultados'], requires: [], flags: ['stats'] },
];
const KEYS = SOLUTIONS.map(s => s.key);
const FLAG_SOLUTION = Object.fromEntries(SOLUTIONS.flatMap(s => s.flags.map(f => [f, s.key])));
const DEFAULT_FLAGS = { stats: true, orders: true, repartos: true, pagos: true, clientes: true, mensajeria: true, productos: true, evaluacion: true, edit_delivered_items: false, cobranza: false };
const LIMITS = { bot_turns: { name: 'Turnos del agente de ventas / mes', default: 500 }, seats: { name: 'Usuarios del equipo', default: 3 } };
function validateModules(modules) {
  if (!Array.isArray(modules) || modules.length > KEYS.length || modules.some(k => !KEYS.includes(k)) || new Set(modules).size !== modules.length) throw Object.assign(new Error('Selección de módulos inválida'), { status: 400 });
  for (const s of SOLUTIONS.filter(s => modules.includes(s.key))) {
    if (s.requires.some(key => !modules.includes(key))) throw Object.assign(new Error(`${s.name} requiere Gestión de pedidos`), { status: 400 });
  }
  return modules;
}
module.exports = { SOLUTIONS, KEYS, FLAG_SOLUTION, DEFAULT_FLAGS, LIMITS, validateModules };
