const jwt = require('jsonwebtoken');
const db = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET === 'cambiar_en_produccion_secret_muy_largo') {
  throw new Error('JWT_SECRET debe ser un secreto aleatorio de al menos 32 caracteres');
}
const VALID_ROLES = new Set(['owner', 'admin', 'supervisor', 'agent', 'coordinador', 'repartidor']);
async function authenticateToken(token) {
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  const user = await db.getUserById(payload.userId);
  if (!user || !VALID_ROLES.has(user.role) || user.organization_id !== payload.orgId ||
      user.role !== payload.role || Number(user.auth_version || 0) !== Number(payload.authVersion || 0)) {
    throw new Error('Sesión revocada');
  }
  return user;
}

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, orgId: user.organization_id, role: user.role, authVersion: user.auth_version || 0 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Rutas a las que puede acceder un usuario con rol 'repartidor'.
 *
 * El repartidor usa la app de despachos y nada más: no debe poder leer
 * conversaciones, clientes ni pedidos del CRM aunque tenga un token válido.
 * Se compara contra req.originalUrl porque requireAuth se monta por router
 * y req.path ahí ya viene recortado.
 */
const REPARTIDOR_ALLOWED_PREFIXES = ['/api/delivery', '/api/auth'];

// 'coordinador': cargo mixto. Reparte (app) Y arma/optimiza rutas en la web,
// pero SOLO ve el módulo de despachos: rutas, la bodega y los pedidos (para
// editar direcciones antes de optimizar). Nada de chats, clientes ni config.
const COORDINADOR_ALLOWED_PREFIXES = ['/api/delivery', '/api/auth', '/api/settings/warehouse', '/api/orders'];

// Roles restringidos a un subconjunto de rutas (por prefijo de URL).
const RESTRICTED_ROLE_PREFIXES = {
  repartidor:  REPARTIDOR_ALLOWED_PREFIXES,
  coordinador: COORDINADOR_ALLOWED_PREFIXES,
};

async function requireAuth(req, res, next) {
  // Query tokens are limited to read-only media, never administrative actions.
  let token;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.method === 'GET' && req.query._token && /\/(media\/|payment-proofs\/|expenses\/)/.test(req.originalUrl || req.path)) {
    token = req.query._token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }

  try {
    const user = await authenticateToken(token);
    req.userId = user.id;
    req.orgId = user.organization_id;
    req.role = user.role;
  } catch {
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }

  const allowedPrefixes = RESTRICTED_ROLE_PREFIXES[req.role];
  if (allowedPrefixes) {
    const url = (req.originalUrl || req.url || '').split('?')[0];
    const moduleRead = req.method === 'GET' && url === '/api/settings/modules';
    const allowed = moduleRead || allowedPrefixes.some(p => (url === p || url.startsWith(p + '/')));
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'Esta cuenta solo tiene acceso al módulo de despachos' });
    }
  }

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ success: false, error: 'Sin permisos suficientes' });
    }
    next();
  };
}

module.exports = { authenticateToken, generateToken, requireAuth, requireRole, JWT_SECRET, REPARTIDOR_ALLOWED_PREFIXES, COORDINADOR_ALLOWED_PREFIXES };
