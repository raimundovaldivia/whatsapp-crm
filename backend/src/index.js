/**
 * WhatsApp CRM — Servidor principal
 *
 * Arquitectura:
 *   /webhook              ← Meta envía aquí los mensajes de WhatsApp
 *   /twilio-webhook       ← Twilio envía aquí los mensajes de WhatsApp
 *   /shopify-webhook/:id  ← Shopify envía aquí eventos de órdenes (pagos, cancelaciones)
 *   /api/auth             ← Login / registro de usuarios
 *   /api/setup            ← Wizard de configuración inicial
 *   /api/conversations    ← Conversaciones y mensajes
 *   /api/orders           ← Pedidos
 *   /api/settings         ← Ajustes del CRM
 */

require('dotenv').config();
const express  = require('express');
const http     = require('http');
const path     = require('path');
const { Server } = require('socket.io');
const cors     = require('cors');

const isProd = process.env.NODE_ENV === 'production';

// Rutas
const webhookRouter        = require('./routes/webhook');         // WhatsApp (Meta)
const twilioWebhookRouter  = require('./routes/twilio-webhook'); // WhatsApp (Twilio)
const kapsoWebhookRouter   = require('./routes/kapso-webhook');  // WhatsApp (Kapso)
const { startFollowUpJob } = require('./services/follow-up');   // Job 24h follow-up
const { startScheduledFollowUpJob } = require('./services/scheduled-follow-up'); // Job pedidos agendados
const { startAdminWindowJob } = require('./services/admin-notify');
const { startEscalationWatchJob } = require('./services/escalation-watch'); // Recordatorio si una escalación queda sin respuesta              // Aviso previo + cola de alertas admin
const shopifyWebhookRouter = require('./routes/shopify-webhook'); // Shopify eventos
const shopifyOAuthRouter   = require('./routes/shopify-oauth');   // Shopify OAuth flow
const authRouter           = require('./routes/auth');
const setupRouter          = require('./routes/setup');
const conversationsRouter  = require('./routes/conversations');
const ordersRouter         = require('./routes/orders');
const settingsRouter       = require('./routes/settings');
const catalogoRouter       = require('./routes/catalogo');
const clientesRouter       = require('./routes/clientes');
const templatesRouter      = require('./routes/templates');
const dashboardRouter      = require('./routes/dashboard');
const assistantRouter      = require('./routes/assistant');    // Asistente IA del CRM
const paymentProofsRouter  = require('./routes/payment-proofs'); // Comprobantes de pago
const productsRouter       = require('./routes/products');       // Productos propios
const storeRouter          = require('./routes/store');          // Tienda pública
const storeSettingsRouter  = require('./routes/store-settings'); // Ajustes editables de la tienda
const contactsRouter       = require('./routes/contacts');        // Contactos (leads y clientes)
const reconciliationRouter = require('./routes/reconciliation');  // Conciliación bancaria (cartola ↔ pedidos)
const deliveryRouter       = require('./routes/delivery');         // App mobile de repartidor
const usersRouter          = require('./routes/users');            // Gestión de usuarios (RBAC)
const adminAlertsRouter    = require('./routes/admin-alerts');      // Cola de alertas al admin
const reengagementRouter   = require('./routes/reengagement');     // Mensajería masiva y re-enganche
const pushRouter           = require('./routes/push');             // Tokens push de la app Central (admin)
const botEvalRouter        = require('./routes/bot-eval');          // Evaluación del bot y ciclo de mejora

const app    = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean);
const checkOrigin = (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
const io = new Server(server, { cors: { origin: checkOrigin, methods: ['GET', 'POST'] } });
require('./services/socket-auth').configureSocketAuth(io);

// Pasar Socket.IO a los routers que lo necesitan
webhookRouter.setSocketIO(io);
twilioWebhookRouter.setSocketIO(io);
kapsoWebhookRouter.setSocketIO(io);
shopifyWebhookRouter.setSocketIO(io);
conversationsRouter.setSocketIO(io);
ordersRouter.setSocketIO(io);
deliveryRouter.setSocketIO(io);
reengagementRouter.setSocketIO(io);   // Mensajería masiva: emitir mensajes al panel en vivo

app.use(cors({ origin: checkOrigin, credentials: false }));
const captureRaw = (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); };
app.use(express.json({ limit: '10mb', verify: captureRaw }));
app.use(express.urlencoded({ extended: false, limit: '1mb', verify: captureRaw }));
const { rateLimit } = require('express-rate-limit');
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/store', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.post('/store/:slug/orders', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }));

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

app.get('/ready', async (_req, res) => {
  try { await require('./db/database').getPool().query('SELECT 1'); res.json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

app.use('/api/commercial', require('./routes/commercial'));
app.use('/api', require('./middleware/commercial-access').commercialAccess);

// ─── RUTAS ───────────────────────────────────────────────────────
app.use('/webhook',           webhookRouter);        // POST — Meta webhook
app.use('/twilio-webhook',    twilioWebhookRouter);  // POST — Twilio webhook
app.use('/kapso-webhook',     kapsoWebhookRouter);   // POST — Kapso webhook
app.use('/shopify-webhook',   shopifyWebhookRouter); // POST — Shopify eventos
app.use('/shopify-oauth',     shopifyOAuthRouter);   // GET  — Shopify OAuth /connect y /callback (sin /api/ — redirect de Shopify)
app.use('/api/shopify-oauth', shopifyOAuthRouter);  // API  — /status y /disconnect (con /api/ — llamadas del frontend)
app.use('/api/auth',          authRouter);           // POST login/register
app.use('/api/setup',         setupRouter);          // Wizard configuración
app.use('/api/conversations', conversationsRouter);  // Chats y mensajes
app.use('/conversations',     conversationsRouter);  // compat: media proxy sin /api prefix
app.use('/api/orders',        ordersRouter);         // Pedidos
app.use('/api/settings',      settingsRouter);       // Ajustes del CRM
app.use('/api/catalogo',      catalogoRouter);       // Catálogo de productos
app.use('/api/clientes',      clientesRouter);      // Lista completa de clientes
app.use('/api/templates',     templatesRouter);     // WhatsApp Message Templates
app.use('/api/dashboard',     dashboardRouter);     // Dashboard de victorias
app.use('/api/assistant',     assistantRouter);     // Asistente IA del CRM
app.use('/api/payment-proofs', paymentProofsRouter); // Comprobantes de pago
app.use('/api/products',      productsRouter);       // Productos propios
app.use('/api/store-settings', storeSettingsRouter); // Ajustes editables de la tienda (con auth)
app.use('/api/contacts',      contactsRouter);       // Contactos: leads y clientes
app.use('/api/reconciliation', reconciliationRouter); // Conciliación bancaria
app.use('/api/delivery',      deliveryRouter);        // App mobile repartidor
app.use('/api/users',         usersRouter);           // Gestión de usuarios (RBAC)
app.use('/api/admin-alerts',  adminAlertsRouter);     // Cola de alertas al admin
app.use('/api/reengagement',  reengagementRouter);   // Mensajería masiva y re-enganche
app.use('/api/push',          pushRouter);           // Registro de tokens push (app Central)
app.use('/api/bot-eval',      botEvalRouter);        // Evaluación del bot y ciclo de mejora
app.use('/store',             storeRouter);           // Tienda pública (sin auth)

app.get('/api/webhook-inbox', require('./middleware/auth').requireAuth,
  require('./middleware/auth').requireRole('owner', 'admin'), async (req, res) => {
    try {
      const { rows } = await require('./db/database').getPool().query(
        "SELECT id, provider, status, created_at, updated_at FROM webhook_inbox WHERE organization_id = $1 AND status <> 'completed' ORDER BY id DESC LIMIT 100", [req.orgId]);
      res.json({ events: rows });
    } catch { res.status(503).json({ error: 'No disponible' }); }
  });

app.use((err, _req, res, _next) => {
  console.error('[HTTP]', err.message);
  res.status(err.status === 413 ? 413 : err.status === 400 ? 400 : 500).json({ error: 'Solicitud no procesada' });
});

// ─── ARRANCAR ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

const { setupDatabase } = require('./db/setup');

setupDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🤖 WhatsApp CRM — Puerto ${PORT}`);
    console.log(`   WhatsApp Meta   : POST /webhook`);
    console.log(`   WhatsApp Twilio : POST /twilio-webhook`);
    console.log(`   WhatsApp Kapso  : POST /kapso-webhook`);
    console.log(`   Shopify eventos : POST /shopify-webhook/:orgId`);
    console.log(`   Panel frontend  : ${process.env.FRONTEND_URL || 'http://localhost:5173'}\n`);
    require('./services/webhook-inbox').startWebhookWorker();
    startFollowUpJob(io);
    startScheduledFollowUpJob(io);
    startAdminWindowJob();
    startEscalationWatchJob();
  });
}).catch(err => {
  console.error('Error iniciando DB:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('[Error no manejado]', err));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  server.close();
  io.disconnectSockets(true);
  try {
    await require('./services/webhook-inbox').stopWebhookWorker();
    await require('./db/database').getPool().end();
    process.exit(0);
  } catch { process.exit(1); }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);


// Deploy marker: 2026-09-18T00:49:43Z (evaluacion del bot + app central)
