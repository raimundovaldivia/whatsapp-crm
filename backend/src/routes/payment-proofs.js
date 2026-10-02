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
const { getPaymentProofMedia } = require('../services/payment-proof-media');
const paymentAccounts = require('../services/payment-accounts');
const { requireAuth, requireRole } = require('../middleware/auth');

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

// Vista principal de Pagos: cuenta corriente mensual por cliente/empresa.
router.get('/accounts', async (req, res) => {
  try {
    res.json({ success: true, ...(await paymentAccounts.getAccounts(req.orgId, req.query.month)) });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ── GET /api/payment-proofs/:id/image ───────────────────────────────
// Descarga y retransmite la imagen desde WhatsApp/Kapso. Los comprobantes
// nuevos guardan la URL directa firmada que llega en el webhook; los antiguos
// pueden guardar un media ID. El proxy debe aceptar ambos formatos.
router.get('/:id/image', async (req, res) => {
  try {
    const proofs = await db.getPaymentProofs(req.orgId);
    const proof  = proofs.find(p => p.id === parseInt(req.params.id));
    if (!proof) return res.status(404).json({ error: 'Comprobante no encontrado' });

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc || wc.provider !== 'kapso') {
      return res.status(400).json({ error: 'Configuración de WhatsApp no disponible' });
    }

    const { data, contentType } = await getPaymentProofMedia(req.orgId, proof.media_id, wc);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // caché 1h en el browser
    res.send(Buffer.from(data));
  } catch (err) {
    console.error('[PaymentProofs] Error al obtener imagen:', err.message, '| status:', err.response?.status);
    res.status(404).json({ error: 'La imagen del comprobante no está disponible. Intenta nuevamente o revisa el mensaje original.' });
  }
});

// ── PATCH /api/payment-proofs/:id ───────────────────────────────────
router.patch('/:id', requireRole('owner', 'admin', 'supervisor'), async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!['verified', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido. Usa: verified, rejected o pending' });
    }
    const proof = await db.updatePaymentProof(parseInt(req.params.id), { status, notes }, req.orgId);
    if (!proof) return res.status(404).json({ error: 'Comprobante no encontrado' });

    res.json({ proof });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
