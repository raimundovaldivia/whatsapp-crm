import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFrequencyCustomers, latestConversationId } from './purchase-frequency.mjs';

const customers = [
  { name: 'Ángela', phone: '56912345678', status: 'overdue', cadence: 'weekly', daysUntilNext: -4, lastPurchase: '2026-10-26' },
  { name: 'José', phone: '56987654321', status: 'due', cadence: 'monthly', daysUntilNext: 2, lastPurchase: '2026-10-10' },
  { name: 'Ana', phone: '56922222222', status: 'insufficient', cadence: 'unknown', daysUntilNext: null, lastPurchase: null },
];
test('combina búsqueda sin acentos/teléfono formateado con filtros', () => {
  assert.deepEqual(filterFrequencyCustomers(customers, { search: 'angela', cadence: 'weekly', status: 'overdue' }), [customers[0]]);
  assert.deepEqual(filterFrequencyCustomers(customers, { search: '+56 9 1234 5678' }), [customers[0]]);
  assert.deepEqual(filterFrequencyCustomers(customers, { status: 'due', cadence: 'weekly' }), []);
});
test('ordena atraso primero, sin estimación al final y compra más reciente sin mutar datos', () => {
  const input = [customers[2], customers[1], customers[0]];
  assert.deepEqual(filterFrequencyCustomers(input), customers);
  assert.equal(filterFrequencyCustomers(input, { sort: 'last' })[0], customers[0]);
  assert.equal(filterFrequencyCustomers(input, { status: 'insufficient' })[0], customers[2]);
  assert.equal(input[0], customers[2]);
});

test('seguimiento incluye vencidos y próximos, excluye bajas y falta de historial', () => {
  const input = [...customers, { ...customers[0], phone: '56933333333', optedOut: true }];
  assert.deepEqual(filterFrequencyCustomers(input, { status: 'followup' }), customers.slice(0, 2));
  assert.equal(filterFrequencyCustomers(input, { status: 'all' }).length, 4);
});

test('abre por ID el chat más reciente con mensajes, sin confundir teléfono ni reservas vacías', () => {
  assert.equal(latestConversationId([
    { id: 30, message_count: 0, last_message_at: null },
    { id: 10, message_count: 2, last_message_at: '2026-10-01T12:00:00Z' },
    { id: 20, message_count: 3, last_message_at: '2026-11-01T12:00:00Z' },
  ]), 20);
  assert.equal(latestConversationId([]), null);
  assert.equal(latestConversationId([{ id: 30, message_count: 0 }]), null);
});
