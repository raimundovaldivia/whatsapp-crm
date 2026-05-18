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
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ success: false, error: 'Sin permisos suficientes' });
    }
    next();
  };
}

module.exports = { generateToken, requireAuth, requireRole, JWT_SECRET };
