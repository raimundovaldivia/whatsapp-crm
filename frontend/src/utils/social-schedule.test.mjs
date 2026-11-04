import test from 'node:test';
import assert from 'node:assert/strict';
import { fromChileInput, toChileInput } from './social-schedule.mjs';
test('convierte horario de Chile en verano e invierno sin depender del dispositivo', () => {
  assert.equal(fromChileInput('2026-11-04T09:30'), '2026-11-04T12:30:00.000Z');
  assert.equal(fromChileInput('2026-07-04T09:30'), '2026-07-04T13:30:00.000Z');
  assert.equal(toChileInput('2026-07-04T13:30:00Z'), '2026-07-04T09:30');
});
test('rechaza fecha inválida, hora inexistente y hora ambigua por cambio de hora', () => {
  for (const date of ['', '2026-02-30T10:00', '2026-09-06T00:30', '2026-04-04T23:30']) {
    assert.throws(() => fromChileInput(date));
  }
});
