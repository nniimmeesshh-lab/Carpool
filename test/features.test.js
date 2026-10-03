import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { rideStart, todayIn } from '../src/time.js';

const setup = (opts = {}) => {
  const mails = [];
  const clock = { t: Date.parse('2030-05-06T12:00:00Z') };
  const h = createApp(openDb(), { mailer: { send: async (m) => { mails.push(m); } }, now: () => clock.t, ...opts });
  const call = (token) => (m, p, b) => h(m, p, b, token);
  const signup = (name) => {
    const r = h('POST', '/api/signup', { name, email: `${name}@x.com`, password: 'password1' });
    assert.equal(r.status, 200);
    return call(r.token);
  };
  return { h, signup, mails, clock };
};
const flush = () => new Promise((r) => setImmediate(r));
const today = (clock) => todayIn('UTC', clock.t);
const unread = (u) => u('GET', '/api/notifications').body.items.map((i) => i.text);

function world() {
  const w = setup();
  const ann = w.signup('ann'), bob = w.signup('bob'), cat = w.signup('cat');
  const kid = bob('POST', '/api/kids', { name: 'Max' }).body.id;
  const pool = ann('POST', '/api/pools', { name: 'P' }).body;
  bob('POST', '/api/pools/join', { code: pool.code });
  cat('POST', '/api/pools/join', { code: pool.code });
  return { ...w, ann, bob, cat, kid, pool };
}

test('timezone helpers', () => {
  assert.equal(rideStart('2030-01-15', '08:00', 'UTC'), Date.parse('2030-01-15T08:00:00Z'));
  assert.equal(rideStart('2030-07-15', '08:00', 'America/New_York'), Date.parse('2030-07-15T12:00:00Z'));
  assert.equal(todayIn('Pacific/Auckland', Date.parse('2030-05-06T12:00:00Z')), '2030-05-07');
});

test('notifications: new ride, driver found, riders, cancel; email respects opt-out', async () => {
  const { ann, bob, cat, kid, pool, mails } = world();
  bob('PATCH', '/api/me', { email_notifs: false });
  const id = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: '2030-05-08', time: '08:00', place: 'School' }).body.ids[0];
  assert.match(unread(bob)[0], /ann added Drop-off .* needs a driver/);
  assert.equal(unread(ann).length, 0); // actor isn't notified
  assert.equal(bob('GET', '/api/me').body.unread, 1);
  bob('POST', '/api/notifications/read');
  assert.equal(bob('GET', '/api/me').body.unread, 0);
  await flush();
  assert.ok(mails.some((m) => m.to === 'cat@x.com'));
  assert.ok(!mails.some((m) => m.to === 'bob@x.com')); // opted out of email, still has in-app

  cat('POST', `/api/rides/${id}/drive`);
  assert.match(unread(ann)[0], /cat will drive/);
  bob('POST', `/api/rides/${id}/riders`, { kid_id: kid });
  assert.match(unread(cat)[0], /Max was added/);

  cat('DELETE', `/api/rides/${id}/drive`);
  assert.match(unread(bob)[0], /can no longer drive .* needs a driver/);
  ann('DELETE', `/api/rides/${id}`);
  assert.match(unread(bob)[0], /ann cancelled/);
});

test('editing: permissions, seat floor, notifications, reassign', () => {
  const { ann, bob, cat, kid, pool } = world();
  const id = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: '2030-05-08', time: '15:00', place: 'School', seats: 2, drive: true }).body.ids[0];
  bob('POST', `/api/rides/${id}/riders`, { kid_id: kid });
  assert.equal(cat('PATCH', `/api/rides/${id}`, { place: 'x' }).status, 403);
  assert.equal(ann('PATCH', `/api/rides/${id}`, { seats: 0 }).status, 400);
  assert.equal(ann('PATCH', `/api/rides/${id}`, { time: '99:00' }).status, 400);
  assert.equal(ann('PATCH', `/api/rides/${id}`, { place: 'Gate 2', time: '15:15' }).status, 200);
  assert.match(unread(bob)[0], /ann changed a ride: .* is now Pickup on 2030-05-08 at 15:15 \(Gate 2\)/);
  // hand off to cat, who is notified; non-members are rejected
  assert.equal(ann('PATCH', `/api/rides/${id}`, { driver_id: 999 }).status, 403);
  assert.equal(ann('PATCH', `/api/rides/${id}`, { driver_id: cat('GET', '/api/me').body.user.id }).status, 200);
  assert.match(unread(cat)[0], /ann asked you to drive/);
  assert.equal(bob('GET', `/api/pools/${pool.id}`).body.rides[0].driver_name, 'cat');
  // unassign -> pool is told a driver is needed
  assert.equal(cat('PATCH', `/api/rides/${id}`, { driver_id: null }).status, 200);
  assert.match(unread(bob)[0], /needs a driver/);
});

test('tracking: start, location privacy, kid states, complete', () => {
  const { ann, bob, cat, kid, pool, clock } = world();
  const id = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: today(clock), time: '08:00', place: 'School', drive: true }).body.ids[0];
  const future = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: '2030-05-20', time: '08:00', place: 'School', drive: true }).body.ids[0];
  bob('POST', `/api/rides/${id}/riders`, { kid_id: kid });
  assert.equal(bob('POST', `/api/rides/${id}/start`).status, 403);        // not the driver
  assert.equal(ann('POST', `/api/rides/${future}/start`).status, 400);    // wrong day
  assert.equal(ann('POST', `/api/rides/${id}/location`, { lat: 1, lng: 1 }).status, 400); // not started
  assert.equal(ann('POST', `/api/rides/${id}/start`).status, 200);
  assert.match(unread(bob)[0], /ann is on the way/);
  assert.equal(bob('POST', `/api/rides/${id}/riders`, { kid_id: kid }).status, 200); // idempotent
  assert.equal(ann('POST', `/api/rides/${id}/location`, { lat: 95, lng: 1 }).status, 400);
  assert.equal(ann('POST', `/api/rides/${id}/location`, { lat: -33.86, lng: 151.2 }).status, 200);

  const loc = (u) => u('GET', `/api/pools/${pool.id}`).body.rides.find((r) => r.id === id).location;
  assert.deepEqual({ lat: loc(bob).lat, lng: loc(bob).lng }, { lat: -33.86, lng: 151.2 }); // parent of rider sees it
  assert.ok(loc(ann));
  assert.equal(loc(cat), null); // other pool member does not

  assert.equal(ann('POST', `/api/rides/${id}/riders/${kid}/state`, { state: 'onboard' }).status, 200);
  assert.match(unread(bob)[0], /Max is in the car/);
  assert.equal(ann('POST', `/api/rides/${id}/riders/${kid}/state`, { state: 'done' }).status, 200);
  assert.match(unread(bob)[0], /Max has arrived safely/);
  assert.equal(ann('PATCH', `/api/rides/${id}`, { place: 'x' }).status, 400); // can't edit mid-ride

  assert.equal(ann('POST', `/api/rides/${id}/complete`).status, 200);
  assert.equal(loc(bob), null); // location discarded
  assert.equal(bob('GET', `/api/pools/${pool.id}`).body.rides.find((r) => r.id === id).status, 'completed');
});

test('reminders: driver + riders 60 min before, unclaimed alert 24h before, once only', async () => {
  const { ann, bob, cat, kid, pool, clock, h } = world();
  const driven = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: '2030-05-06', time: '13:00', place: 'S', drive: true }).body.ids[0];
  bob('POST', `/api/rides/${driven}/riders`, { kid_id: kid });
  ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: '2030-05-07', time: '09:00', place: 'S' });
  h.runReminders(clock.t);
  assert.ok(unread(bob).some((t) => /Reminder: .* leaves in about 60 min/.test(t)));
  assert.ok(unread(cat).some((t) => /Still no driver/.test(t)));
  const n = unread(bob).length;
  h.runReminders(clock.t + 60_000);
  assert.equal(unread(bob).length, n);
});

test('password reset flow', async () => {
  const { h, signup, mails, clock } = setup();
  const ann = signup('ann');
  assert.equal(h('POST', '/api/password/forgot', { email: 'nobody@x.com' }).status, 200); // same answer
  await flush(); assert.equal(mails.length, 0);
  assert.equal(h('POST', '/api/password/forgot', { email: 'ann@x.com' }).status, 200);
  await flush();
  const token = /#reset=([a-f0-9]+)/.exec(mails[0].text)[1];
  assert.equal(h('POST', '/api/password/reset', { token: 'nope', password: 'newpassword1' }).status, 400);
  assert.equal(h('POST', '/api/password/reset', { token, password: 'short' }).status, 400);
  const ok = h('POST', '/api/password/reset', { token, password: 'newpassword1' });
  assert.equal(ok.status, 200);
  assert.equal(ann('GET', '/api/me').status, 401); // old sessions revoked
  assert.equal(h('POST', '/api/login', { email: 'ann@x.com', password: 'password1' }).status, 401);
  assert.equal(h('POST', '/api/login', { email: 'ann@x.com', password: 'newpassword1' }).status, 200);
  assert.equal(h('POST', '/api/password/reset', { token, password: 'another-pass1' }).status, 400); // single use

  h('POST', '/api/password/forgot', { email: 'ann@x.com' }); await flush();
  const t2 = /#reset=([a-f0-9]+)/.exec(mails.at(-1).text)[1];
  clock.t += 61 * 60e3;
  assert.equal(h('POST', '/api/password/reset', { token: t2, password: 'newpassword2' }).status, 400); // expired
});

test('rate limiting and session expiry', () => {
  const { h, signup, clock } = setup();
  const ann = signup('ann');
  for (let i = 0; i < 10; i++) assert.equal(h('POST', '/api/login', { email: 'ann@x.com', password: 'bad' }).status, 401);
  assert.equal(h('POST', '/api/login', { email: 'ann@x.com', password: 'password1' }).status, 429);
  assert.equal(h('POST', '/api/login', { email: 'other@x.com', password: 'x' }, undefined, '1.2.3.4').status, 401);
  for (let i = 0; i < 30; i++) h('POST', '/api/signup', {}, undefined, '9.9.9.9');
  assert.equal(h('POST', '/api/signup', {}, undefined, '9.9.9.9').status, 429);
  assert.equal(ann('GET', '/api/me').status, 200);
  clock.t += 31 * 864e5;
  assert.equal(ann('GET', '/api/me').status, 401);
});

test('rides have a starting point and a destination', () => {
  const { ann, bob, kid, pool } = world();
  const id = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: '2030-05-08', time: '08:00', place: '12 Oak St', dest: 'Maple Elementary', drive: true }).body.ids[0];
  const ride = bob('GET', `/api/pools/${pool.id}`).body.rides[0];
  assert.equal(ride.place, '12 Oak St'); assert.equal(ride.dest, 'Maple Elementary');
  assert.match(unread(bob)[0], /\(12 Oak St → Maple Elementary\)/);
  bob('POST', `/api/rides/${id}/riders`, { kid_id: kid });
  assert.equal(ann('PATCH', `/api/rides/${id}`, { dest: 'Gate 2' }).status, 200);
  assert.match(unread(bob)[0], /is now .*\(12 Oak St → Gate 2\)/);
});

test('ride request: book my kid on creation, others are asked for a driver, accepting notifies me', () => {
  const { ann, bob, cat, kid, pool } = world();
  const r = bob('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: '2030-05-08', time: '16:30', place: 'Galuwa Recreation Centre', dest: '5 Home St', kid_ids: [kid] });
  assert.equal(r.status, 200);
  assert.match(unread(ann)[0], /bob needs a driver for Max: .*16:30 \(Galuwa Recreation Centre → 5 Home St\)/);
  const ride = ann('GET', `/api/pools/${pool.id}`).body.rides[0];
  assert.deepEqual(ride.riders.map((k) => k.name), ['Max']); assert.equal(ride.driver_id, null);
  assert.equal(ann('POST', `/api/rides/${ride.id}/drive`).status, 200);
  assert.match(unread(bob)[0], /ann will drive/);
  assert.equal(bob('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: '2030-05-08', time: '16:30', place: 'x', dest: 'y', kid_ids: [999] }).status, 400);
  assert.equal(cat('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: '2030-05-08', time: '16:30', place: 'x', kid_ids: [kid] }).status, 400); // not her child
});
