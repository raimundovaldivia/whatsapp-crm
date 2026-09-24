const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const db = require('../db/database');
const service = require('../services/commercial');
const { SOLUTIONS, KEYS } = require('../services/solution-catalog');
const run = fn => async (req,res) => { try { await fn(req,res); } catch (e) { console.error('[Commercial]',e.message); res.status(e.status || 503).json({ error: e.status ? e.message : 'No se pudo cargar la información comercial', code:e.code }); } };
router.get('/catalog', (_req,res) => res.json({ catalog: SOLUTIONS, billingMode:'assisted', base: ['Conversaciones','Clientes','Equipo','Integraciones'] }));
router.use(requireAuth);
router.get('/me', run(async (req,res) => res.json({ ...await service.summary(req.orgId), platformAdmin: service.isPlatformAdmin(req.userId) })));
router.post('/requests', requireRole('owner','admin'), run(async (req,res) => {
  if (!KEYS.includes(req.body.module) || (req.body.note !== undefined && (typeof req.body.note !== 'string' || req.body.note.length > 1000))) return res.status(400).json({error:'Solicitud inválida'});
  if (await service.permitted(req.orgId,req.body.module)) return res.status(409).json({error:'Este módulo ya está disponible'});
  const result = await db.getPool().query(`INSERT INTO commercial_requests(organization_id,module_key,requested_by,note) VALUES($1,$2,$3,$4)
    ON CONFLICT(organization_id,module_key) WHERE status='pending' DO NOTHING RETURNING id`, [req.orgId,req.body.module,req.userId,req.body.note || '']);
  res.status(result.rowCount ? 201 : 200).json({success:true});
}));
// Platform operators are provisioned by deployment configuration, never tenant roles or registration payloads.
router.use('/admin', (req,res,next) => service.isPlatformAdmin(req.userId) ? next() : res.status(403).json({error:'Acceso exclusivo de administración comercial'}));
router.get('/admin/organizations', run(async (req,res) => {
  const search = String(req.query.search || '').slice(0,100);
  const offset = Math.max(0,Math.min(1000000,parseInt(req.query.offset,10)||0));
  const result = await db.getPool().query(`SELECT o.id,o.name,o.slug,o.created_at,c.status,c.expires_at,
    (SELECT count(*)::int FROM commercial_requests r WHERE r.organization_id=o.id AND r.status='pending') pending_requests
    FROM organizations o LEFT JOIN commercial_contracts c ON c.organization_id=o.id
    WHERE o.name ILIKE $1 OR o.slug ILIKE $1 ORDER BY o.id DESC LIMIT 50 OFFSET $2`, ['%'+search+'%',offset]);
  res.json({organizations:result.rows,offset});
}));
router.get('/admin/organizations/:id', run(async (req,res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Tienda inválida'});
  const org = await db.getOrgById(req.params.id);
  if (!org) return res.status(404).json({error:'Tienda no encontrada'});
  const audit = await db.getPool().query('SELECT id,actor_id,action,reason,created_at FROM commercial_audit WHERE organization_id=$1 ORDER BY id DESC LIMIT 50',[org.id]);
  res.json({...await service.summary(org.id),organization:{id:org.id,name:org.name,slug:org.slug},audit:audit.rows});
}));
router.put('/admin/organizations/:id/contract', run(async (req,res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Tienda inválida'});
  res.json({contract:await service.updateContract(req.params.id,req.userId,req.body)});
}));
router.post('/admin/requests/:id/decline', run(async (req,res) => {
  if (!/^\d+$/.test(req.params.id) || typeof req.body.reason !== 'string' || req.body.reason.trim().length<5 || req.body.reason.length>1000) return res.status(400).json({error:'Indica un motivo válido'});
  const result = await db.getPool().query(`WITH changed AS (UPDATE commercial_requests SET status='declined',resolved_at=NOW() WHERE id=$1 AND status='pending' RETURNING *)
    INSERT INTO commercial_audit(organization_id,actor_id,action,after_value,reason)
    SELECT organization_id,$2,'request.declined',to_jsonb(changed),$3 FROM changed RETURNING id`, [req.params.id,req.userId,req.body.reason.trim()]);
  res.status(result.rowCount?200:409).json({success:!!result.rowCount});
}));
module.exports = router;
