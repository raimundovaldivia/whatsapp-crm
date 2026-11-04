// API de historias de Instagram programadas: crear, revisar, editar, aprobar y cancelar.
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireSolution } = require('../middleware/commercial-access');
const stories = require('../services/social-stories');
const { validateContent } = require('../services/social-publishing');

const router = express.Router();
router.use(requireAuth, requireRole('owner', 'admin'), requireSolution('marketing'));

const actorOf = req => `user:${req.userId}`;

function parseInput(body = {}, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Contenido inválido' };
  const out = {};
  if (body.revision !== undefined) {
    if (!Number.isInteger(body.revision) || body.revision < 0) return { error: 'Revisión inválida' };
    out.revision = body.revision;
  }
  for (const key of ['title', 'image_url', 'platform', 'media_type', 'message']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') return { error: `${key} debe ser texto` };
      out[key] = body[key].trim();
    }
  }
  if (out.title?.length > 120 || out.message?.length > 63206) return { error: 'Texto demasiado largo' };
  if (out.platform !== undefined && !['instagram_story','instagram','facebook'].includes(out.platform)) return { error: 'Plataforma inválida' };
  if (out.media_type !== undefined && !['text','image','video','reel'].includes(out.media_type)) return { error: 'Formato inválido' };
  if (body.image_url !== undefined) {
    const url = String(body.image_url || '').trim();
    if (url.length > 2000) return { error: 'URL demasiado larga' };
    out.image_url = url;
  }
  if (body.scheduled_for !== undefined) {
    if (typeof body.scheduled_for !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.scheduled_for)) return { error: 'La fecha debe incluir zona horaria' };
    const date = new Date(body.scheduled_for);
    if (Number.isNaN(date.getTime())) return { error: 'scheduled_for debe ser una fecha ISO válida' };
    const day = body.scheduled_for.slice(0, 10);
    const calendarDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== day) return { error: 'Fecha de calendario inválida' };
    out.scheduled_for = date.toISOString();
  }
  if (!partial) {
    const invalid = validateContent(out);
    if (invalid) return { error: invalid };
    if (!out.scheduled_for) return { error: 'scheduled_for es obligatorio' };
  }
  return { value: out };
}

const notFound = res => res.status(404).json({ error: 'Publicación no encontrada' });
router.param('id', (req, res, next, id) => {
  if (!/^[1-9]\d{0,14}$/.test(id)) return res.status(400).json({ error: 'Identificador inválido' });
  next();
});

router.get('/', async (req, res) => {
  try {
    if (req.query.status !== undefined && !['draft','review','approved','publishing','published','failed','cancelled'].includes(req.query.status)) return res.status(400).json({ error: 'Estado inválido' });
    if (req.query.scope !== undefined && !['stories','content'].includes(req.query.scope)) return res.status(400).json({ error: 'Vista inválida' });
    const posts = await stories.listPosts(req.orgId, { status: req.query.status, scope: req.query.scope });
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
    if (result.error === 'invalid') return res.status(400).json({ error: result.detail });
    if (result.error) return res.status(409).json({ error: 'La publicación cambió o ya no se puede editar. Actualiza la lista.' });
    res.json({ post: result.post, checks: result.post.checks });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const revision = req.body?.revision;
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) return res.status(400).json({ error: 'Revisión inválida' });
    const result = await stories.approvePost(req.orgId, req.params.id, actorOf(req), revision);
    if (result.error === 'not_found') return notFound(res);
    if (result.error === 'checks_failed') return res.status(422).json({ error: 'Los chequeos previos no pasan', checks: result.checks });
    if (result.error) return res.status(409).json({ error: 'La publicación cambió o ya no está en revisión. Actualiza la lista antes de aprobar.' });
    res.json({ post: result.post });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const result = await stories.cancelPost(req.orgId, req.params.id, actorOf(req));
    if (result.error === 'not_found') return notFound(res);
    if (result.error) return res.status(409).json({ error: `No se puede cancelar una publicación en estado ${result.status}` });
    res.json({ post: result.post });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
