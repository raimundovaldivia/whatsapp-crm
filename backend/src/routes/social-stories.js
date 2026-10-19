// API de historias de Instagram programadas: crear, revisar, editar, aprobar y cancelar.
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireSolution } = require('../middleware/commercial-access');
const stories = require('../services/social-stories');

const router = express.Router();
router.use(requireAuth, requireRole('owner', 'admin'), requireSolution('marketing'));

const actorOf = req => `user:${req.userId}`;

function parseInput(body = {}, { partial = false } = {}) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title || '').trim();
  if (body.image_url !== undefined) {
    const url = String(body.image_url || '').trim();
    if (!url || url.length > 2000) return { error: 'image_url es obligatorio (máx. 2000 caracteres)' };
    out.image_url = url;
  }
  if (body.scheduled_for !== undefined) {
    const date = new Date(body.scheduled_for);
    if (Number.isNaN(date.getTime())) return { error: 'scheduled_for debe ser una fecha ISO válida' };
    out.scheduled_for = date.toISOString();
  }
  if (!partial) {
    if (!out.image_url) return { error: 'image_url es obligatorio' };
    if (!out.scheduled_for) return { error: 'scheduled_for es obligatorio' };
  }
  return { value: out };
}

const notFound = res => res.status(404).json({ error: 'Historia no encontrada' });

router.get('/', async (req, res) => {
  try {
    const posts = await stories.listPosts(req.orgId, { status: req.query.status });
    res.json({ posts });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/', async (req, res) => {
  try {
    const parsed = parseInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const post = await stories.createPost(req.orgId, parsed.value, actorOf(req));
    res.status(201).json({ post, checks: post.checks });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const post = await stories.getPost(req.orgId, req.params.id);
    if (!post) return notFound(res);
    res.json({ post, events: await stories.getEvents(req.orgId, req.params.id) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Editar: cualquier cambio vuelve a pasar chequeos y quita la aprobación.
router.patch('/:id', async (req, res) => {
  try {
    const parsed = parseInput(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const result = await stories.updatePost(req.orgId, req.params.id, parsed.value, actorOf(req));
    if (result.error === 'not_found') return notFound(res);
    if (result.error) return res.status(409).json({ error: `No se puede editar una historia en estado ${result.status}` });
    res.json({ post: result.post, checks: result.post.checks });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const result = await stories.approvePost(req.orgId, req.params.id, actorOf(req));
    if (result.error === 'not_found') return notFound(res);
    if (result.error === 'checks_failed') return res.status(422).json({ error: 'Los chequeos previos no pasan', checks: result.checks });
    if (result.error) return res.status(409).json({ error: `Solo se aprueban historias en revisión (estado actual: ${result.status || 'desconocido'})` });
    res.json({ post: result.post });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const result = await stories.cancelPost(req.orgId, req.params.id, actorOf(req));
    if (result.error === 'not_found') return notFound(res);
    if (result.error) return res.status(409).json({ error: `No se puede cancelar una historia en estado ${result.status}` });
    res.json({ post: result.post });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
