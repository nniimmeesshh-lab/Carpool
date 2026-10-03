// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), using only node:crypto.
import { createECDH, createPrivateKey, createSign, generateKeyPairSync, hkdfSync, createCipheriv, randomBytes } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');

// Browsers' push services. Subscriptions pointing anywhere else are refused, because the server
// POSTs to the subscription endpoint and must not be steerable at internal addresses (SSRF).
const DEFAULT_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function isAllowedEndpoint(endpoint, extra = (process.env.PUSH_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || endpoint.length > 600) return false;
  return [...DEFAULT_HOSTS, ...extra].some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

export function validKeys(keys) {
  try {
    const p256dh = unb64u(keys?.p256dh), auth = unb64u(keys?.auth);
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return false;
    const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(p256dh); // throws if not a curve point
    return true;
  } catch { return false; }
}

/** Encrypts `plaintext` for a subscription {p256dh, auth} (base64url). Returns the request body Buffer. */
export function encrypt({ p256dh, auth }, plaintext, { ecdh, salt = randomBytes(16) } = {}) {
  const as = ecdh ?? (() => { const e = createECDH('prime256v1'); e.generateKeys(); return e; })();
  const ua = unb64u(p256dh), asPub = as.getPublicKey();
  const secret = as.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync('sha256', secret, unb64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = last record delimiter
  if (data.length > 4096 - 17) throw new Error('payload too large');
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = asPub.length;
  return Buffer.concat([header, asPub, body]);
}

/** Loads (or creates once and stores) the server's VAPID key pair. */
export function loadVapid(db, env = process.env) {
  if (env.VAPID_PRIVATE_JWK) return fromJwk(JSON.parse(env.VAPID_PRIVATE_JWK));
  const row = db.prepare("SELECT value FROM settings WHERE key='vapid'").get();
  if (row) return fromJwk(JSON.parse(row.value));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(jwk));
  return fromJwk(jwk);
}
const fromJwk = (jwk) => ({
  privateKey: createPrivateKey({ key: jwk, format: 'jwk' }),
  publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
});

export function vapidAuth({ privateKey, publicKey }, endpoint, subject, nowMs = Date.now()) {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject };
  const input = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' + b64u(JSON.stringify(claims));
  const sig = createSign('SHA256').update(input).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${publicKey}`;
}

export function createPusher({ vapid, subject, fetchImpl = fetch, now = Date.now }) {
  return {
    publicKey: vapid.publicKey,
    /** Resolves {status, gone}. gone = the subscription is dead and should be deleted. */
    async send(sub, payload) {
      if (!isAllowedEndpoint(sub.endpoint)) return { status: 0, gone: true };
      const res = await fetchImpl(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuth(vapid, sub.endpoint, subject, now()),
          'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
        },
        body: encrypt(sub, JSON.stringify(payload)),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      return { status: res.status, gone: res.status === 404 || res.status === 410 };
    },
  };
}
