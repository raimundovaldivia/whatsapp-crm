const { requireAuth } = require('./auth');
const commercial = require('../services/commercial');
// Contract checks apply to the API, even when a client ignores hidden navigation.
const routes = { orders:'orders', delivery:'delivery', 'payment-proofs':'payments', reconciliation:'payments', products:'storefront', 'store-settings':'storefront', reengagement:'marketing', templates:'marketing', dashboard:'analytics', 'bot-eval':'sales_ai', assistant:'sales_ai' };
function requireSolution(key) {
  return async (req,res,next) => { try { await commercial.assertModule(req.orgId,key); next(); } catch(e) { res.status(e.status || 503).json({error:e.status?e.message:'No se pudo comprobar el acceso',code:e.code}); } };
}
function commercialAccess(req,res,next) {
  const key = routes[req.path.split('/')[1]];
  if (!key) return next();
  requireAuth(req,res,() => requireSolution(key)(req,res,next));
}
module.exports = { commercialAccess, requireSolution };
