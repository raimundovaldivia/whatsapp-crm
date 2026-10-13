'use strict';

const router = require('express').Router();
const db = require('../db/database');
const { shouldCountTrackingRequest } = require('../services/lead-journey');

router.get('/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{12}$/.test(token)) return res.status(404).send('Enlace no encontrado');
  try {
    const link = await db.getConversationTrackingLinkByToken(token);
    if (!link) return res.status(404).send('Enlace no encontrado');
    if (shouldCountTrackingRequest(req.method, req.get('user-agent'))) {
      await db.recordConversationTrackingClick(link.id);
    }
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, link.destination_url);
  } catch (error) {
    console.error('[TrackingLink]', error.message);
    return res.status(503).send('El enlace no está disponible en este momento');
  }
});

module.exports = router;
