import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFrequencyCustomers, latestConversationId, selectableFrequencyCustomers, toggleFrequencySelection, frequencyBroadcastContacts, initialEvolutionMethod } from './purchase-frequency.mjs';
import { renderDirectMessage } from './direct-message.mjs';
import { frequencyDraftRequest, FREQUENCY_FOLLOWUP_INSTRUCTION } from './purchase-frequency.mjs';

test('automatic drafting sends explicit phones and a frequency source, leaving history to the server', () => {
  const phones = ['56911111111', '56922222222'];
  const request = frequencyDraftRequest(phones);
  assert.deepEqual(request, { phones, instruction: FREQUENCY_FOLLOWUP_INSTRUCTION, audienceType: 'all', contextSource: 'purchase_frequency' });
  phones.push('56933333333');
  assert.equal(request.phones.length, 2);
  assert.match(request.instruction, /última compra/);
  assert.match(request.instruction, /historial es insuficiente o variable/);
});

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

test('selección por página conserva otras páginas y nunca incluye bajas ni duplicados', () => {
  const rows = [...customers, { ...customers[0] }, { ...customers[1], optedOut: true }, { phone: 'sin teléfono' }];
  assert.deepEqual(selectableFrequencyCustomers(rows).map(c => c.phone), [customers[0].phone, customers[2].phone]);
  const original = new Set([customers[2].phone]);
  const next = toggleFrequencySelection(original, rows.slice(0, 2));
  assert.equal(next.size, 3);
  assert.equal(original.size, 1);
  assert.deepEqual(toggleFrequencySelection(next, rows.slice(0, 2)), original);
  assert.deepEqual(toggleFrequencySelection(original, []), original);
});

test('el público se reconstruye desde datos actuales y solo teléfonos explícitos, sin fallback a todos', () => {
  const updated = [
    { ...customers[0], name: 'Nombre actualizado', purchaseCount: 4 },
    { ...customers[1], optedOut: true },
    customers[2],
  ];
  const result = frequencyBroadcastContacts(updated, customers.map(c => c.phone).slice(0, 2).concat('56900000000'));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Nombre actualizado');
  assert.equal(result[0].phone, customers[0].phone);
  assert.equal(result[0].total_orders, 4);
  assert.equal(result[0].last_order_at, '2026-10-26T12:00:00Z');
  assert.deepEqual(frequencyBroadcastContacts(updated, []), []);
  assert.deepEqual(frequencyBroadcastContacts(updated), []);
  assert.deepEqual(frequencyBroadcastContacts([], [customers[0].phone]), []);
});

test('sin coincidencia en otra tienda no se recupera metadata del cliente anterior', () => {
  assert.deepEqual(frequencyBroadcastContacts([customers[2]], [customers[0].phone]), []);
  const contact = frequencyBroadcastContacts(customers, [customers[2].phone])[0];
  assert.equal(contact.last_order_at, null);
  assert.equal(contact.name, 'Ana');
  assert.deepEqual(renderDirectMessage('Hola {{nombre}}, ¿necesitas reponer tu pedido?', { nombre: contact.name }), {
    text: 'Hola Ana, ¿necesitas reponer tu pedido?', missing: [],
  });
});

test('Evolution se preselecciona solo con una conexión disponible, sin usar Kapso ni elegir entre tiendas/canales', () => {
  const official = { provider: 'kapso', available: true };
  const evolution = { provider: 'evolution', channelId: 12, available: true };
  assert.equal(initialEvolutionMethod([official]), 'evolution:pending');
  assert.equal(initialEvolutionMethod([official, { ...evolution, available: false }]), 'evolution:pending');
  assert.equal(initialEvolutionMethod([official, evolution]), 'evolution:12');
  assert.equal(initialEvolutionMethod([evolution, { ...evolution, channelId: 13 }]), 'evolution:pending');
});
