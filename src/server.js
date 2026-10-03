import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './mail.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "frame-src https://www.openstreetmap.org; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};

/**
 * trustProxy: when running behind a TLS-terminating proxy (Caddy, nginx, a PaaS), set TRUST_PROXY=1
 * so we honour X-Forwarded-Proto/For for the Secure cookie flag, HSTS and per-IP rate limits.
 */
export function createServer(handle, { trustProxy = false, tls = null } = {}) {
  const listener = async (req, res) => {
    const secure = !!req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const baseHeaders = { ...SECURITY_HEADERS, ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}) };
    const url = new URL(req.url, 'http://x');

    if (url.pathname.startsWith('/api/')) {
      const json = (status, obj, extra = {}) => res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }).end(JSON.stringify(obj));
      if (req.method !== 'GET') {
        // CSRF defence in depth on top of SameSite cookies: JSON content type (forms can't send it
        // cross-site without a CORS preflight, which we never grant) and a same-origin Origin header.
        if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return json(415, { error: 'Content-Type must be application/json' });
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(403, { error: 'Cross-origin request blocked' });
      }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) return json(413, { error: 'Request too large' }); }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json(400, { error: 'Bad JSON' }); }
      const cookie = /(?:^|;\s*)token=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
      const ip = (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
      const out = handle(req.method, url.pathname, body, cookie, ip);
      const extra = {};
      if (out.token) extra['Set-Cookie'] = `token=${out.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`;
      else if (out.token === '') extra['Set-Cookie'] = `token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
      return json(out.status, out.body, extra);
    }

    const rel = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + sep)) return res.writeHead(404, baseHeaders).end('Not found');
    try {
      const data = await readFile(file);
      res.writeHead(200, { ...baseHeaders, 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(data);
    } catch { res.writeHead(404, baseHeaders).end('Not found'); }
  };
  return tls ? https.createServer(tls, listener) : http.createServer(listener);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const tls = process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) } : null;
  const baseUrl = process.env.BASE_URL ?? `${tls ? 'https' : 'http'}://localhost:${port}`;
  const app = createApp(openDb(process.env.DB_PATH ?? 'carpool.db'), { mailer: createMailer(), baseUrl });
  setInterval(() => { try { app.runReminders(); } catch (e) { console.error('reminders failed', e); } }, 60_000).unref();
  createServer(app, { trustProxy: process.env.TRUST_PROXY === '1', tls }).listen(port, () => console.log(`Carpool running at ${baseUrl}`));
}
