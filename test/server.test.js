import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';

async function withServer(opts, fn) {
  const server = createServer(createApp(openDb()), opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('http: security headers, CSRF guards, cookies', async () => {
  await withServer({}, async (base) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('strict-transport-security'), null); // plain http

    const form = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    assert.equal(form.status, 415);
    const cross = await post(base, '/api/login', {}, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);

    const up = await post(base, '/api/signup', { name: 'A', email: 'a@b.co', password: 'password1' });
    const cookie = up.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/);
    const me = await fetch(base + '/api/me', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(me.status, 200);
    const out = await post(base, '/api/logout', {}, { Cookie: cookie.split(';')[0] });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(base + '/..%2f..%2fpackage.json')).status, 404);
  });
});

test('http: behind a TLS proxy the cookie is Secure and HSTS is sent', async () => {
  await withServer({ trustProxy: true }, async (base) => {
    const h = { 'X-Forwarded-Proto': 'https' };
    const up = await post(base, '/api/signup', { name: 'A', email: 'a@b.co', password: 'password1' }, h);
    assert.match(up.headers.get('set-cookie'), /; Secure/);
    assert.match((await fetch(base + '/', { headers: h })).headers.get('strict-transport-security'), /max-age/);
  });
});
