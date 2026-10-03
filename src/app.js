import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { rideStart, todayIn, validTz } from './time.js';
import { createLimiter } from './ratelimit.js';
import { isAllowedEndpoint, validKeys } from './push.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const tooMany = () => new HttpError(429, 'Too many attempts, please try again later');

const SESSION_MS = 30 * 864e5;
const RESET_MS = 60 * 6e4;
const MIN = 60e3;

const hashPw = (pw) => {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
};
const checkPw = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
};
const sha = (s) => createHash('sha256').update(s).digest('hex');

const str = (v, name, max = 100) => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v.trim();
};
const parseDate = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad('Date must be YYYY-MM-DD');
  return v;
};
const parseTime = (v) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v ?? '')) throw bad('Time must be HH:MM');
  return v;
};
const parseSeats = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw bad('Seats must be 1-12');
  return n;
};
const checkPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
  if (pw.length > 200) throw bad('Password is too long');
};

/**
 * @param db        node:sqlite database from openDb()
 * @param opts.mailer   {send({to,subject,text})} – email transport (see mail.js)
 * @param opts.push     pusher from push.js (omit to disable Web Push)
 * @param opts.baseUrl  public URL used in emailed links
 * @param opts.now      clock, for tests
 */
export function createApp(db, { mailer = { send() {} }, push = null, baseUrl = 'http://localhost:3000', now = Date.now } = {}) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const limiter = createLimiter(now);

  const requireMember = (poolId, userId) => {
    if (!one('SELECT 1 x FROM members WHERE pool_id=? AND user_id=?', poolId, userId))
      throw forbidden('You are not in this pool');
  };
  const getRide = (id, userId) => {
    const ride = one('SELECT * FROM rides WHERE id=?', id);
    if (!ride) throw notFound('Ride not found');
    requireMember(ride.pool_id, userId);
    return ride;
  };
  const poolTz = (poolId) => one('SELECT tz FROM pools WHERE id=?', poolId).tz;
  const memberIds = (poolId) => all('SELECT user_id FROM members WHERE pool_id=?', poolId).map((r) => r.user_id);
  const riderParentIds = (rideId) => all('SELECT DISTINCT k.parent_id FROM riders x JOIN kids k ON k.id=x.kid_id WHERE x.ride_id=?', rideId).map((r) => r.parent_id);
  const describe = (r) => `${r.kind === 'dropoff' ? 'Drop-off' : 'Pickup'} on ${r.date} at ${r.time} (${r.place}${r.dest ? ` → ${r.dest}` : ''})`;

  // ---- notifications: in-app row for everyone, plus email unless the user opted out ----
  const sendPush = (userId, payload) => {
    for (const sub of all('SELECT * FROM push_subs WHERE user_id=?', userId)) {
      Promise.resolve().then(() => push.send(sub, payload))
        .then((r) => { if (r.gone) run('DELETE FROM push_subs WHERE endpoint=?', sub.endpoint); })
        .catch((e) => console.error('push failed:', e.message));
    }
  };
  const notify = (userIds, n, actorId) => {
    for (const id of new Set(userIds)) {
      if (!id || id === actorId) continue;
      const { lastInsertRowid: lastId } = run('INSERT INTO notifications (user_id,type,text,pool_id,ride_id,created_at) VALUES (?,?,?,?,?,?)',
        id, n.type, n.text, n.pool_id ?? null, n.ride_id ?? null, now());
      const nid = Number(lastId);
      if (push) sendPush(id, { title: 'Carpool', body: n.text.slice(0, 200), tag: n.ride_id ? `ride-${n.ride_id}` : `n-${nid}`, url: '/' });
      const u = one('SELECT email, email_notifs FROM users WHERE id=?', id);
      if (u?.email_notifs) {
        Promise.resolve().then(() => mailer.send({ to: u.email, subject: n.text.slice(0, 100), text: `${n.text}\n\nOpen Carpool: ${baseUrl}` }))
          .catch((e) => console.error('mail failed:', e.message));
      }
    }
  };

  const newSession = (userId) => {
    const token = randomBytes(24).toString('hex');
    run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, userId, now());
    run('DELETE FROM sessions WHERE created_at < ?', now() - SESSION_MS);
    return token;
  };
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, email_notifs: !!u.email_notifs });

  const ridesFor = (poolId, userId) => {
    const today = todayIn(poolTz(poolId), now());
    const rides = all(
      `SELECT r.*, u.name AS driver_name FROM rides r LEFT JOIN users u ON u.id=r.driver_id
       WHERE r.pool_id=? AND r.date>=? ORDER BY r.date, r.time, r.id`, poolId, today);
    for (const r of rides) {
      r.riders = all(
        `SELECT k.id, k.name, k.parent_id, p.name AS parent_name, x.state FROM riders x
         JOIN kids k ON k.id=x.kid_id JOIN users p ON p.id=k.parent_id WHERE x.ride_id=? ORDER BY k.name`, r.id);
      r.seats_left = r.seats - r.riders.length;
      r.mine_driving = r.driver_id === userId;
      // Live location is private to the driver and the parents of kids on this ride.
      const mayTrack = r.mine_driving || r.riders.some((k) => k.parent_id === userId);
      r.location = mayTrack && r.status === 'en_route' && r.lat != null ? { lat: r.lat, lng: r.lng, at: r.loc_at } : null;
      delete r.lat; delete r.lng; delete r.loc_at; delete r.reminded;
    }
    return rides;
  };

  const poolDetail = (pool, userId) => {
    const members = all(
      `SELECT u.id, u.name, u.phone,
         (SELECT COUNT(*) FROM rides r WHERE r.pool_id=? AND r.driver_id=u.id) AS drives
       FROM members m JOIN users u ON u.id=m.user_id WHERE m.pool_id=? ORDER BY u.name`, pool.id, pool.id);
    const kids = all(
      `SELECT k.id, k.name, k.parent_id FROM kids k JOIN members m ON m.user_id=k.parent_id
       WHERE m.pool_id=? ORDER BY k.name`, pool.id);
    return { id: pool.id, name: pool.name, code: pool.code, tz: pool.tz, members, kids, rides: ridesFor(pool.id, userId) };
  };

  // ---- routes ----
  const routes = [];
  const route = (method, path, auth, fn, limit) => {
    const re = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, auth, fn, limit, path });
  };
  const AUTH_LIMIT = { max: 30, win: 15 * MIN }; // per IP

  route('POST', '/api/signup', false, ({ body, ctx }) => {
    const name = str(body.name, 'Name'), email = str(body.email, 'Email', 200).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Email looks invalid');
    checkPassword(body.password);
    if (one('SELECT 1 x FROM users WHERE email=?', email)) throw bad('Email already registered');
    const phone = body.phone ? str(body.phone, 'Phone', 30) : null;
    const { lastInsertRowid } = run('INSERT INTO users (name,email,phone,pw_hash) VALUES (?,?,?,?)', name, email, phone, hashPw(body.password));
    ctx.token = newSession(Number(lastInsertRowid));
    return { user: publicUser(one('SELECT * FROM users WHERE id=?', lastInsertRowid)) };
  }, AUTH_LIMIT);

  route('POST', '/api/login', false, ({ body, ctx }) => {
    const email = String(body.email ?? '').toLowerCase().slice(0, 200);
    if (!limiter.hit('login:' + email, 10, 15 * MIN)) throw tooMany(); // slows password guessing on one account
    const u = one('SELECT * FROM users WHERE email=?', email);
    if (!u || !checkPw(String(body.password ?? '').slice(0, 200), u.pw_hash)) throw new HttpError(401, 'Wrong email or password');
    ctx.token = newSession(u.id);
    return { user: publicUser(u) };
  }, AUTH_LIMIT);

  route('POST', '/api/logout', true, ({ ctx }) => {
    run('DELETE FROM sessions WHERE token=?', ctx.currentToken);
    ctx.token = '';
    return { ok: true };
  });

  // Always answers the same way so it can't be used to discover which emails have accounts.
  route('POST', '/api/password/forgot', false, ({ body }) => {
    const email = String(body.email ?? '').toLowerCase().slice(0, 200);
    if (!limiter.hit('forgot:' + email, 3, 60 * MIN)) throw tooMany();
    const u = one('SELECT * FROM users WHERE email=?', email);
    if (u) {
      const token = randomBytes(32).toString('hex');
      run('DELETE FROM password_resets WHERE user_id=?', u.id);
      run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)', sha(token), u.id, now() + RESET_MS);
      Promise.resolve().then(() => mailer.send({
        to: u.email, subject: 'Reset your Carpool password',
        text: `Use this link within one hour to choose a new password:\n${baseUrl}/#reset=${token}\n\nIf you didn't ask for this, ignore this email.`,
      })).catch((e) => console.error('mail failed:', e.message));
    }
    return { ok: true };
  }, AUTH_LIMIT);

  route('POST', '/api/password/reset', false, ({ body, ctx }) => {
    checkPassword(body.password);
    const row = one('SELECT * FROM password_resets WHERE token_hash=?', sha(String(body.token ?? '')));
    if (!row || row.expires_at < now()) throw bad('This reset link is invalid or has expired');
    run('UPDATE users SET pw_hash=? WHERE id=?', hashPw(body.password), row.user_id);
    run('DELETE FROM password_resets WHERE user_id=?', row.user_id);
    run('DELETE FROM sessions WHERE user_id=?', row.user_id); // sign out everywhere
    ctx.token = newSession(row.user_id);
    return { user: publicUser(one('SELECT * FROM users WHERE id=?', row.user_id)) };
  }, AUTH_LIMIT);

  route('GET', '/api/me', true, ({ user }) => ({
    user: publicUser(user),
    kids: all('SELECT id, name FROM kids WHERE parent_id=? ORDER BY name', user.id),
    pools: all('SELECT p.id, p.name FROM pools p JOIN members m ON m.pool_id=p.id WHERE m.user_id=? ORDER BY p.name', user.id),
    unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', user.id).n,
  }));
  route('PATCH', '/api/me', true, ({ user, body }) => {
    if ('email_notifs' in body) run('UPDATE users SET email_notifs=? WHERE id=?', body.email_notifs ? 1 : 0, user.id);
    if ('phone' in body) run('UPDATE users SET phone=? WHERE id=?', body.phone ? str(body.phone, 'Phone', 30) : null, user.id);
    return { user: publicUser(one('SELECT * FROM users WHERE id=?', user.id)) };
  });

  route('GET', '/api/notifications', true, ({ user }) => ({
    items: all('SELECT id,type,text,pool_id,ride_id,created_at,read FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', user.id),
    unread: one('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', user.id).n,
  }));
  route('POST', '/api/notifications/read', true, ({ user }) => {
    run('UPDATE notifications SET read=1 WHERE user_id=?', user.id);
    return { ok: true };
  });

  // ---- Web Push subscriptions (one per browser/device) ----
  route('GET', '/api/push/key', true, () => ({ key: push?.publicKey ?? null }));
  route('POST', '/api/push/subscribe', true, ({ user, body }) => {
    if (!push) throw bad('Push notifications are not enabled on this server');
    if (!isAllowedEndpoint(body.endpoint)) throw bad('Unsupported push service');
    if (!validKeys(body.keys)) throw bad('Invalid push keys');
    // endpoint is unique per browser profile: re-subscribing after a different user logs in re-attaches it
    run(`INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`,
      body.endpoint, user.id, body.keys.p256dh, body.keys.auth, now());
    run('DELETE FROM push_subs WHERE user_id=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id=? ORDER BY created_at DESC LIMIT 10)', user.id, user.id);
    return { ok: true };
  });
  route('POST', '/api/push/unsubscribe', true, ({ user, body }) => {
    run('DELETE FROM push_subs WHERE endpoint=? AND user_id=?', String(body.endpoint ?? ''), user.id);
    return { ok: true };
  });

  route('POST', '/api/kids', true, ({ user, body }) => {
    const { lastInsertRowid } = run('INSERT INTO kids (name,parent_id) VALUES (?,?)', str(body.name, 'Child name', 50), user.id);
    return { id: Number(lastInsertRowid) };
  });
  route('DELETE', '/api/kids/:id', true, ({ user, params }) => {
    run('DELETE FROM kids WHERE id=? AND parent_id=?', params.id, user.id);
    return { ok: true };
  });

  route('POST', '/api/pools', true, ({ user, body }) => {
    const name = str(body.name, 'Pool name', 60);
    const tz = body.tz == null ? 'UTC' : body.tz;
    if (!validTz(tz)) throw bad('Unknown timezone');
    const code = randomBytes(4).toString('hex').toUpperCase();
    const { lastInsertRowid } = run('INSERT INTO pools (name, code, tz) VALUES (?,?,?)', name, code, tz);
    run('INSERT INTO members (pool_id, user_id) VALUES (?,?)', lastInsertRowid, user.id);
    return { id: Number(lastInsertRowid), code };
  });
  route('POST', '/api/pools/join', true, ({ user, body }) => {
    if (!limiter.hit('join:' + user.id, 20, 15 * MIN)) throw tooMany(); // invite codes shouldn't be guessable by brute force
    const pool = one('SELECT * FROM pools WHERE code=?', String(body.code ?? '').trim().toUpperCase());
    if (!pool) throw notFound('No pool with that invite code');
    run('INSERT OR IGNORE INTO members (pool_id, user_id) VALUES (?,?)', pool.id, user.id);
    return { id: pool.id };
  });
  route('GET', '/api/pools/:id', true, ({ user, params }) => {
    const pool = one('SELECT * FROM pools WHERE id=?', params.id);
    if (!pool) throw notFound('Pool not found');
    requireMember(pool.id, user.id);
    return poolDetail(pool, user.id);
  });
  route('DELETE', '/api/pools/:id/membership', true, ({ user, params }) => {
    requireMember(params.id, user.id);
    const tz = poolTz(params.id);
    const today = todayIn(tz, now());
    const dropped = all(`SELECT * FROM rides WHERE pool_id=? AND driver_id=? AND date>=? AND status='scheduled'`, params.id, user.id, today);
    run(`UPDATE rides SET driver_id=NULL WHERE pool_id=? AND driver_id=? AND date>=? AND status='scheduled'`, params.id, user.id, today);
    run('DELETE FROM riders WHERE kid_id IN (SELECT id FROM kids WHERE parent_id=?) AND ride_id IN (SELECT id FROM rides WHERE pool_id=?)', user.id, params.id);
    run('DELETE FROM members WHERE pool_id=? AND user_id=?', params.id, user.id);
    for (const r of dropped)
      notify(memberIds(params.id), { type: 'needs_driver', text: `${user.name} left the pool – ${describe(r)} needs a driver`, pool_id: r.pool_id, ride_id: r.id }, user.id);
    return { ok: true };
  });

  route('POST', '/api/pools/:id/rides', true, ({ user, params, body }) => {
    requireMember(params.id, user.id);
    if (!['dropoff', 'pickup'].includes(body.kind)) throw bad('kind must be dropoff or pickup');
    const date = parseDate(body.date), time = parseTime(body.time);
    const place = str(body.place, 'Starting point', 120);
    const dest = body.dest ? str(body.dest, 'Destination', 120) : '';
    const seats = parseSeats(body.seats ?? 4);
    const weeks = Number(body.repeat_weeks ?? 1);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) throw bad('Repeat must be 1-26 weeks');
    const driver = body.drive ? user.id : null;
    // Parents can book their own kids onto the new rides straight away (used for "I need someone to take my child").
    const kidIds = Array.isArray(body.kid_ids) ? [...new Set(body.kid_ids.map(Number))] : [];
    const kids = kidIds.map((id) => one('SELECT * FROM kids WHERE id=? AND parent_id=?', id, user.id));
    if (kids.some((k) => !k)) throw bad('That is not your child');
    if (kids.length > seats) throw bad('Not enough seats for all of those kids');
    const ids = [];
    for (let i = 0; i < weeks; i++) {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7 * i);
      const { lastInsertRowid } = run(
        'INSERT INTO rides (pool_id,kind,date,time,place,dest,seats,driver_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
        params.id, body.kind, d.toISOString().slice(0, 10), time, place, dest, seats, driver, user.id);
      ids.push(Number(lastInsertRowid));
      for (const k of kids) run('INSERT INTO riders (ride_id, kid_id) VALUES (?,?)', lastInsertRowid, k.id);
    }
    const first = { kind: body.kind, date, time, place, dest };
    notify(memberIds(params.id), {
      type: driver ? 'ride_new' : 'needs_driver', pool_id: Number(params.id), ride_id: ids[0],
      text: !driver && kids.length
        ? `${user.name} needs a driver for ${kids.map((k) => k.name).join(' & ')}: ${weeks > 1 ? `${weeks} weekly rides starting ` : ''}${describe(first)}`
        : `${user.name} added ${weeks > 1 ? `${weeks} weekly rides starting ` : ''}${describe(first)} – ${driver ? 'seats available' : 'needs a driver'}`,
    }, user.id);
    return { ids };
  });

  route('PATCH', '/api/rides/:id', true, ({ user, params, body }) => {
    const ride = getRide(params.id, user.id);
    if (ride.created_by !== user.id && ride.driver_id !== user.id) throw forbidden('Only the creator or the driver can edit a ride');
    if (ride.status !== 'scheduled') throw bad('This ride has already started');
    const next = {
      date: 'date' in body ? parseDate(body.date) : ride.date,
      time: 'time' in body ? parseTime(body.time) : ride.time,
      place: 'place' in body ? str(body.place, 'Starting point', 120) : ride.place,
      dest: 'dest' in body ? (body.dest ? str(body.dest, 'Destination', 120) : '') : ride.dest,
      seats: 'seats' in body ? parseSeats(body.seats) : ride.seats,
      driver_id: ride.driver_id,
    };
    const riders = riderParentIds(ride.id);
    const rideKids = one('SELECT COUNT(*) n FROM riders WHERE ride_id=?', ride.id).n;
    if (next.seats < rideKids) throw bad(`${rideKids} kids are already booked – can't go below that`);
    if ('driver_id' in body) {
      if (body.driver_id === null) next.driver_id = null;
      else {
        const id = Number(body.driver_id);
        requireMember(ride.pool_id, id); // throws if not a member (also covers non-integers)
        next.driver_id = id;
      }
    }
    const changed = ['date', 'time', 'place', 'dest', 'seats'].filter((f) => next[f] !== ride[f]);
    const driverChanged = next.driver_id !== ride.driver_id;
    if (!changed.length && !driverChanged) return { ok: true };
    const reminded = changed.some((f) => f !== 'seats') ? 0 : ride.reminded;
    run('UPDATE rides SET date=?, time=?, place=?, dest=?, seats=?, driver_id=?, reminded=? WHERE id=?',
      next.date, next.time, next.place, next.dest, next.seats, next.driver_id, reminded, ride.id);
    const after = { ...ride, ...next };
    const base = { pool_id: ride.pool_id, ride_id: ride.id };
    if (changed.some((f) => f !== 'seats'))
      notify([ride.created_by, ride.driver_id, next.driver_id, ...riders], { ...base, type: 'ride_changed', text: `${user.name} changed a ride: ${describe(ride)} is now ${describe(after)}` }, user.id);
    if (driverChanged) {
      if (next.driver_id) notify([next.driver_id], { ...base, type: 'assigned', text: `${user.name} asked you to drive ${describe(after)}` }, user.id);
      else notify(memberIds(ride.pool_id), { ...base, type: 'needs_driver', text: `${describe(after)} needs a driver` }, user.id);
      if (ride.driver_id) notify([ride.driver_id], { ...base, type: 'ride_changed', text: `You are no longer driving ${describe(after)}` }, user.id);
    }
    return { ok: true };
  });

  route('DELETE', '/api/rides/:id', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (ride.created_by !== user.id) throw forbidden('Only the creator can delete a ride');
    notify([ride.driver_id, ...riderParentIds(ride.id)], { type: 'ride_cancelled', pool_id: ride.pool_id, text: `${user.name} cancelled ${describe(ride)}` }, user.id);
    run('DELETE FROM rides WHERE id=?', ride.id);
    return { ok: true };
  });

  route('POST', '/api/rides/:id/drive', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (ride.status !== 'scheduled') throw bad('This ride has already started');
    if (ride.driver_id && ride.driver_id !== user.id) throw bad('Someone else is already driving');
    run('UPDATE rides SET driver_id=? WHERE id=?', user.id, ride.id);
    notify([ride.created_by, ...riderParentIds(ride.id)], { type: 'driver_found', pool_id: ride.pool_id, ride_id: ride.id, text: `${user.name} will drive ${describe(ride)}` }, user.id);
    return { ok: true };
  });
  route('DELETE', '/api/rides/:id/drive', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (ride.driver_id !== user.id) throw forbidden('You are not the driver');
    if (ride.status !== 'scheduled') throw bad('This ride has already started');
    run('UPDATE rides SET driver_id=NULL, reminded=reminded & ~1 WHERE id=?', ride.id);
    notify(memberIds(ride.pool_id), { type: 'needs_driver', pool_id: ride.pool_id, ride_id: ride.id, text: `${user.name} can no longer drive ${describe(ride)} – it needs a driver` }, user.id);
    return { ok: true };
  });

  route('POST', '/api/rides/:id/riders', true, ({ user, params, body }) => {
    const ride = getRide(params.id, user.id);
    const kid = one('SELECT * FROM kids WHERE id=? AND parent_id=?', body.kid_id, user.id);
    if (!kid) throw bad('That is not your child');
    if (one('SELECT 1 x FROM riders WHERE ride_id=? AND kid_id=?', ride.id, kid.id)) return { ok: true };
    if (ride.status !== 'scheduled') throw bad('This ride has already started');
    if (one('SELECT COUNT(*) n FROM riders WHERE ride_id=?', ride.id).n >= ride.seats) throw bad('No seats left');
    run('INSERT INTO riders (ride_id, kid_id) VALUES (?,?)', ride.id, kid.id);
    notify([ride.driver_id], { type: 'rider_added', pool_id: ride.pool_id, ride_id: ride.id, text: `${kid.name} was added to ${describe(ride)}` }, user.id);
    return { ok: true };
  });
  route('DELETE', '/api/rides/:id/riders/:kid', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    const kid = one('SELECT * FROM kids WHERE id=? AND parent_id=?', params.kid, user.id);
    if (!kid) throw forbidden('That is not your child');
    if (ride.status !== 'scheduled') throw bad('This ride has already started');
    if (run('DELETE FROM riders WHERE ride_id=? AND kid_id=?', ride.id, kid.id).changes)
      notify([ride.driver_id], { type: 'rider_removed', pool_id: ride.pool_id, ride_id: ride.id, text: `${kid.name} was removed from ${describe(ride)}` }, user.id);
    return { ok: true };
  });

  // ---- live ride tracking ----
  const requireDriver = (ride, user) => { if (ride.driver_id !== user.id) throw forbidden('Only the driver can do that'); };

  route('POST', '/api/rides/:id/start', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    requireDriver(ride, user);
    if (ride.status !== 'scheduled') throw bad('Ride already started');
    if (ride.date !== todayIn(poolTz(ride.pool_id), now())) throw bad('You can only start a ride on the day it is scheduled');
    run(`UPDATE rides SET status='en_route', lat=NULL, lng=NULL, loc_at=NULL WHERE id=?`, ride.id);
    notify(riderParentIds(ride.id), { type: 'ride_started', pool_id: ride.pool_id, ride_id: ride.id, text: `${user.name} is on the way: ${describe(ride)}` }, user.id);
    return { ok: true };
  });
  route('POST', '/api/rides/:id/location', true, ({ user, params, body }) => {
    const ride = getRide(params.id, user.id);
    requireDriver(ride, user);
    if (ride.status !== 'en_route') throw bad('Ride is not in progress');
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Invalid location');
    run('UPDATE rides SET lat=?, lng=?, loc_at=? WHERE id=?', lat, lng, now(), ride.id);
    return { ok: true };
  });
  route('POST', '/api/rides/:id/riders/:kid/state', true, ({ user, params, body }) => {
    const ride = getRide(params.id, user.id);
    requireDriver(ride, user);
    if (ride.status !== 'en_route') throw bad('Ride is not in progress');
    if (!['waiting', 'onboard', 'done'].includes(body.state)) throw bad('Invalid state');
    const kid = one('SELECT k.* FROM riders x JOIN kids k ON k.id=x.kid_id WHERE x.ride_id=? AND k.id=?', ride.id, params.kid);
    if (!kid) throw notFound('That child is not on this ride');
    run('UPDATE riders SET state=? WHERE ride_id=? AND kid_id=?', body.state, ride.id, kid.id);
    const text = { onboard: `${kid.name} is in the car`, done: `${kid.name} has arrived safely`, waiting: null }[body.state];
    if (text) notify([kid.parent_id], { type: 'kid_' + body.state, pool_id: ride.pool_id, ride_id: ride.id, text: `${text} (${describe(ride)})` }, user.id);
    return { ok: true };
  });
  route('POST', '/api/rides/:id/complete', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    requireDriver(ride, user);
    if (ride.status !== 'en_route') throw bad('Ride is not in progress');
    run(`UPDATE rides SET status='completed', lat=NULL, lng=NULL, loc_at=NULL WHERE id=?`, ride.id); // stop retaining location
    notify(riderParentIds(ride.id), { type: 'ride_done', pool_id: ride.pool_id, ride_id: ride.id, text: `${describe(ride)} is complete` }, user.id);
    return { ok: true };
  });

  // Timed alerts; call about once a minute.
  function runReminders(t = now()) {
    const from = new Date(t - 36 * 3600e3).toISOString().slice(0, 10);
    const rides = all(`SELECT r.*, p.tz FROM rides r JOIN pools p ON p.id=r.pool_id WHERE r.status='scheduled' AND r.date>=?`, from);
    for (const r of rides) {
      const mins = (rideStart(r.date, r.time, r.tz) - t) / MIN;
      if (mins < 0) continue;
      const base = { pool_id: r.pool_id, ride_id: r.id };
      if (r.driver_id && mins <= 60 && !(r.reminded & 1)) {
        run('UPDATE rides SET reminded = reminded | 1 WHERE id=?', r.id);
        notify([r.driver_id, ...riderParentIds(r.id)], { ...base, type: 'reminder', text: `Reminder: ${describe(r)} leaves in about ${Math.max(1, Math.round(mins))} min` });
      }
      if (!r.driver_id && mins <= 24 * 60 && !(r.reminded & 2)) {
        run('UPDATE rides SET reminded = reminded | 2 WHERE id=?', r.id);
        notify(memberIds(r.pool_id), { ...base, type: 'needs_driver', text: `Still no driver for ${describe(r)}` });
      }
    }
  }

  // returns {status, body, token?}; token '' means clear the cookie
  function handle(method, path, body, token, ip = 'local') {
    try {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (!m) continue;
        if (r.limit && !limiter.hit(`${r.path}|${ip}`, r.limit.max, r.limit.win)) throw tooMany();
        const ctx = { currentToken: token };
        let user = null;
        if (r.auth) {
          user = token && one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.created_at>?', token, now() - SESSION_MS);
          if (!user) throw new HttpError(401, 'Please log in');
        }
        const result = r.fn({ user, body: body ?? {}, params: m.groups ?? {}, ctx });
        return { status: 200, body: result, token: ctx.token };
      }
      throw notFound();
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: 'Server error' } };
    }
  }
  handle.runReminders = runReminders;
  return handle;
}
