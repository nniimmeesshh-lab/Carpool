import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const setup = () => {
  const h = createApp(openDb());
  const call = (token) => (m, p, b) => h(m, p, b, token);
  const signup = (name) => {
    const r = h('POST', '/api/signup', { name, email: `${name}@x.com`, password: 'password1' });
    assert.equal(r.status, 200);
    return call(r.token);
  };
  return { h, signup };
};
const future = () => new Date(Date.now() + 864e5 * 2).toISOString().slice(0, 10);

test('auth: signup, login, bad password, protected routes', () => {
  const { h, signup } = setup();
  signup('ann');
  assert.equal(h('POST', '/api/login', { email: 'ann@x.com', password: 'nope' }).status, 401);
  assert.ok(h('POST', '/api/login', { email: 'ann@x.com', password: 'password1' }).token);
  assert.equal(h('GET', '/api/me', null, undefined).status, 401);
  assert.equal(h('POST', '/api/signup', { name: 'a', email: 'ann@x.com', password: 'password1' }).status, 400);
});

test('full carpool flow', () => {
  const { signup } = setup();
  const ann = signup('ann'), bob = signup('bob'), eve = signup('eve');
  const annKid = ann('POST', '/api/kids', { name: 'Zoe' }).body.id;
  const bobKid = bob('POST', '/api/kids', { name: 'Max' }).body.id;
  const pool = ann('POST', '/api/pools', { name: 'Room 4' }).body;
  assert.equal(eve('GET', `/api/pools/${pool.id}`).status, 403);
  assert.equal(bob('POST', '/api/pools/join', { code: pool.code.toLowerCase() }).status, 200);

  const ride = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'dropoff', date: future(), time: '08:05', place: 'Maple Elementary', seats: 1 });
  assert.equal(ride.status, 200);
  const id = ride.body.ids[0];

  assert.equal(bob('POST', `/api/rides/${id}/drive`).status, 200);
  assert.equal(ann('POST', `/api/rides/${id}/drive`).status, 400); // already taken
  assert.equal(ann('POST', `/api/rides/${id}/riders`, { kid_id: bobKid }).status, 400); // not her child
  assert.equal(ann('POST', `/api/rides/${id}/riders`, { kid_id: annKid }).status, 200);
  assert.equal(bob('POST', `/api/rides/${id}/riders`, { kid_id: bobKid }).status, 400); // full

  const detail = ann('GET', `/api/pools/${pool.id}`).body;
  assert.equal(detail.rides[0].driver_name, 'bob');
  assert.equal(detail.rides[0].seats_left, 0);
  assert.equal(detail.members.find((m) => m.name === 'bob').drives, 1);

  assert.equal(bob('DELETE', `/api/rides/${id}`).status, 403); // only creator deletes
  assert.equal(ann('DELETE', `/api/rides/${id}`).status, 200);
});

test('weekly repeat creates multiple rides and validates input', () => {
  const { signup } = setup();
  const ann = signup('ann');
  const pool = ann('POST', '/api/pools', { name: 'P' }).body;
  const r = ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: future(), time: '15:30', place: 'School', repeat_weeks: 3, drive: true });
  assert.equal(r.body.ids.length, 3);
  const rides = ann('GET', `/api/pools/${pool.id}`).body.rides;
  assert.equal(rides.length, 3);
  assert.ok(rides.every((x) => x.mine_driving));
  assert.equal(ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'x', date: future(), time: '15:30', place: 'S' }).status, 400);
  assert.equal(ann('POST', `/api/pools/${pool.id}/rides`, { kind: 'pickup', date: future(), time: '25:00', place: 'S' }).status, 400);
});
