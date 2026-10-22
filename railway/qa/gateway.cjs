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
    if (!allowed(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CRM QA", charset="UTF-8"' });
      res.end('QA: acceso restringido'); return;
    }
    res.setHeader('Set-Cookie', `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
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
