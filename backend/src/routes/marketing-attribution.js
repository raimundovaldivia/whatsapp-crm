const router = require('express').Router();
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { summarizeJourneys } = require('../services/lead-journey');

router.use(requireAuth, requireRole('owner', 'admin'));

router.post('/recover-orders', async (req, res) => {
  try {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.body?.from || '');
    const to = String(req.body?.to || '');
    const provider = String(req.body?.provider || '');
    if (!datePattern.test(from) || !datePattern.test(to) || !['evolution', 'kapso', 'meta'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Indica fechas válidas y el canal que tuvo la incidencia' });
    }
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    const days = Math.round((end - start) / 86400000);
    if (!Number.isFinite(days) || days < 0 || days > 6) {
      return res.status(400).json({ success: false, error: 'La recuperación debe abarcar entre 1 y 7 días' });
    }
    const campaignName = String(req.body?.campaignName || `Hacienda Diez Ríos · recuperación ${provider}`)
      .trim().slice(0, 120);
    const data = await db.recoverWhatsappAttributionsFromOrders(req.orgId, req.userId, {
      from,
      to,
      provider,
      campaignName,
      firstPurchaseOnly: req.body?.firstPurchaseOnly === true,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('[MarketingAttribution:RecoverOrders]', error.message);
    res.status(500).json({ success: false, error: 'No se pudieron recuperar los pedidos manuales' });
  }
});

router.get('/funnel', async (req, res) => {
  try {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const from = datePattern.test(String(req.query.from || '')) ? req.query.from : null;
    const to = datePattern.test(String(req.query.to || '')) ? req.query.to : null;
    const provider = ['evolution', 'kapso', 'meta'].includes(req.query.provider) ? req.query.provider : null;
    const rows = await db.getLeadJourneyRows(req.orgId, { from, to, provider });
    res.json({ success: true, data: summarizeJourneys(rows) });
  } catch (error) {
    console.error('[MarketingAttribution:Funnel]', error.message);
    res.status(500).json({ success: false, error: 'No se pudo calcular el embudo de conversaciones' });
  }
});

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
