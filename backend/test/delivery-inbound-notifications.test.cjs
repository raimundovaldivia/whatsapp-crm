const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('solo el repartidor asignado a la ruta activa recibe el mensaje del cliente', async () => {
  const pushes = [];
  const queries = [];
  const rows = [
    {
      id: 10, name: 'Ruta norte', status: 'in_progress', driver_user_id: 7,
      orders: [{ source: 'bot', id: 25, phone: '+56 9 1234 5678', customerName: 'Karen' }],
      stop_statuses: {},
    },
    {
      id: 11, name: 'Otra ruta', status: 'in_progress', driver_user_id: 8,
      orders: [{ source: 'bot', id: 26, phone: '56999999999', customerName: 'Otra' }],
      stop_statuses: {},
    },
  ];
  const service = load('src/services/delivery-inbound-notifications.js', {
    '../db/database': { getPool: () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } }) },
    './push': { pushUser: async (...args) => { pushes.push(args); return { sent: 1 }; } },
  });

  const result = await service.notifyAssignedDriversForInbound(3, {
    phone_number: '56 9 1234 5678', contact_name: 'Karen',
  }, '¿A qué hora llega?');

  assert.equal(result.sent, 1);
  assert.equal(queries[0].params[0], 3);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][0], 3);
  assert.equal(pushes[0][1], 7);
  assert.equal(pushes[0][2].data.kind, 'delivery_chat');
  assert.equal(pushes[0][2].data.stopKey, 'bot_25');
  assert.match(pushes[0][2].body, /hora llega/);
});

test('una ruta completada solo conserva avisos para paradas que requieren resolución', () => {
  const service = load('src/services/delivery-inbound-notifications.js', {
    '../db/database': {}, './push': {},
  });
  const routes = [{
    id: 20, status: 'completed', driver_user_id: 9,
    orders: [
      { source: 'bot', id: 1, phone: '111' },
      { source: 'bot', id: 2, phone: '222' },
    ],
    stop_statuses: { bot_1: 'entregado', bot_2: 'not_delivered' },
  }];
  assert.equal(service.activeDeliveryTargets(routes, '111').length, 0);
  assert.equal(service.activeDeliveryTargets(routes, '222')[0].stopKey, 'bot_2');
});
