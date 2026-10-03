import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, createVerify, createDecipheriv, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { encrypt, unb64u, b64u, vapidAuth, loadVapid, createPusher, isAllowedEndpoint, validKeys } from '../src/push.js';

// RFC 8291 appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// What a browser does on receipt (RFC 8291 §3.4)
function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const uaPub = uaEcdh.getPublicKey();
  const secret = uaEcdh.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync('sha256', secret, unb64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2);
  return plain.subarray(0, -1).toString();
}
const device = () => {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { ecdh: e, keys: { p256dh: b64u(e.getPublicKey()), auth: b64u(Buffer.alloc(16, 7)) } };
};
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

test('encryption matches the RFC 8291 test vector, and our decrypt reads the RFC ciphertext', () => {
  const as = createECDH('prime256v1'); as.setPrivateKey(unb64u(RFC.asPrivate));
  const out = encrypt({ p256dh: RFC.uaPublic, auth: RFC.auth }, RFC.plaintext, { ecdh: as, salt: unb64u(RFC.salt) });
  assert.equal(b64u(out), RFC.body);
  const ua = createECDH('prime256v1'); ua.setPrivateKey(unb64u(RFC.uaPrivate));
  assert.equal(decrypt(unb64u(RFC.body), ua, RFC.auth), RFC.plaintext);
});

test('endpoint allowlist blocks internal and non-push hosts', () => {
  assert.ok(isAllowedEndpoint(ENDPOINT));
  assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(isAllowedEndpoint('https://web.push.apple.com/x'));
  for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/x',
    'https://fcm.googleapis.com.evil.com/x', 'https://evilfcm.googleapis.com@evil.com/x', 'https://fcm.googleapis.com:8443/x', 'nonsense'])
    assert.equal(isAllowedEndpoint(bad, []), false, bad);
  assert.ok(isAllowedEndpoint('https://push.example.org/x', ['example.org']));
});

test('VAPID: signature verifies against the advertised public key; key persists in the DB', () => {
  const db = openDb();
  const v = loadVapid(db, {});
  assert.equal(loadVapid(db, {}).publicKey, v.publicKey); // stable across restarts
  const hdr = vapidAuth(v, ENDPOINT, 'mailto:a@b.co', 1_900_000_000_000);
  const [, jwt, k] = /^vapid t=(\S+), k=(\S+)$/.exec(hdr);
  assert.equal(k, v.publicKey);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(unb64u(c)), { aud: 'https://fcm.googleapis.com', exp: 1_900_000_000 + 43200, sub: 'mailto:a@b.co' });
  const pub = unb64u(k);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(createVerify('SHA256').update(`${h}.${c}`).verify({ key, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
});

test('pusher sends an encrypted, signed request the device can read', async () => {
  const db = openDb(), dev = device(), seen = [];
  const pusher = createPusher({ vapid: loadVapid(db, {}), subject: 'mailto:a@b.co',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 201 }; } });
  const r = await pusher.send({ endpoint: ENDPOINT, ...dev.keys }, { title: 'Hi', body: 'Ann is on the way' });
  assert.deepEqual(r, { status: 201, gone: false });
  assert.equal(seen[0].url, ENDPOINT);
  assert.equal(seen[0].init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen[0].init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(JSON.parse(decrypt(seen[0].init.body, dev.ecdh, dev.keys.auth)), { title: 'Hi', body: 'Ann is on the way' });
  const gone = createPusher({ vapid: loadVapid(db, {}), subject: 'x', fetchImpl: async () => ({ status: 410 }) });
  assert.equal((await gone.send({ endpoint: ENDPOINT, ...dev.keys }, {})).gone, true);
  const blocked = await pusher.send({ endpoint: 'https://localhost/x', ...dev.keys }, {});
  assert.equal(blocked.gone, true); assert.equal(seen.length, 1); // never fetched
});

test('app: subscribe validation, notifications trigger push, dead subs removed, unsubscribe', async () => {
  const db = openDb(), sent = []; let status = 201;
  const push = { publicKey: 'PUBKEY', send: async (sub, payload) => { sent.push({ sub, payload }); return { status, gone: status === 410 }; } };
  const h = createApp(db, { push });
  const su = (n) => { const r = h('POST', '/api/signup', { name: n, email: `${n}@x.com`, password: 'password1' }); return (m, p, b) => h(m, p, b, r.token); };
  const ann = su('ann'), bob = su('bob');
  const dev = device();
  assert.equal(bob('GET', '/api/push/key').body.key, 'PUBKEY');
  assert.equal(h('GET', '/api/push/key').status, 401);
  assert.equal(bob('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: dev.keys }).status, 400);
  assert.equal(bob('POST', '/api/push/subscribe', { endpoint: ENDPOINT, keys: { p256dh: 'AAAA', auth: 'AAAA' } }).status, 400);
  assert.equal(bob('POST', '/api/push/subscribe', { endpoint: ENDPOINT, keys: dev.keys }).status, 200);

  const pool = ann('POST', '/api/pools', { name: 'P' }).body;
  bob('POST', '/api/pools/join', { code: pool.code });
  ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: '2030-05-08', time: '08:00', place: 'School' });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.body, /ann added Drop-off/);
  assert.equal(sent[0].sub.endpoint, ENDPOINT);
  assert.equal(ann('GET', '/api/notifications').body.items.length, 0); // actor: no push either

  // the same device now belongs to ann (shared phone): bob stops receiving
  assert.equal(ann('POST', '/api/push/subscribe', { endpoint: ENDPOINT, keys: dev.keys }).status, 200);
  bob('POST', '/api/rides/1/drive');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 2); assert.equal(sent[1].payload.tag, 'ride-1'); // ann is told bob will drive
  // bob can't unsubscribe someone else's device
  bob('POST', '/api/push/unsubscribe', { endpoint: ENDPOINT });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 1);
  // 410 from the push service prunes the subscription
  status = 410;
  bob('PATCH', '/api/rides/1', { place: 'Gate 2' }); // driver edit -> notifies creator ann
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 0);
  assert.equal(validKeys(dev.keys), true);
});
