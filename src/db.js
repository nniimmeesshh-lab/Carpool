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
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
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
  return db;
}
