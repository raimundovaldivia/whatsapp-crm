/**
 * Selección central de templates automáticos.
 *
 * El template es solo un respaldo: cada flujo debe intentar texto libre cuando
 * la ventana de atención esté abierta y consultar esta asignación únicamente
 * cuando WhatsApp exija un template.
 */

const db = require('../db/database');

const SETTING_KEY = 'automatic_template_assignments';

const CASES = Object.freeze({
  delivery_en_route: {
    key: 'delivery_en_route',
    label: 'Pedido en camino',
    description: 'Aviso enviado por el repartidor antes de llegar.',
    category: 'UTILITY',
    parameterCount: 3,
    parameters: ['Nombre', 'Pedido', 'Dirección'],
  },
  payment_collection: {
    key: 'payment_collection',
    label: 'Cobro por transferencia',
    description: 'Solicitud del comprobante después de entregar el pedido.',
    category: 'UTILITY',
    parameterCount: 4,
    parameters: ['Nombre', 'Pedido', 'Total', 'Datos bancarios'],
  },
  scheduled_order: {
    key: 'scheduled_order',
    label: 'Pedido agendado',
    description: 'Confirmación de que un pedido previamente agendado entra a despacho.',
    category: 'UTILITY',
    parameterCount: 2,
    parameters: ['Nombre', 'Producto'],
  },
});

function cleanAssignment(value) {
  if (!value || typeof value !== 'object' || !value.name) return null;
  return {
    name: String(value.name).trim(),
    language: String(value.language || 'es').trim(),
    category: String(value.category || 'UTILITY').toUpperCase(),
  };
}

async function getAssignments(orgId) {
  let parsed = {};
  try {
    const raw = await db.getSetting(orgId, SETTING_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch { parsed = {}; }

  const assignments = {};
  for (const key of Object.keys(CASES)) assignments[key] = cleanAssignment(parsed[key]);

  // Compatibilidad con selecciones anteriores mientras se guardan desde la
  // nueva pantalla central.
  if (!assignments.payment_collection) {
    try {
      const raw = await db.getSetting(orgId, 'charge_settings');
      const charge = raw ? JSON.parse(raw) : {};
      if (charge.waTemplate) assignments.payment_collection = cleanAssignment({
        name: charge.waTemplate,
        language: charge.waTemplateLanguage || 'es',
        category: 'UTILITY',
      });
    } catch {}
  }
  if (!assignments.scheduled_order) {
    const name = await db.getSetting(orgId, 'scheduled_dispatch_template').catch(() => '');
    if (name) assignments.scheduled_order = cleanAssignment({
      name,
      language: await db.getSetting(orgId, 'scheduled_dispatch_template_language').catch(() => 'es'),
      category: 'UTILITY',
    });
  }
  return assignments;
}

async function saveAssignments(orgId, assignments) {
  const normalized = {};
  for (const key of Object.keys(CASES)) normalized[key] = cleanAssignment(assignments?.[key]);
  await db.setSetting(orgId, SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}

async function getAssignment(orgId, caseKey) {
  if (!CASES[caseKey]) return null;
  return (await getAssignments(orgId))[caseKey] || null;
}

module.exports = { SETTING_KEY, CASES, cleanAssignment, getAssignments, saveAssignments, getAssignment };
