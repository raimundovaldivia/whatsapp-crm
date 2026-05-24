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
const shopifyWebhookRouter = require('./routes/shopify-webhook'); // Shopify eventos
const shopifyOAuthRouter   = require('./routes/shopify-oauth');   // Shopify OAuth flow
const authRouter           = require('./routes/auth');
const setupRouter          = require('./routes/setup');
const conversationsRouter  = require('./routes/conversations');
const ordersRouter         = require('./routes/orders');
const settingsRouter       = require('./routes/settings');
const catalogoRouter       = require('./routes/catalogo');
const reengagementRouter   = require('./routes/reengagement');
const clientesRouter       = require('./routes/clientes');
const templatesRouter      = require('./routes/templates');

const app    = express();
const server = http.createServer(app);

// ─── SOCKET.IO — Notificaciones en tiempo real al panel ──────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

// Pasar Socket.IO a los routers que lo necesitan
webhookRouter.setSocketIO(io);
twilioWebhookRouter.setSocketIO(io);
kapsoWebhookRouter.setSocketIO(io);
shopifyWebhookRouter.setSocketIO(io);
conversationsRouter.setSocketIO(io);

io.on('connection', (socket) => {
  socket.on('join_org', (orgId) => {
    socket.join(`org_${orgId}`);
    console.log(`[Socket.io] Panel conectado → org_${orgId}`);
  });
});

// ─── CORS ────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// ─── BODY PARSERS ────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/twilio-webhook')) {
    express.urlencoded({ extended: false })(req, res, next);
  } else if (req.path.startsWith('/shopify-webhook')) {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk.toString(); });
    req.on('end', () => {
      req.rawBody = rawBody;
      try { req.body = JSON.parse(rawBody); } catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

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
app.use('/api/orders',        ordersRouter);         // Pedidos
app.use('/api/settings',      settingsRouter);       // Ajustes del CRM
app.use('/api/catalogo',      catalogoRouter);       // Catálogo de productos
app.use('/api/reengagement',  reengagementRouter);  // Re-enganche de clientes dormidos
app.use('/api/clientes',      clientesRouter);      // Lista completa de clientes
app.use('/api/templates',     templatesRouter);     // WhatsApp Message Templates

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
    console.log(`   Panel frontend  : ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
    console.log(`   Shopify app     : ${process.env.RAIGENTIC_URL || 'https://raigentic.onrender.com'}\n`);
  });
}).catch(err => {
  console.error('Error iniciando DB:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('[Error no manejado]', err));
