const jwt = require('jsonwebtoken');
const db = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'cambiar_en_produccion_secret_muy_largo';

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, orgId: user.organization_id, role: user.role },
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

function requireAuth(req, res, next) {
  // Aceptar token por header Authorization O por query param _token (para redirects OAuth)
  let token;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.query._token) {
    token = req.query._token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.orgId  = payload.orgId;
    req.role   = payload.role;
  } catch {
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }

  const allowedPrefixes = RESTRICTED_ROLE_PREFIXES[req.role];
  if (allowedPrefixes) {
    const url = req.originalUrl || req.url || '';
    const allowed = allowedPrefixes.some(p => url.startsWith(p));
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

module.exports = { generateToken, requireAuth, requireRole, JWT_SECRET, REPARTIDOR_ALLOWED_PREFIXES, COORDINADOR_ALLOWED_PREFIXES };
