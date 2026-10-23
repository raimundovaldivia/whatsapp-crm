const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createGateway({ password, root, upstream = 'http://qa-api.railway.internal:3001', secure = true }) {
  if (!password || password.length < 24) throw new Error('QA access password required');
  const backend = new URL(upstream);
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
  const basic = 'Basic ' + Buffer.from('qa:' + password).toString('base64');
  const session = crypto.createHmac('sha256', password).update('qa-gateway-session-v1').digest('hex');
  const cookieName = 'crm_qa_access';
  const sessionCookie = `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const attempts = new Map();
  function loginPage(res, status = 200, message = '') {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acceso al CRM de prueba</title><style>
      *{box-sizing:border-box}body{margin:0;min-height:100dvh;padding:24px;display:grid;place-items:center;background:#111b21;color:#e9edef;font-family:system-ui,sans-serif}main{width:100%;max-width:420px;background:#202c33;padding:32px;border:1px solid #374045;border-radius:16px}.badge{color:#57dbb8;font-size:12px;font-weight:700;letter-spacing:.08em}h1{font-size:26px;margin:12px 0}p{color:#b4c1c9;line-height:1.6}form{display:grid;gap:18px;margin-top:24px}label{display:grid;gap:8px;font-size:14px}input,button{font:inherit;width:100%;min-height:48px;border-radius:8px;padding:12px}input{border:1px solid #667781;background:#111b21;color:#e9edef}input:focus-visible,button:focus-visible{outline:3px solid #57dbb8;outline-offset:3px}button{background:#00a884;color:#071d17;font-weight:700;border:0;cursor:pointer}.error{color:#ffb4b4}.note{font-size:13px;margin-bottom:0}@media(max-width:400px){body{padding:16px}main{padding:24px}}
    </style></head><body><main><span class="badge">ENTORNO DE PRUEBA</span><h1>Acceso al CRM</h1><p>Ingresa para revisar y probar la app con datos ficticios.</p>${message ? `<p class="error" role="alert">${message}</p>` : ''}<form method="post" action="/qa-login"><label>Usuario<input name="username" type="text" autocomplete="username" value="qa" required maxlength="100"></label><label>Contraseña<input name="password" type="password" autocomplete="current-password" required maxlength="4096"></label><button type="submit">Entrar al entorno de prueba</button></form><p class="note">Después podrás iniciar sesión con tu cuenta de prueba del CRM.</p></main></body></html>`);
  }
  async function login(req, res) {
    // Only this origin can submit the form; credentials never enter a URL or logs.
    let origin;
    try { origin = new URL(req.headers.origin); } catch { /* fail closed */ }
    if (!origin || origin.host !== req.headers.host || origin.protocol !== (secure ? 'https:' : 'http:')) { res.writeHead(403); res.end('Origen no permitido'); return; }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') { res.writeHead(415); res.end(); return; }
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.socket.remoteAddress;
    const entry = attempts.get(key) || { count: 0, until: now + 60000 };
    if (entry.count >= 20 || (!attempts.has(key) && attempts.size >= 1000)) {
      res.setHeader('Retry-After', '60'); loginPage(res, 429, 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.'); return;
    }
    entry.count++; attempts.set(key, entry);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
    } catch { if (!res.destroyed) { res.writeHead(400); res.end(); } return; }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (!same(form.get('username') || '', 'qa') || !same(form.get('password') || '', password)) {
      loginPage(res, 401, 'Usuario o contraseña incorrectos.'); return;
    }
    attempts.delete(key);
    res.writeHead(303, { Location: '/', 'Set-Cookie': sessionCookie }); res.end();
  }
  function allowed(req) {
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='));
    return same(req.headers.authorization || '', basic) || same(cookie?.slice(cookieName.length + 1) || '', session);
  }
  function headers(req) {
    const result = { ...req.headers, host: backend.host, origin: '' };
    delete result.cookie;
    if (result.authorization?.startsWith('Basic ')) delete result.authorization;
    return result;
  }
  const proxyPath = /^\/(api|store|conversations|seguimiento|referido|r|socket\.io)(\/|$)/;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (['/qa-health', '/qa_health'].includes(req.url)) { res.end('qa-gateway'); return; }
    const requestPath = req.url.split('?')[0];
    if (requestPath === '/qa-login') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (allowed(req)) { res.writeHead(303, { Location: '/' }); res.end(); }
        else if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(); }
        else loginPage(res);
      } else if (req.method === 'POST') {
        login(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('No se pudo iniciar sesión'); });
      } else { res.writeHead(405); res.end(); }
      return;
    }
    if (!allowed(req)) {
      if (['GET', 'HEAD'].includes(req.method) && !proxyPath.test(req.url)) {
        res.writeHead(303, { Location: '/qa-login' }); res.end(); return;
      }
      res.writeHead(401);
      res.end('QA: acceso restringido'); return;
    }
    res.setHeader('Set-Cookie', sessionCookie);
    if (proxyPath.test(req.url)) {
      const request = http.request({ hostname: backend.hostname, port: backend.port, method: req.method, path: req.url, headers: headers(req) }, response => {
        const responseHeaders = { ...response.headers };
        delete responseHeaders['set-cookie'];
        delete responseHeaders['cache-control'];
        res.writeHead(response.statusCode, responseHeaders); response.pipe(res);
      });
      request.setTimeout(120000, () => request.destroy());
      request.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('QA API no disponible'); });
      req.on('aborted', () => request.destroy()); req.pipe(request); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://qa.invalid').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    let file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    const stream = fs.createReadStream(file);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
    if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req) || !req.url.startsWith('/socket.io/')) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const request = http.request({ hostname: backend.hostname, port: backend.port, path: req.url, headers: headers(req) });
    request.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.on('error', () => upstreamSocket.destroy()); upstreamSocket.on('error', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy()); upstreamSocket.on('close', () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
    });
    request.on('response', response => { response.resume(); socket.destroy(); });
    request.on('error', () => socket.destroy()); request.end();
  });
  return server;
}
if (require.main === module) {
  if (process.env.RAILWAY_PROJECT_NAME !== 'whatsapp-crm-qa' || process.env.RAILWAY_ENVIRONMENT_NAME !== 'qa') throw new Error('QA project required');
  createGateway({ password: process.env.QA_ACCESS_PASSWORD, root: '/app/dist' }).listen(Number(process.env.PORT || 8080), '::');
}
module.exports = { createGateway };
