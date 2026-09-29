const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('los avisos administrativos no se envían a la app de los repartidores', async () => {
  const queries = [];
  const posts = [];
  const push = load('src/services/push.js', {
    '../db/database': {
      getPool: () => ({
        query: async (sql, params) => {
          queries.push({ sql, params });
          return { rows: [{ token: 'ExponentPushToken[admin-device]' }] };
        },
      }),
    },
    axios: {
      post: async (url, body) => {
        posts.push({ url, body });
        return { data: { data: [{ status: 'ok' }] } };
      },
    },
  });

  const result = await push.pushAdmins(7, { title: 'Diva', body: 'Caso pendiente' });

  assert.equal(result.sent, 1);
  assert.match(queries[0].sql, /JOIN users/i);
  assert.match(queries[0].sql, /u\.role IN \('owner', 'admin', 'supervisor', 'coordinador'\)/i);
  assert.equal(posts[0].body[0].to, 'ExponentPushToken[admin-device]');
});
