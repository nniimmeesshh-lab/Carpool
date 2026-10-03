# Carpool

A simple app for parents to coordinate school drop-offs and pickups.

## Features
- **Pools**: a group (class, team, street) joined with an invite code; parents add their kids
- **Rides**: post drop-offs/pickups, optionally repeating weekly. Volunteer to drive or book your child (seat limits enforced)
- **Edit & hand off**: the creator or driver can change date/time/place/seats or reassign the driver; a driver who can't make it releases the ride and the pool is told it needs a driver
- **Notifications** (in-app bell, **Web Push to phones/desktops even when the app is closed**, optional email): new rides, driver found/cancelled, rides changed or cancelled, kids added/removed, ride started, kid picked up/arrived, plus reminders (1 hour before a driven ride; 24 hours before a ride with no driver)
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
| `VAPID_SUBJECT` | contact for push services (`mailto:you@example.com` or your https URL). Defaults to `BASE_URL` when https |
| `VAPID_PRIVATE_JWK` | optional: supply the push signing key (JSON JWK) instead of the auto-generated one stored in the DB |
| `PUSH_ALLOWED_HOSTS` | extra push-service hostname suffixes to accept (defaults: Google FCM, Mozilla, Apple, Windows) |
| `TLS_CERT`, `TLS_KEY` | serve HTTPS directly |
| `TRUST_PROXY=1` | behind a TLS-terminating proxy: trust `X-Forwarded-Proto/For` (Secure cookies, HSTS, per-IP limits) |

## Deploying
**Render (easiest, ~$7/mo):** push this repo to GitHub, then in Render choose *New + → Blueprint*, select the repo and
approve. `render.yaml` (free plan by default; see comments in it to add the persistent disk) sets up HTTPS, a persistent disk and the right env vars; Render's public URL is used in emailed links
automatically. Open the URL on your phone and share it. (Free plans have no disk, so data is lost on restart.)

**Quick test from your own computer:** `npm start`, then `cloudflared tunnel --url http://localhost:3000` for a temporary
HTTPS link (run with `TRUST_PROXY=1 BASE_URL=<that link>`). It only works while your computer is on.

**General notes:**
Browsers only allow location sharing over **HTTPS**, so deploy behind TLS. Easiest: run behind Caddy/nginx or a PaaS
with `TRUST_PROXY=1` and `BASE_URL=https://…`; or set `TLS_CERT`/`TLS_KEY`. Keep a single process (rate limits and the
reminder timer are in-memory/per-process) and back up the SQLite file.

## Security notes
HttpOnly + SameSite cookies (Secure over HTTPS), CSP and other security headers, JSON-only API with origin check (CSRF),
rate limits on login/signup/reset/join, single-use expiring reset tokens that sign out all sessions.

## Push notifications
Zero extra dependencies: payload encryption (RFC 8291) and VAPID (RFC 8292) use `node:crypto`, verified against the RFC test vector.
Parents tap the bell → **Turn on push alerts** on each device. Needs HTTPS (or localhost).
- **Keep the VAPID key**: it lives in the SQLite DB (`settings` table); if it's lost, every device must re-subscribe.
- **iPhone/iPad**: push only works for the installed app (Share → Add to Home Screen, then open it from the home screen; iOS 16.4+).
- Subscriptions are tied to a device; logging out detaches it, and logging in as someone else re-attaches it.
- Dead subscriptions (HTTP 404/410 from the push service) are removed automatically.

## Known limits
- Push delivery depends on the browser vendor's push service; it is best-effort (email remains the fallback).
- Tracking only transmits while the driver's screen stays on with the page open (a wake lock is requested).
- The map is an OpenStreetMap embed.
