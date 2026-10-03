import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createServer(handle) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) return res.writeHead(413).end(); }
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return res.writeHead(400).end('{"error":"Bad JSON"}'); }
      const cookie = /(?:^|;\s*)token=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
      const out = handle(req.method, url.pathname, body, cookie);
      const headers = { 'Content-Type': 'application/json' };
      if (out.token) headers['Set-Cookie'] = `token=${out.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
      res.writeHead(out.status, headers).end(JSON.stringify(out.body));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const data = await readFile(join(PUBLIC, rel));
      res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(data);
    } catch { res.writeHead(404).end('Not found'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createServer(createApp(openDb(process.env.DB_PATH ?? 'carpool.db'))).listen(port, () =>
    console.log(`Carpool running at http://localhost:${port}`));
}
