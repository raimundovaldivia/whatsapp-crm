const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDatabase } = require('../src/services/database-startup');

test('explicit existing-database deployment never calls schema or business-data setup', async () => {
  await prepareDatabase(() => { throw new Error('Database mutation forbidden'); }, { SKIP_DATABASE_SETUP: '1' });
});

test('normal startup still initializes the database and propagates setup failures', async () => {
  let initialized = false;
  await prepareDatabase(async () => { initialized = true; }, {});
  assert.equal(initialized, true);
  await assert.rejects(prepareDatabase(async () => { throw new Error('Database unavailable'); }, {}), /Database unavailable/);
});
