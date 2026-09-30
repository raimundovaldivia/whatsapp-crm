const test = require('node:test');
const assert = require('node:assert/strict');
const { load, handler, response, noop } = require('./helpers.cjs');

test('las asignaciones automáticas se aíslan por organización y conservan idioma', async () => {
  const values = new Map();
  const db = {
    getSetting: async (orgId, key) => values.get(`${orgId}:${key}`) || null,
    setSetting: async (orgId, key, value) => values.set(`${orgId}:${key}`, value),
  };
  const automation = load('src/services/template-automation.js', { '../db/database': db });
  await automation.saveAssignments(1, {
    delivery_en_route: { name: 'aviso_camino', language: 'es_CL', category: 'UTILITY' },
  });
  const saved = await automation.getAssignment(1, 'delivery_en_route');
  assert.equal(saved.name, 'aviso_camino');
  assert.equal(saved.language, 'es_CL');
  assert.equal(saved.category, 'UTILITY');
  assert.equal(await automation.getAssignment(2, 'delivery_en_route'), null);
  assert.equal(await automation.getAssignment(1, 'caso_inexistente'), null);
});

test('la API acepta solo templates Utility aprobados con las variables exactas del caso', async () => {
  const values = new Map();
  const db = {
    getWhatsappConfig: async () => ({ provider: 'kapso' }),
    getSetting: async (orgId, key) => values.get(`${orgId}:${key}`) || null,
    setSetting: async (orgId, key, value) => values.set(`${orgId}:${key}`, value),
  };
  const automation = load('src/services/template-automation.js', { '../db/database': db });
  const approved = [{
    name: 'aviso_camino', language: 'es_CL', category: 'UTILITY', status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hola {{1}}, el pedido {{2}} va a {{3}}.' }],
  }];
  const router = load('src/routes/templates.js', {
    '../db/database': db,
    '../services/kapso-whatsapp': { getTemplates: async () => approved },
    '../services/template-automation': automation,
    '../services/payment-collection': { saveChargeSettings: async () => {} },
    '../middleware/auth': { requireAuth: noop, requireRole: () => noop },
    '../utils/template-renderer.mjs': require('../src/utils/template-renderer.mjs'),
  });
  const res = response();
  await handler(router, 'put', '/automation')({
    orgId: 1,
    body: { assignments: { delivery_en_route: { name: 'aviso_camino', language: 'es_CL' } } },
  }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.assignments.delivery_en_route.name, 'aviso_camino');
  assert.equal((await automation.getAssignment(1, 'delivery_en_route')).language, 'es_CL');
});
