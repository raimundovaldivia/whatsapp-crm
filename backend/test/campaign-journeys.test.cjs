const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');
const journeys = require('../src/services/campaign-journeys');

test('normaliza una secuencia, conserva el público y elimina teléfonos repetidos', () => {
  const result = journeys.normalizeJourneyInput({
    name: 'Clientes inactivos',
    objective: 'reactivacion',
    cooldownHours: 72,
    recipients: [
      { phone: '+56 9 1111 1111', name: 'Ana' },
      { phone: '56911111111', name: 'Ana duplicada' },
      { phone: '56922222222', name: 'Beatriz' },
    ],
    audienceFilters: { purchaseDays: 60, clientType: 'natural' },
    steps: [
      { templateName: 'promo_inicial', waitHours: 0, triggerCondition: 'always' },
      { templateName: 'recordatorio', waitHours: 24, triggerCondition: 'read_no_reply' },
    ],
  });
  assert.equal(result.objective, 'reactivacion');
  assert.equal(result.recipients.length, 2);
  assert.equal(result.recipients[0].phone, '56911111111');
  assert.equal(result.steps[1].stepOrder, 2);
  assert.equal(result.steps[1].waitHours, 24);
  assert.equal(result.steps[1].triggerCondition, 'read_no_reply');
  assert.equal(result.stopOnReply, true);
  assert.equal(result.stopOnOrder, true);
});

test('rechaza secuencias sin público o sin pasos para que nunca se activen vacías', () => {
  assert.throws(() => journeys.normalizeJourneyInput({ name: 'Vacía', recipients: [], steps: [{ templateName: 'promo' }] }), /público/i);
  assert.throws(() => journeys.normalizeJourneyInput({ name: 'Sin pasos', recipients: [{ phone: '56911111111' }], steps: [] }), /entre 1 y 10 pasos/i);
});

test('personaliza cada variable del template y conserva el hilo renderizado', () => {
  const step = {
    variable_modes: ['first_name', 'city', { mode: 'fixed', value: '60 días' }],
  };
  const enrollment = { phone: '56911111111', contact_name: 'Ana Pérez' };
  const components = journeys.componentsForStep(
    step,
    'Hola {{1}}, tenemos entrega en {{2}}. Hace {{3}} que no compras.',
    { name: 'Ana Pérez', city: 'La Serena' },
    enrollment
  );
  assert.deepEqual(components[0].parameters.map(parameter => parameter.text), ['Ana', 'La Serena', '60 días']);
  assert.equal(
    journeys.renderBody('Hola {{1}}, tenemos entrega en {{2}}. Hace {{3}} que no compras.', components),
    'Hola Ana, tenemos entrega en La Serena. Hace 60 días que no compras.'
  );
});

test('al activar excluye bajas y contactos recientes antes de reservar el público', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool {
    query(...args) { return query(...args); }
    async connect() { return { query, release() {} }; }
    async end() {}
  }
  const pool = new Pool();
  try {
    const setup = load('src/db/setup.js', { pg: { Pool } });
    await setup.setupDatabase();
    await engine.exec(`
      INSERT INTO organizations(id,name,slug) VALUES(1,'Diez Ríos','diez-rios');
      INSERT INTO users(id,organization_id,email,password_hash,name,role) VALUES(1,1,'rai@example.test','x','Rai','owner');
      INSERT INTO contacts(organization_id,phone,name,opt_out,last_template_sent_at) VALUES
        (1,'56911111111','Disponible',FALSE,NULL),
        (1,'56922222222','Baja',TRUE,NULL),
        (1,'56933333333','Reciente',FALSE,NOW());
    `);
    const journey = await journeys.createJourney(1, 1, {
      name: 'Recuperación segura', objective: 'reactivacion', cooldownHours: 48,
      recipients: [
        { phone: '56911111111', name: 'Disponible' },
        { phone: '56922222222', name: 'Baja' },
        { phone: '56933333333', name: 'Reciente' },
      ],
      steps: [{ templateName: 'promo', waitHours: 0, triggerCondition: 'always' }],
    }, pool);
    const activated = await journeys.activateJourney(1, journey.id, pool);
    assert.equal(activated.active, 1);
    assert.equal(activated.excluded, 2);
    assert.equal(activated.exclusions.baja_marketing, 1);
    assert.equal(activated.exclusions.contactado_recientemente, 1);
    const states = (await query('SELECT phone,status,stop_reason FROM campaign_journey_enrollments ORDER BY phone')).rows;
    assert.deepEqual(states.map(row => [row.phone, row.status, row.stop_reason]), [
      ['56911111111', 'active', null],
      ['56922222222', 'excluded', 'baja_marketing'],
      ['56933333333', 'excluded', 'contactado_recientemente'],
    ]);
  } finally { await engine.close(); }
});
