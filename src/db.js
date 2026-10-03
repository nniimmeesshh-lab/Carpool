import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      phone TEXT, pw_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, text TEXT NOT NULL, pool_id INTEGER, ride_id INTEGER,
      created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, id);
    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS members (
      pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (pool_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS kids (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rides (
      id INTEGER PRIMARY KEY,
      pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('dropoff','pickup')),
      date TEXT NOT NULL, time TEXT NOT NULL, place TEXT NOT NULL,
      seats INTEGER NOT NULL DEFAULT 4,
      driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS riders (
      ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      kid_id INTEGER NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
      PRIMARY KEY (ride_id, kid_id)
    );
  `);
  // Columns added after the first release (safe to re-run on existing databases).
  const addColumn = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addColumn('users', 'email_notifs', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('pools', 'tz', "TEXT NOT NULL DEFAULT 'UTC'");
  addColumn('rides', 'status', "TEXT NOT NULL DEFAULT 'scheduled'");
  addColumn('rides', 'dest', "TEXT NOT NULL DEFAULT ''");
  addColumn('rides', 'arrived_at', 'INTEGER');
  addColumn('rides', 'lat', 'REAL');
  addColumn('rides', 'lng', 'REAL');
  addColumn('rides', 'loc_at', 'INTEGER');
  addColumn('rides', 'reminded', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('riders', 'state', "TEXT NOT NULL DEFAULT 'waiting'");
  return db;
}
