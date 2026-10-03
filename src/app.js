import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

const hashPw = (pw) => {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
};
const checkPw = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
};

const str = (v, name, max = 100) => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v.trim();
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createApp(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

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
  const newSession = (userId) => {
    const token = randomBytes(24).toString('hex');
    run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
    return token;
  };
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone });

  const ridesFor = (poolId, userId) => {
    const today = new Date().toISOString().slice(0, 10);
    const rides = all(
      `SELECT r.*, u.name AS driver_name FROM rides r LEFT JOIN users u ON u.id=r.driver_id
       WHERE r.pool_id=? AND r.date>=? ORDER BY r.date, r.time, r.id`, poolId, today);
    for (const r of rides) {
      r.riders = all(
        `SELECT k.id, k.name, k.parent_id, p.name AS parent_name FROM riders x
         JOIN kids k ON k.id=x.kid_id JOIN users p ON p.id=k.parent_id WHERE x.ride_id=? ORDER BY k.name`, r.id);
      r.seats_left = r.seats - r.riders.length;
      r.mine_driving = r.driver_id === userId;
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
    return { id: pool.id, name: pool.name, code: pool.code, members, kids, rides: ridesFor(pool.id, userId) };
  };

  // route table: [method, regex, handler(ctx) => result]; handler ctx: {user, body, params, setToken}
  const routes = [];
  const route = (method, path, auth, fn) => {
    const re = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, auth, fn });
  };

  route('POST', '/api/signup', false, ({ body, ctx }) => {
    const name = str(body.name, 'Name'), email = str(body.email, 'Email', 200).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('Email looks invalid');
    if (typeof body.password !== 'string' || body.password.length < 8) throw bad('Password must be at least 8 characters');
    if (one('SELECT 1 x FROM users WHERE email=?', email)) throw bad('Email already registered');
    const phone = body.phone ? str(body.phone, 'Phone', 30) : null;
    const { lastInsertRowid } = run('INSERT INTO users (name,email,phone,pw_hash) VALUES (?,?,?,?)', name, email, phone, hashPw(body.password));
    ctx.token = newSession(Number(lastInsertRowid));
    return { user: publicUser(one('SELECT * FROM users WHERE id=?', lastInsertRowid)) };
  });
  route('POST', '/api/login', false, ({ body, ctx }) => {
    const u = one('SELECT * FROM users WHERE email=?', String(body.email ?? '').toLowerCase());
    if (!u || !checkPw(String(body.password ?? ''), u.pw_hash)) throw new HttpError(401, 'Wrong email or password');
    ctx.token = newSession(u.id);
    return { user: publicUser(u) };
  });
  route('POST', '/api/logout', true, ({ ctx }) => {
    run('DELETE FROM sessions WHERE token=?', ctx.currentToken);
    return { ok: true };
  });
  route('GET', '/api/me', true, ({ user }) => ({
    user: publicUser(user),
    kids: all('SELECT id, name FROM kids WHERE parent_id=? ORDER BY name', user.id),
    pools: all('SELECT p.id, p.name FROM pools p JOIN members m ON m.pool_id=p.id WHERE m.user_id=? ORDER BY p.name', user.id),
  }));

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
    const code = randomBytes(4).toString('hex').toUpperCase();
    const { lastInsertRowid } = run('INSERT INTO pools (name, code) VALUES (?,?)', name, code);
    run('INSERT INTO members (pool_id, user_id) VALUES (?,?)', lastInsertRowid, user.id);
    return { id: Number(lastInsertRowid), code };
  });
  route('POST', '/api/pools/join', true, ({ user, body }) => {
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
    run('UPDATE rides SET driver_id=NULL WHERE pool_id=? AND driver_id=? AND date>=?', params.id, user.id, new Date().toISOString().slice(0, 10));
    run('DELETE FROM riders WHERE kid_id IN (SELECT id FROM kids WHERE parent_id=?) AND ride_id IN (SELECT id FROM rides WHERE pool_id=?)', user.id, params.id);
    run('DELETE FROM members WHERE pool_id=? AND user_id=?', params.id, user.id);
    return { ok: true };
  });

  route('POST', '/api/pools/:id/rides', true, ({ user, params, body }) => {
    requireMember(params.id, user.id);
    if (!['dropoff', 'pickup'].includes(body.kind)) throw bad('kind must be dropoff or pickup');
    if (!DATE_RE.test(body.date ?? '') || Number.isNaN(Date.parse(body.date))) throw bad('Date must be YYYY-MM-DD');
    if (!TIME_RE.test(body.time ?? '')) throw bad('Time must be HH:MM');
    const place = str(body.place, 'Place', 120);
    const seats = Number(body.seats ?? 4);
    if (!Number.isInteger(seats) || seats < 1 || seats > 12) throw bad('Seats must be 1-12');
    const weeks = Number(body.repeat_weeks ?? 1);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) throw bad('Repeat must be 1-26 weeks');
    const driver = body.drive ? user.id : null;
    const ids = [];
    for (let i = 0; i < weeks; i++) {
      const d = new Date(body.date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7 * i);
      const { lastInsertRowid } = run(
        'INSERT INTO rides (pool_id,kind,date,time,place,seats,driver_id,created_by) VALUES (?,?,?,?,?,?,?,?)',
        params.id, body.kind, d.toISOString().slice(0, 10), body.time, place, seats, driver, user.id);
      ids.push(Number(lastInsertRowid));
    }
    return { ids };
  });
  route('DELETE', '/api/rides/:id', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (ride.created_by !== user.id) throw forbidden('Only the creator can delete a ride');
    run('DELETE FROM rides WHERE id=?', ride.id);
    return { ok: true };
  });
  route('POST', '/api/rides/:id/drive', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (ride.driver_id && ride.driver_id !== user.id) throw bad('Someone else is already driving');
    run('UPDATE rides SET driver_id=? WHERE id=?', user.id, ride.id);
    return { ok: true };
  });
  route('DELETE', '/api/rides/:id/drive', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (ride.driver_id !== user.id) throw forbidden('You are not the driver');
    run('UPDATE rides SET driver_id=NULL WHERE id=?', ride.id);
    return { ok: true };
  });
  route('POST', '/api/rides/:id/riders', true, ({ user, params, body }) => {
    const ride = getRide(params.id, user.id);
    const kid = one('SELECT * FROM kids WHERE id=? AND parent_id=?', body.kid_id, user.id);
    if (!kid) throw bad('That is not your child');
    const taken = one('SELECT COUNT(*) n FROM riders WHERE ride_id=?', ride.id).n;
    if (one('SELECT 1 x FROM riders WHERE ride_id=? AND kid_id=?', ride.id, kid.id)) return { ok: true };
    if (taken >= ride.seats) throw bad('No seats left');
    run('INSERT INTO riders (ride_id, kid_id) VALUES (?,?)', ride.id, kid.id);
    return { ok: true };
  });
  route('DELETE', '/api/rides/:id/riders/:kid', true, ({ user, params }) => {
    const ride = getRide(params.id, user.id);
    if (!one('SELECT 1 x FROM kids WHERE id=? AND parent_id=?', params.kid, user.id)) throw forbidden('That is not your child');
    run('DELETE FROM riders WHERE ride_id=? AND kid_id=?', ride.id, params.kid);
    return { ok: true };
  });

  // returns {status, body, token?}
  return function handle(method, path, body, token) {
    try {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (!m) continue;
        const ctx = { currentToken: token };
        let user = null;
        if (r.auth) {
          user = token && one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', token);
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
  };
}
