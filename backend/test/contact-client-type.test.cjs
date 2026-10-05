const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { load } = require('./helpers.cjs');

test('cambiar Empresa sincroniza todas las variantes históricas del teléfono', async () => {
  const engine = new PGlite();
  const query = async (sql, params) => {
    const result = params?.length ? await engine.query(sql, params) : (await engine.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  };
  class Pool { query(...args) { return query(...args); } }
  const db = load('src/db/database.js', { pg: { Pool } });

  try {
    await engine.exec(`
      CREATE TABLE contacts (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        client_type TEXT DEFAULT 'personal',
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (organization_id, phone)
      );
      INSERT INTO contacts (organization_id, phone, client_type) VALUES
        (1, '932520156', 'empresa'),
        (1, '56932520156', 'personal'),
        (1, '+56932520156', 'personal');
    `);

    await db.updateContactClientType(1, '56932520156', 'empresa');
    let rows = (await query('SELECT phone, client_type FROM contacts WHERE organization_id = 1 ORDER BY phone')).rows;
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.client_type === 'empresa'));

    await db.updateContactClientType(1, '+56932520156', 'personal');
    rows = (await query('SELECT phone, client_type FROM contacts WHERE organization_id = 1 ORDER BY phone')).rows;
    assert.ok(rows.every(row => row.client_type === 'personal'));
  } finally {
    await engine.close();
  }
});
