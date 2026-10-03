# Carpool

A simple app for parents to coordinate school drop-offs and pickups.

## Features
- **Pools**: a group (class, team, street) joined with an invite code; parents add their kids
- **Rides**: post drop-offs/pickups, optionally repeating weekly. Volunteer to drive or book your child (seat limits enforced)
- **Edit & hand off**: the creator or driver can change date/time/place/seats or reassign the driver; a driver who can't make it releases the ride and the pool is told it needs a driver
- **Notifications** (in-app bell, optional email, optional browser alerts): new rides, driver found/cancelled, rides changed or cancelled, kids added/removed, ride started, kid picked up/arrived, plus reminders (1 hour before a driven ride; 24 hours before a ride with no driver)
- **Live tracking**: on the day, the driver taps *Start ride* and shares GPS; parents of kids on that ride see a live map. The driver marks each child *picked up* / *arrived* and the parent is alerted. Location is visible only to the driver and those parents, and is deleted when the ride finishes
- **Accounts**: password reset by email, scrypt password hashes, 30-day sessions

## Run
Requires Node 22.5+ (built-in `node:sqlite`; no npm install).

    npm start        # http://localhost:3000
    npm test

| Env var | Purpose |
|---|---|
| `PORT`, `DB_PATH` | listen port (3000) and SQLite file (`carpool.db`) |
| `BASE_URL` | public URL used in emailed links (e.g. `https://carpool.example.com`) |
| `MAIL_WEBHOOK`, `MAIL_FROM` | POST target for outgoing email `{from,to,subject,text}`. Unset = mail is only logged (dev). Point it at a small relay in front of SES/SendGrid/SMTP |
| `TLS_CERT`, `TLS_KEY` | serve HTTPS directly |
| `TRUST_PROXY=1` | behind a TLS-terminating proxy: trust `X-Forwarded-Proto/For` (Secure cookies, HSTS, per-IP limits) |

## Deploying
Browsers only allow location sharing over **HTTPS**, so deploy behind TLS. Easiest: run behind Caddy/nginx or a PaaS
with `TRUST_PROXY=1` and `BASE_URL=https://…`; or set `TLS_CERT`/`TLS_KEY`. Keep a single process (rate limits and the
reminder timer are in-memory/per-process) and back up the SQLite file.

## Security notes
HttpOnly + SameSite cookies (Secure over HTTPS), CSP and other security headers, JSON-only API with origin check (CSRF),
rate limits on login/signup/reset/join, single-use expiring reset tokens that sign out all sessions.

## Known limits
- Alerts reach a phone only while the app is open (in-app/browser notifications) or by email. True background push
  needs Web Push (service worker + VAPID keys) or a native app.
- Tracking only transmits while the driver's screen stays on with the page open (a wake lock is requested).
- The map is an OpenStreetMap embed.
