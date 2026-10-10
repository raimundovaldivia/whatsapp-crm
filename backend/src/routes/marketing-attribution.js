const router = require('express').Router();
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('owner', 'admin'));

router.get('/', async (req, res) => {
  try {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const from = datePattern.test(String(req.query.from || '')) ? req.query.from : null;
    const to = datePattern.test(String(req.query.to || '')) ? req.query.to : null;
    const provider = ['evolution', 'kapso', 'meta'].includes(req.query.provider) ? req.query.provider : null;
    const basis = req.query.basis === 'purchase' ? 'purchase' : 'contact';
    const data = basis === 'purchase'
      ? await db.getWhatsappBuyerReport(req.orgId, { from, to, provider })
      : await db.getWhatsappAttributionReport(req.orgId, { from, to, provider });
    data.basis = basis;
    res.json({ success: true, data });
  } catch (error) {
    console.error('[MarketingAttribution]', error.message);
    res.status(500).json({ success: false, error: 'No se pudo cargar la atribución de campañas' });
  }
});

module.exports = router;
