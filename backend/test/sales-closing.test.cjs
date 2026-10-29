const test = require('node:test');
const assert = require('node:assert/strict');
const closing = require('../src/services/sales-closing');

// Octubre de 2026: Chile continental está en UTC-3.
const atChile = value => new Date(`${value}-03:00`);

test('una tienda puede configurar cierre a las 15:00 inclusive sin heredar las 13:00', () => {
  const options = { cutoffTime: '15:00', startedAt: atChile('2026-10-29T14:30:00') };
  assert.equal(closing.sameDayPolicy({ ...options, now: atChile('2026-10-29T15:00:59') }).canContinueSameDay, true);
  const closed = closing.sameDayPolicy({ ...options, now: atChile('2026-10-29T15:01:00') });
  assert.equal(closed.canContinueSameDay, false);
  assert.equal(closed.needsHumanReview, true);
  const prompt = closing.closingPromptSection({}, atChile('2026-10-29T14:30:00'), options);
  assert.match(prompt, /15:00 inclusive/);
  assert.doesNotMatch(prompt, /12:50|13:00/);
  assert.equal(closing.sameDayPolicy({ cutoffTime: '15:00', now: atChile('2026-11-01T12:00:00') }).offerOpen, false);
});

test('permite iniciar a las 12:49 y crea una ventana hasta las 13:00', () => {
  const now = atChile('2026-10-14T12:49:00');
  const result = closing.sameDayPolicy({ now });
  assert.equal(result.offerOpen, true);
  assert.equal(result.orderOpen, true);
  assert.equal(result.minutesUntilOrderCutoff, 11);
});

test('un pedido iniciado a las 12:49 sigue protegido después de las 12:50', () => {
  const result = closing.sameDayPolicy({
    now: atChile('2026-10-14T12:55:00'),
    startedAt: atChile('2026-10-14T12:49:00'),
    holdUntil: atChile('2026-10-14T13:00:00'),
  });
  assert.equal(result.offerOpen, false);
  assert.equal(result.protectedOrder, true);
  assert.equal(result.canContinueSameDay, true);
  assert.equal(result.needsHumanReview, false);
});

test('a las 13:00 el pedido protegido pide revisión humana sin rechazarlo', () => {
  const result = closing.sameDayPolicy({
    now: atChile('2026-10-14T13:00:00'),
    startedAt: atChile('2026-10-14T12:49:00'),
    holdUntil: atChile('2026-10-14T13:00:00'),
  });
  assert.equal(result.canContinueSameDay, false);
  assert.equal(result.needsHumanReview, true);
  assert.match(closing.closingPromptSection({
    sales_started_at: atChile('2026-10-14T12:49:00'),
    same_day_hold_until: atChile('2026-10-14T13:00:00'),
  }, atChile('2026-10-14T13:00:00')), /no le digas que perdió el despacho/i);
});

test('un pedido nuevo a las 12:50 no recibe despacho para hoy', () => {
  const result = closing.sameDayPolicy({
    now: atChile('2026-10-14T12:50:00'),
    startedAt: atChile('2026-10-14T12:50:00'),
  });
  assert.equal(result.offerOpen, false);
  assert.equal(result.protectedOrder, false);
  assert.equal(result.canContinueSameDay, false);
});

test('no ofrece despacho el mismo día el domingo', () => {
  const result = closing.sameDayPolicy({ now: atChile('2026-10-18T10:00:00') });
  assert.equal(result.dispatchDay, false);
  assert.equal(result.offerOpen, false);
});

test('clasifica prioridad, etapa y recordatorio según datos reales del pedido', () => {
  const interested = { pipeline_state: 'interested', order_draft: '{}' };
  const collecting = {
    pipeline_state: 'collecting_order',
    order_draft: JSON.stringify({ items: [{ product_name: 'Huevos XL', quantity: 2 }], customer_name: 'Ana' }),
  };
  assert.equal(closing.leadTemperature(interested), 'hot');
  assert.equal(closing.followUpDelayMinutes(interested), 15);
  assert.equal(closing.leadTemperature(collecting), 'very_hot');
  assert.equal(closing.followUpDelayMinutes(collecting), 5);
  assert.equal(closing.closingStage(collecting), 'address');
});

test('el mensaje protegido pide solo el dato pendiente y conserva el acuerdo', () => {
  const message = closing.buildHotFollowUpMessage({
    contact_name: 'Ana Pérez',
    pipeline_state: 'collecting_order',
    order_draft: JSON.stringify({ items: [{ product_name: 'Huevos XL', quantity: 2 }], customer_name: 'Ana Pérez' }),
    sales_started_at: atChile('2026-10-14T12:49:00'),
    same_day_hold_until: atChile('2026-10-14T13:00:00'),
  }, atChile('2026-10-14T12:55:00'));
  assert.match(message, /comenzaste tu pedido antes del cierre/i);
  assert.match(message, /dirección de entrega/i);
  assert.doesNotMatch(message, /producto y cantidad/i);
});
