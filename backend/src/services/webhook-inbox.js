const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { getPool } = require('../db/database');
const work = new AsyncLocalStorage();
const handlers = new Map();
let active = 0, stopped = false, timer;
const CONCURRENCY = 4;
function track(promise) {
  promise.catch(() => {});
  work.getStore()?.pending.push(promise);
  return promise;
}
function defer(key, fn) {
  const context = work.getStore();
  if (!context) throw new Error('Pipeline fuera del worker durable');
  context.deferred.set(key, fn);
}
function streamInfo(provider, body, event) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const sender = provider === 'kapso' ? (body.conversation?.phone_number || body.message?.from)
    : provider === 'twilio' ? body.From : value?.messages?.[0]?.from || value?.statuses?.[0]?.recipient_id;
  const key = sender ? String(sender).replace(/[^0-9]/g, '') : 'organization';
  const incoming = provider === 'kapso' && event === 'whatsapp.message.received';
  const opener = /^(hola+|holi+|buenas+(\s+(tardes|d[ií]as|noches))?|buen\s+d[ií]a|buenos\s+d[ií]as|hey)[\s!.,?¡¿]*$/iu.test(body.message?.text?.body || '');
  return { key: key || 'organization', delay: incoming ? (opener ? 12 : 3) : 0 };
}
function durableWebhook(provider, handler) {
  handlers.set(provider, handler);
  return async (req, res) => {
    let client;
    try {
      client = await getPool().connect();
      await client.query('BEGIN');
      const deliveries = req.webhookDeliveries || [{ orgId: req.webhookOrg?.id || Number(req.params.orgId), body: req.body }];
      for (const delivery of deliveries) {
        const event = req.headers['x-shopify-topic'] || req.headers['x-webhook-event'] || delivery.body?.event || '';
        const bytes = req.webhookDeliveries ? JSON.stringify(delivery.body) : req.rawBody;
        const key = crypto.createHash('sha256').update(String(event)).update('\0').update(bytes).digest('hex');
        const headers = Object.fromEntries(['x-webhook-event', 'x-shopify-topic', 'x-shopify-shop-domain'].filter(k => req.headers[k]).map(k => [k, req.headers[k]]));
        const info = streamInfo(provider, delivery.body, event);
        const { rows: [stream] } = await client.query(`INSERT INTO webhook_streams(provider,organization_id,stream_key)
          VALUES($1,$2,$3) ON CONFLICT(provider,organization_id,stream_key) DO UPDATE SET stream_key=EXCLUDED.stream_key RETURNING id`, [provider, delivery.orgId, info.key]);
        const inserted = await client.query(`INSERT INTO webhook_inbox (provider,organization_id,event_key,payload,headers,params,stream_id)
          VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) ON CONFLICT(provider,organization_id,event_key) DO NOTHING RETURNING id`,
        [provider, delivery.orgId, key, JSON.stringify(delivery.body), JSON.stringify(headers), JSON.stringify(req.params || {}), stream.id]);
        if (inserted.rows.length) await client.query(`UPDATE webhook_streams SET available_at=NOW()+($2 * INTERVAL '1 second') WHERE id=$1`, [stream.id, info.delay]);
      }
      await client.query('COMMIT');
      if (provider === 'twilio') res.type('text/xml').send('<Response></Response>');
      else res.sendStatus(200);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[WebhookInbox] No se pudo persistir', err.message);
      res.sendStatus(503);
    } finally { client?.release(); }
  };
}
async function processNext() {
  if (stopped || active >= CONCURRENCY) return;
  active++;
  let client, stream, jobs, heartbeat;
  try {
    const pool = getPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`UPDATE webhook_inbox SET status='needs_review',last_error='Procesamiento interrumpido; revisar efectos antes de reintentar'
      WHERE status='processing' AND updated_at<NOW()-INTERVAL '5 minutes'`);
    await client.query(`UPDATE webhook_streams s SET processing=false WHERE processing=true AND updated_at<NOW()-INTERVAL '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM webhook_inbox w WHERE w.stream_id=s.id AND w.status='processing')`);
    ({ rows: [stream] } = await client.query(`UPDATE webhook_streams SET processing=true,updated_at=NOW()
      WHERE id=(SELECT s.id FROM webhook_streams s WHERE NOT s.processing AND s.available_at<=NOW()
        AND EXISTS(SELECT 1 FROM webhook_inbox w WHERE w.stream_id=s.id AND w.status='pending')
        ORDER BY s.available_at,s.id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`));
    if (!stream) { await client.query('COMMIT'); return; }
    ({ rows: jobs } = await client.query(`UPDATE webhook_inbox SET status='processing',updated_at=NOW()
      WHERE id IN(SELECT id FROM webhook_inbox WHERE stream_id=$1 AND status='pending' ORDER BY id LIMIT 50) RETURNING *`, [stream.id]));
    await client.query('COMMIT'); client.release(); client = null;
    const ids = jobs.map(j => j.id);
    heartbeat = setInterval(() => Promise.all([
      pool.query('UPDATE webhook_streams SET updated_at=NOW() WHERE id=$1', [stream.id]),
      pool.query("UPDATE webhook_inbox SET updated_at=NOW() WHERE id=ANY($1::bigint[]) AND status='processing'", [ids]),
    ]).catch(err => console.error('[WebhookInbox] heartbeat', err.message)), 30000);
    heartbeat.unref?.();
    try {
      const context = { pending: [], deferred: new Map() };
      const res = { sendStatus(){return this},set(){return this},send(){return this},status(){return this},json(){return this} };
      await work.run(context, async () => {
        for (const job of jobs.sort((a,b) => Number(a.id)-Number(b.id))) {
          const fn = handlers.get(job.provider);
          if (!fn) throw new Error('Proveedor sin handler');
          await fn({ body: job.payload, headers: job.headers, params: job.params }, res);
        }
        // Persist every message first; run only latest response for each conversation.
        for (const fn of context.deferred.values()) await fn();
        while (context.pending.length) await Promise.all(context.pending.splice(0));
      });
      await pool.query("UPDATE webhook_inbox SET status='completed',updated_at=NOW() WHERE id=ANY($1::bigint[]) AND status='processing'", [ids]);
    } catch (err) {
      await pool.query("UPDATE webhook_inbox SET status='needs_review',last_error=$2,updated_at=NOW() WHERE id=ANY($1::bigint[])", [ids, String(err.message).slice(0,500)]);
    } finally {
      clearInterval(heartbeat);
      await pool.query('UPDATE webhook_streams SET processing=false,updated_at=NOW() WHERE id=$1', [stream.id]);
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[WebhookInbox]', err.message);
  } finally { client?.release(); active--; }
}
function startWebhookWorker() {
  stopped = false;
  timer = setInterval(() => { for (let i=active;i<CONCURRENCY;i++) void processNext(); }, 250);
  timer.unref?.();
}
async function stopWebhookWorker() {
  stopped = true; clearInterval(timer);
  while (active) await new Promise(resolve => setTimeout(resolve, 100));
}
module.exports = { durableWebhook, track, defer, streamInfo, processNext, startWebhookWorker, stopWebhookWorker };
