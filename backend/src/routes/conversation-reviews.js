'use strict';
const express = require('express');
const db = require('../db/database');
const store = require('../services/conversation-review-store');
const { analyzeStep } = require('../services/conversation-review');
const { loadContext } = require('../services/conversation-review-context');
const { snapshot, eligibility } = require('../services/conversation-review-rules');
const { offerExpiryDate } = require('../services/campaign-offers');
const router = express.Router();
// Mounted below reengagement authentication/role and Marketing entitlement checks.
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.param('id', (req, res, next, id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return res.status(400).json({ error: 'Revisión inválida.' });
  next();
});
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (error) {
  console.error('[ConversationReview]', error.status || 500, error.message);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'No se pudo completar la revisión. Puedes reintentar sin enviar mensajes.' });
} };
router.get('/', wrap(async (req, res) => res.json({ runs: await store.list(db.getPool(), req.orgId) })));
router.post('/', wrap(async (req, res) => {
  const id = await store.create(db.getPool(), req.orgId, req.userId, req.body);
  res.status(201).json({ id, reviewOnly: true, sendAllowed: false });
}));
router.get('/:id', wrap(async (req, res) => res.json(await store.get(db.getPool(), req.orgId, req.params.id))));
router.post('/:id/next', wrap(async (req, res) => {
  const pool = db.getPool();
  const run = await store.get(pool, req.orgId, req.params.id);
  const job = await store.claim(pool, req.orgId, run.id);
  if (!job) return res.json({ idle: true });
  try {
    const step = await analyzeStep(pool, req.orgId, job.phone, run.instruction, job.result);
    await store.finish(pool, req.orgId, job, step);
    res.json({ phone: job.phone, state: step.done ? 'done' : 'pending' });
  } catch (error) {
    // Store an operational reason, never provider payloads or private messages.
    await store.finish(pool, req.orgId, job, null, 'No se completó el análisis. Reintenta este contacto.');
    console.warn('[ConversationReview] Falló un paso:', error.name);
    res.json({ phone: job.phone, state: 'error' });
  }
}));
router.post('/:id/retry', wrap(async (req, res) => {
  await store.retry(db.getPool(), req.orgId, req.params.id); res.json({ success: true });
}));
router.post('/:id/check', wrap(async (req, res) => {
  const pool = db.getPool();
  const run = await store.get(pool, req.orgId, req.params.id);
  const row = run.contacts.find(c => c.phone === req.body?.phone);
  if (!row) return res.status(404).json({ error: 'Contacto no incluido en esta revisión.' });
  if (row.state !== 'done') return res.json({ current: false, state: row.state });
  const context = await loadContext(pool, req.orgId, row.phone);
  const current = snapshot(context, run.instruction) === row.result.sourceHash
    && eligibility(context).businessDate === row.result.businessDate;
  if (!current) await store.invalidate(pool, req.orgId, run.id, row.phone, row.result.sourceHash);
  res.json({ current, state: current ? 'done' : 'stale', sendAllowed: false });
}));

// A per-phone commercial proposal remains in this review. It is never an active coupon.
router.post('/:id/offer', wrap(async (req, res) => {
  const pool = db.getPool();
  const run = await store.get(pool, req.orgId, req.params.id);
  const row = run.contacts.find(c => c.phone === req.body?.phone);
  if (!row || row.state !== 'done' || row.result?.decision !== 'draft') return res.status(409).json({ error: 'El contacto requiere una revisión completa y vigente.' });
  const context = await loadContext(pool, req.orgId, row.phone);
  if (snapshot(context, run.instruction) !== row.result.sourceHash || !eligibility(context).eligible
    || eligibility(context).businessDate !== row.result.businessDate) {
    await store.invalidate(pool, req.orgId, run.id, row.phone, row.result.sourceHash);
    return res.status(409).json({ error: 'Cambió el contexto. Revisa nuevamente el contacto.' });
  }
  const p = context.catalog.find(p => String(p.id) === String(req.body.productId));
  const price = Number(req.body.price), quantity = Number(req.body.quantity);
  const expires = offerExpiryDate(req.body.expiresAt);
  if (!p || !Number.isInteger(price) || price <= 0 || price >= Number(p.price)
    || !Number.isInteger(quantity) || quantity < 1 || !expires || expires <= new Date()) {
    return res.status(400).json({ error: 'Indica producto, precio promocional menor al catálogo, cantidad y vencimiento futuro.' });
  }
  const cost = Number(p.unit_cost), margin = Number(p.min_margin_pct);
  if (p.unit_cost == null || cost <= 0 || p.min_margin_pct == null || margin < 0 || margin >= 100
    || price < Math.ceil(cost / (1 - margin / 100))) {
    return res.status(400).json({ error: 'Falta configurar costo y margen bruto mínimo, o el precio no cumple ese margen.' });
  }
  if (Number(p.stock) < quantity) return res.status(400).json({ error: 'Stock insuficiente o sin verificar en el catálogo.' });
  const offer = { productId: String(p.id), title: p.title, price, quantity, phone: row.phone,
    expiresAt: expires.toISOString(), status: 'proposal_only', active: false };
  const expiry = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', dateStyle: 'short', timeStyle: 'short' }).format(expires);
  const offerText = `Esta promoción es especial para ti y válida únicamente para tu número de WhatsApp +${row.phone}: ${p.title} a $${price.toLocaleString('es-CL')} por unidad, hasta ${quantity} unidad(es), válida hasta ${expiry} (hora de Chile). No acumulable con otras promociones.`;
  const message = `${row.result.message}\n\n${offerText}`;
  await pool.query(`UPDATE conversation_review_contacts SET result = result || $4::jsonb
    WHERE organization_id = $1 AND run_id = $2 AND phone = $3 AND state = 'done'`,
  [req.orgId, run.id, row.phone, JSON.stringify({ offer, offerText, offeredMessage: message, sendAllowed: false })]);
  res.json({ offer, message, sendAllowed: false });
}));
module.exports = router;
