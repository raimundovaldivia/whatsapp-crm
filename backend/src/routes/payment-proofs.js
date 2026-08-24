/**
 * payment-proofs.js — Comprobantes de pago recibidos por WhatsApp
 *
 * GET    /api/payment-proofs           → Lista comprobantes (filtrar por ?status=pending|verified|rejected)
 * GET    /api/payment-proofs/:id/image → Proxy de imagen desde WhatsApp API
 * PATCH  /api/payment-proofs/:id       → Marcar como verificado o rechazado
 */

const express       = require('express');
const router        = express.Router();
const db            = require('../db/database');
const kapsoService  = require('../services/kapso-whatsapp');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ── GET /api/payment-proofs ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const proofs = await db.getPaymentProofs(req.orgId, req.query.status || null);
    res.json({ proofs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/payment-proofs/:id/image ───────────────────────────────
// Descarga y retransmite la imagen desde la API de WhatsApp/Kapso.
// El media_id es permanente; la URL se regenera en cada llamada.
router.get('/:id/image', async (req, res) => {
  try {
    const proofs = await db.getPaymentProofs(req.orgId);
    const proof  = proofs.find(p => p.id === parseInt(req.params.id));
    if (!proof) return res.status(404).json({ error: 'Comprobante no encontrado' });

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc || wc.provider !== 'kapso') {
      return res.status(400).json({ error: 'Configuración de WhatsApp no disponible' });
    }

    const mediaInfo = await kapsoService.getMediaUrl(proof.media_id, wc);
    const { data, contentType } = await kapsoService.downloadMedia(mediaInfo.url, wc);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // caché 1h en el browser
    res.send(Buffer.from(data));
  } catch (err) {
    console.error('[PaymentProofs] Error al obtener imagen:', err.message);
    res.status(500).json({ error: 'No se pudo descargar la imagen' });
  }
});

// ── PATCH /api/payment-proofs/:id ───────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!['verified', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido. Usa: verified, rejected o pending' });
    }
    const proof = await db.updatePaymentProof(parseInt(req.params.id), { status, notes });
    if (!proof) return res.status(404).json({ error: 'Comprobante no encontrado' });

    // Si se verifica, marcar el pedido asociado como pagado
    if (status === 'verified' && proof.order_id) {
      await db.updateOrder(proof.order_id, { status: 'paid' }).catch(() => {});
    }

    res.json({ proof });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
