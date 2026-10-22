// The one request handler used by both the local/VPS server (server.js) and the Vercel function (api/index.js).
const fs = require('node:fs');
const path = require('node:path');
const { one } = require('./db');
const { HttpError, clientIp, isHttps } = require('./security');
const { send } = require('./http');
const { ensureReady } = require('./setup');
const { handleApi, handleHook } = require('./api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// Per-instance request budget: slows scraping and brute force without affecting normal use (the call screen polls ~1/sec).
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
const overLimit = (ip, max) => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > max; };

async function handle(req, res, opts = {}) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { // for load balancers / uptime checks; reveals nothing
    try { await ensureReady(); await one('SELECT 1 AS ok'); res.writeHead(200); return res.end('ok'); } catch { res.writeHead(503); return res.end('db'); }
  }
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  try {
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (overLimit(clientIp(req), 900)) throw new HttpError(429, 'Too many requests. Slow down.');
      await ensureReady();
      await handleApi(req, res, url);
    } else if (url.pathname.startsWith('/hooks/')) {
      await ensureReady();
      await handleHook(req, res, url);
    } else if (opts.static) serveStatic(req, res, url);
    else { res.writeHead(404); res.end('Not found'); }
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    send(res, 500, { error: 'Internal server error' });
  }
}

module.exports = { handle };
