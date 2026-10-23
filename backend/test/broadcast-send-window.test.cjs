const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { sendWindow, checkSendWindow } = require('../src/services/broadcast-send-window');

test('Evolution defaults to 08:00–22:30; invalid windows fail closed', () => {
  assert.deepEqual(sendWindow({}), { start: 480, end: 1350 });
  assert.deepEqual(sendWindow({ EVOLUTION_SEND_HOUR_START: '0', EVOLUTION_SEND_HOUR_END: '24' }), { start: 0, end: 1440 });
  for (const end of ['bad', '-1', '25', '8']) assert.throws(() => sendWindow({ EVOLUTION_SEND_HOUR_END: end }));
});

test('Santiago summer/winter: pause at 22:30, keep pending, resume at 08:00', async () => {
  const engine = new PGlite();
  try {
    for (const [date, offset] of [['2026-01-15', '-03:00'], ['2026-07-15', '-04:00']]) {
      for (const [time, allowed, retry] of [['07:59:59', false, 1], ['08:00:00', true, 0],
        ['22:29:59', true, 0], ['22:30:00', false, 34200], ['23:00:00', false, 32400]]) {
        const instant = date + 'T' + time + offset;
        const pool = { query: (sql, params) => engine.query(sql.replaceAll('NOW()', '$3::timestamptz'), [...params, instant]) };
        const result = await checkSendWindow(pool);
        assert.equal(result.allowed, allowed, instant);
        assert.equal(result.retryAfterSeconds, retry, instant);
      }
    }
  } finally { await engine.close(); }
});

test('worker leaves Evolution pending overnight and resumes without touching another provider', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(`CREATE TABLE broadcast_campaigns(id INT PRIMARY KEY, status TEXT, server_managed BOOLEAN, sending_provider TEXT, scheduled_for TIMESTAMPTZ, completed_at TIMESTAMPTZ);
      CREATE TABLE broadcast_jobs(id INT PRIMARY KEY, campaign_id INT, state TEXT, available_at TIMESTAMPTZ, claimed_at TIMESTAMPTZ, result JSONB, position INT);
      INSERT INTO broadcast_campaigns VALUES(1,'processing',true,'evolution',NULL,NULL),(2,'processing',true,'kapso',NULL,NULL);
      INSERT INTO broadcast_jobs VALUES(1,1,'pending','2026-01-14Z',NULL,NULL,1),(2,2,'pending','2026-01-14Z',NULL,NULL,1);`);
    let instant = '2026-01-15T22:30:00-03:00';
    const pool = { query: (sql, params = []) => engine.query(sql.replaceAll('NOW()', `$${params.length + 1}::timestamptz`), sql.includes('NOW()') ? [...params, instant] : params) };
    const sent = [];
    const { createWorker } = require('../src/services/broadcast-worker');
    const worker = createWorker(async job => { sent.push(job.id); return { status: 200, body: { results: [{ success: true }] } }; }, pool);
    await worker.tick();
    assert.deepEqual(sent, [2]);
    assert.equal((await engine.query('SELECT state FROM broadcast_jobs WHERE id=1')).rows[0].state, 'pending');
    instant = '2026-01-16T07:59:59-03:00'; await worker.tick(); assert.deepEqual(sent, [2]);
    instant = '2026-01-16T08:00:00-03:00'; await worker.tick(); assert.deepEqual(sent, [2,1]);
    await worker.tick(); assert.deepEqual(sent, [2,1]);
  } finally { await engine.close(); }
});
