const { authenticateToken } = require('../middleware/auth');
const CHAT_ROLES = new Set(['owner', 'admin', 'supervisor', 'agent']);
function configureSocketAuth(io) {
  io.use(async (socket, next) => {
    try {
      const user = await authenticateToken(socket.handshake.auth?.token);
      if (!CHAT_ROLES.has(user.role)) throw new Error('Sin acceso a conversaciones');
      socket.data.user = user;
      next();
    } catch { next(new Error('No autorizado')); }
  });
  io.on('connection', socket => {
    socket.join(`org_${socket.data.user.organization_id}`);
    const timer = setInterval(async () => {
      try { await authenticateToken(socket.handshake.auth?.token); }
      catch { socket.disconnect(true); }
    }, 15000);
    timer.unref?.();
    socket.on('disconnect', () => clearInterval(timer));
  });
}
module.exports = { configureSocketAuth };
